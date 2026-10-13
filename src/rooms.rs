//! 房间域：房间数据结构、连接登记簿与生命周期管理。
//!
//! 每个房间有两条控制连接（收/发各一，走信令与控制消息）和若干数据槽位
//! （收/发各 SLOTS 条，按槽位号 1:1 转发二进制数据，用于并行传输）。
//! 登记簿只暴露语义化操作，WebSocket 层不接触内部数据结构。

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

use crate::state::{AppState, ClientTx, DataTx};

/// 数据槽位数量：并行传输的通道数（收发双方各开同数量连接）。
pub const SLOTS: u16 = 3;

/// 房间内连接的登记信息。
struct Room {
    sender_ctl: Option<ClientTx>,
    sender_data: HashMap<u16, DataTx>,
    receiver_ctl: Option<ClientTx>,
    receiver_data: HashMap<u16, DataTx>,
    /// 发送方最后一次广播的文件清单，接收方（含断线重连）加入时补发。
    meta: Option<Value>,
    /// 任务已被完整接收一次：之后的扫码直接提示传输已结束，不再下发文件。
    done: bool,
    last_active: Instant,
}

impl Room {
    fn new() -> Self {
        Self {
            sender_ctl: None,
            sender_data: HashMap::new(),
            receiver_ctl: None,
            receiver_data: HashMap::new(),
            meta: None,
            done: false,
            last_active: Instant::now(),
        }
    }
}

/// 控制连接登记结果。
pub struct CtlRegister {
    pub replaced_tx: Option<ClientTx>,
    /// 接收方加入时补发的文件清单（任务已结束时为 None）。
    pub meta: Option<Value>,
    /// 任务已完成（接收方扫码应直接收到结束提示）。
    pub done: bool,
}

pub enum UnregisterOutcome {
    /// 发送方控制连接注销：房间随之移除。
    /// `receiver_ctl` 需要收到关闭通知；`close_list` 为所有数据槽位（需发送 Close）。
    SenderRemoved {
        receiver_ctl: Option<ClientTx>,
        close_list: Vec<DataTx>,
    },
    /// 接收方控制连接注销：`sender_ctl` 需要收到通知；`close_list` 为接收方数据槽位。
    ReceiverRemoved {
        sender_ctl: Option<ClientTx>,
        close_list: Vec<DataTx>,
    },
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
            sender_online: room.sender_ctl.is_some(),
            meta: room.meta.clone(),
        })
    }

    /// 控制连接登记：发送方不存在则补建房间；返回被顶替的旧连接与房间状态。
    pub fn register_ctl(&self, id: &str, is_sender: bool, tx: ClientTx) -> Option<CtlRegister> {
        let mut rooms = self.0.lock().unwrap();
        let room = rooms.entry(id.to_string()).or_insert_with(Room::new);
        room.last_active = Instant::now();
        let slot = if is_sender {
            &mut room.sender_ctl
        } else {
            &mut room.receiver_ctl
        };
        let replaced_tx = slot.replace(tx);
        let (meta, done) = if is_sender {
            (None, false)
        } else {
            // 任务已结束后不再下发文件清单，扫码方直接收到结束提示
            if room.done {
                (None, true)
            } else {
                (room.meta.clone(), false)
            }
        };
        Some(CtlRegister {
            replaced_tx,
            meta,
            done,
        })
    }

    /// 标记任务已被完整接收一次；之后的扫码直接提示传输已结束。
    pub fn mark_done(&self, id: &str) {
        if let Some(room) = self.0.lock().unwrap().get_mut(id) {
            room.last_active = Instant::now();
            room.done = true;
        }
    }

    /// 数据槽位登记：房间不存在返回 false。
    pub fn register_data(&self, id: &str, is_sender: bool, slot: u16, tx: DataTx) -> bool {
        let mut rooms = self.0.lock().unwrap();
        let Some(room) = rooms.get_mut(id) else {
            return false;
        };
        room.last_active = Instant::now();
        let map = if is_sender {
            &mut room.sender_data
        } else {
            &mut room.receiver_data
        };
        map.insert(slot, tx);
        true
    }

    pub fn touch(&self, id: &str) {
        if let Some(room) = self.0.lock().unwrap().get_mut(id) {
            room.last_active = Instant::now();
        }
    }

    /// 取对端控制通道并顺带续活。
    pub fn peer_ctl_tx(&self, id: &str, from_sender: bool) -> Option<ClientTx> {
        let mut rooms = self.0.lock().unwrap();
        let room = rooms.get_mut(id)?;
        room.last_active = Instant::now();
        if from_sender {
            room.receiver_ctl.clone()
        } else {
            room.sender_ctl.clone()
        }
    }

    /// 取对端同号数据槽位并顺带续活；对端未上线时返回 None（帧丢弃）。
    pub fn peer_data_tx(&self, id: &str, from_sender: bool, slot: u16) -> Option<DataTx> {
        let mut rooms = self.0.lock().unwrap();
        let room = rooms.get_mut(id)?;
        room.last_active = Instant::now();
        let map = if from_sender {
            &room.receiver_data
        } else {
            &room.sender_data
        };
        map.get(&slot).cloned()
    }

    pub fn store_meta(&self, id: &str, meta: Value) {
        if let Some(room) = self.0.lock().unwrap().get_mut(id) {
            room.last_active = Instant::now();
            room.meta = Some(meta);
        }
    }

    /// 注销控制连接；仅当 `tx` 仍持有槽位时生效，避免误伤顶替上来的新连接。
    pub fn unregister_ctl(&self, id: &str, is_sender: bool, tx: &ClientTx) -> UnregisterOutcome {
        let mut rooms = self.0.lock().unwrap();
        let Some(room) = rooms.get_mut(id) else {
            return UnregisterOutcome::NotOwner;
        };
        let mine =
            |slot: &Option<ClientTx>| slot.as_ref().map(|t| t.same_channel(tx)).unwrap_or(false);
        if is_sender && mine(&room.sender_ctl) {
            let mut close_list: Vec<DataTx> = room.sender_data.values().cloned().collect();
            close_list.extend(room.receiver_data.values().cloned());
            let receiver_ctl = room.receiver_ctl.clone();
            rooms.remove(id);
            UnregisterOutcome::SenderRemoved {
                receiver_ctl,
                close_list,
            }
        } else if !is_sender && mine(&room.receiver_ctl) {
            room.receiver_ctl = None;
            let close_list: Vec<DataTx> = room.receiver_data.values().cloned().collect();
            room.receiver_data.clear();
            UnregisterOutcome::ReceiverRemoved {
                sender_ctl: room.sender_ctl.clone(),
                close_list,
            }
        } else {
            UnregisterOutcome::NotOwner
        }
    }

    /// 注销数据槽位（连接断开时自清理）。
    pub fn unregister_data(&self, id: &str, is_sender: bool, slot: u16, tx: &DataTx) {
        let mut rooms = self.0.lock().unwrap();
        let Some(room) = rooms.get_mut(id) else {
            return;
        };
        let map = if is_sender {
            &mut room.sender_data
        } else {
            &mut room.receiver_data
        };
        if map.get(&slot).map(|t| t.same_channel(tx)).unwrap_or(false) {
            map.remove(&slot);
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
