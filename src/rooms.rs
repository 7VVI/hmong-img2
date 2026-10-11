//! 房间域：房间数据结构、连接登记簿与生命周期管理。
//!
//! 登记簿只暴露语义化操作（登记/注销/取对端/续活/回收），
//! WebSocket 层不接触内部数据结构，保证高内聚低耦合。

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use rand::Rng;
use serde_json::{json, Value};

use crate::state::{AppState, ClientTx};

/// 房间内单个客户端连接的登记信息。
struct Room {
    sender: Option<ClientTx>,
    receiver: Option<ClientTx>,
    /// 发送方最后一次广播的文件清单，接收方（含断线重连）加入时补发。
    meta: Option<Value>,
    last_active: Instant,
}

impl Room {
    fn new() -> Self {
        Self {
            sender: None,
            receiver: None,
            meta: None,
            last_active: Instant::now(),
        }
    }
}

/// 接收方登记结果：被顶替的旧连接与房间缓存的文件清单。
pub struct ReceiverJoin {
    pub replaced_tx: Option<ClientTx>,
    pub meta: Option<Value>,
}

pub enum UnregisterOutcome {
    /// 发送方注销：房间随之移除，`receiver` 为需要通知关闭的对端。
    SenderRemoved { receiver: Option<ClientTx> },
    /// 接收方注销：`sender` 为需要通知的对端。
    ReceiverRemoved { sender: Option<ClientTx> },
    /// 槽位已被顶替或房间不存在，无需处理。
    NotOwner,
}

pub struct RoomSnapshot {
    pub sender_online: bool,
    pub meta: Option<Value>,
}

/// 房间登记簿：房间表 + 全部访问都经由互斥锁串行化。
pub struct RoomRegistry(Mutex<HashMap<String, Room>>);

impl RoomRegistry {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    /// 创建房间；达到上限时返回 None。
    pub fn create(&self, max_rooms: usize) -> Option<String> {
        let mut rooms = self.0.lock().unwrap();
        if rooms.len() >= max_rooms {
            return None;
        }
        // 去掉易混淆字符（0/O/1/I/L）的 32 字符表，8 位约 1e12 组合
        const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
        let id = loop {
            let mut rng = rand::rng();
            let id: String = (0..8)
                .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
                .collect();
            if !rooms.contains_key(&id) {
                break id;
            }
        };
        rooms.insert(id.clone(), Room::new());
        Some(id)
    }

    pub fn snapshot(&self, id: &str) -> Option<RoomSnapshot> {
        let rooms = self.0.lock().unwrap();
        rooms.get(id).map(|room| RoomSnapshot {
            sender_online: room.sender.is_some(),
            meta: room.meta.clone(),
        })
    }

    /// 发送方登记：房间不存在则补建；返回被顶替的旧连接（调用方负责关闭）。
    pub fn register_sender(&self, id: &str, tx: ClientTx) -> Option<ClientTx> {
        let mut rooms = self.0.lock().unwrap();
        let room = rooms.entry(id.to_string()).or_insert_with(Room::new);
        room.last_active = Instant::now();
        room.sender.replace(tx)
    }

    /// 接收方登记：房间不存在返回 None；顶替旧连接并带回缓存清单。
    pub fn register_receiver(&self, id: &str, tx: ClientTx) -> Option<ReceiverJoin> {
        let mut rooms = self.0.lock().unwrap();
        let room = rooms.get_mut(id)?;
        room.last_active = Instant::now();
        Some(ReceiverJoin {
            replaced_tx: room.receiver.replace(tx),
            meta: room.meta.clone(),
        })
    }

    pub fn touch(&self, id: &str) {
        if let Some(room) = self.0.lock().unwrap().get_mut(id) {
            room.last_active = Instant::now();
        }
    }

    /// 取对端出站通道并顺带续活。
    pub fn peer_tx(&self, id: &str, from_sender: bool) -> Option<ClientTx> {
        let mut rooms = self.0.lock().unwrap();
        let room = rooms.get_mut(id)?;
        room.last_active = Instant::now();
        if from_sender {
            room.receiver.clone()
        } else {
            room.sender.clone()
        }
    }

    pub fn store_meta(&self, id: &str, meta: Value) {
        if let Some(room) = self.0.lock().unwrap().get_mut(id) {
            room.last_active = Instant::now();
            room.meta = Some(meta);
        }
    }

    /// 注销连接；仅当 `tx` 仍持有槽位时生效，避免误伤顶替上来的新连接。
    pub fn unregister(&self, id: &str, is_sender: bool, tx: &ClientTx) -> UnregisterOutcome {
        let mut rooms = self.0.lock().unwrap();
        let Some(room) = rooms.get_mut(id) else {
            return UnregisterOutcome::NotOwner;
        };
        let mine =
            |slot: &Option<ClientTx>| slot.as_ref().map(|t| t.same_channel(tx)).unwrap_or(false);
        if is_sender && mine(&room.sender) {
            let receiver = room.receiver.take();
            rooms.remove(id);
            UnregisterOutcome::SenderRemoved { receiver }
        } else if !is_sender && mine(&room.receiver) {
            room.receiver = None;
            UnregisterOutcome::ReceiverRemoved {
                sender: room.sender.clone(),
            }
        } else {
            UnregisterOutcome::NotOwner
        }
    }

    /// 回收超过 TTL 无活动的房间，返回回收数量。
    pub fn retain_active(&self, ttl: Duration) -> usize {
        let mut rooms = self.0.lock().unwrap();
        let before = rooms.len();
        rooms.retain(|_, room| room.last_active.elapsed() < ttl);
        before - rooms.len()
    }
}

/// 定期回收过期房间。
pub async fn cleanup_loop(state: Arc<AppState>) {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let removed = state.rooms.retain_active(state.config.room_ttl);
        if removed > 0 {
            tracing::debug!("回收了 {removed} 个过期房间");
        }
    }
}

// ---------- 房间 API ----------

async fn create_room(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if state.auth.enabled() {
        let ok = headers
            .get("x-token")
            .and_then(|v| v.to_str().ok())
            .map(|t| state.auth.verify(t))
            .unwrap_or(false);
        if !ok {
            return (StatusCode::UNAUTHORIZED, "需要有效的访问密钥").into_response();
        }
    }
    match state.rooms.create(state.config.max_rooms) {
        Some(id) => {
            tracing::info!("创建房间 {id}");
            Json(json!({ "id": id })).into_response()
        }
        None => (StatusCode::TOO_MANY_REQUESTS, "房间数已达上限，请稍后再试").into_response(),
    }
}

async fn room_info(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    match state.rooms.snapshot(&id) {
        Some(snapshot) => Json(json!({
            "id": id,
            "senderOnline": snapshot.sender_online,
            "meta": snapshot.meta,
        }))
        .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "room not found" })),
        )
            .into_response(),
    }
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/rooms", post(create_room))
        .route("/api/rooms/{id}", get(room_info))
}
