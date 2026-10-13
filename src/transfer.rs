//! 实时传输层：WebSocket 升级、连接登记、信令转发与数据中转。
//!
//! 连接分两类：
//! - 控制连接（无 slot 参数）：收发双方的信令与控制消息（JSON 文本帧），
//!   服务端在对端控制连接之间转发；
//! - 数据连接（带 slot 参数）：二进制数据帧按槽位号在对端同号槽位之间
//!   1:1 转发，收发双方各开 SLOTS 条即可并行传输。
//!
//! 数据帧格式：`[u16 文件序号(小端)][u16 分段号(小端)][文件内容分片]`，
//! 帧的切分与重组语义由前端约定，本层只负责按槽位转发。

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::rooms::UnregisterOutcome as Unregister;
use crate::state::AppState;

/// 数据槽位出站队列容量（帧）。接收方消费慢时队列填满、转发阻塞，
/// 背压逐层传回发送方，保证服务器内存不因慢速接收方而膨胀。
const DATA_QUEUE_FRAMES: usize = 128;

/// 需要在收发双方之间转发的控制消息类型。
const RELAYED_TYPES: &[&str] = &[
    "sdp", "ice", "meta", "relay-mode", "ready", "file-start", "file-end", "complete", "cancel",
    "received", "session-state", "error",
];

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/ws", get(ws_handler))
}

#[derive(Deserialize)]
struct WsParams {
    r: String,
    role: String,
    token: Option<String>,
    slot: Option<u16>,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<WsParams>,
    State(state): State<Arc<AppState>>,
) -> Response {
    // 发送方连接需要有效令牌；接收方扫码即用，不设门禁
    if params.role == "sender" && state.auth.enabled() {
        let ok = params
            .token
            .as_deref()
            .map(|t| state.auth.verify(t))
            .unwrap_or(false);
        if !ok {
            return (StatusCode::UNAUTHORIZED, "需要有效的访问密钥").into_response();
        }
    }
    ws.on_upgrade(move |socket| async move {
        if params.slot.is_some() {
            handle_data_socket(socket, params, state).await;
        } else {
            handle_ctl_socket(socket, params, state).await;
        }
    })
}

fn parse_ctl(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text).ok()
}

/// 控制连接：信令转发 + 控制消息转发 + 文件清单缓存。
async fn handle_ctl_socket(socket: WebSocket, params: WsParams, state: Arc<AppState>) {
    let is_sender = params.role == "sender";
    let room_id = params.r;

    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    match state.rooms.register_ctl(&room_id, is_sender, tx.clone()) {
        None => {
            let _ = sink.send(Message::Close(None)).await;
            return;
        }
        Some((replaced, meta)) => {
            if let Some(old) = replaced {
                let _ = old.send(Message::Close(None));
            }
            if !is_sender {
                if let Some(meta) = meta {
                    let _ = tx.send(Message::Text(meta.to_string().into()));
                }
                if let Some(sender) = state.rooms.peer_ctl_tx(&room_id, false) {
                    let _ =
                        sender.send(Message::Text(json!({"t":"peer-joined"}).to_string().into()));
                }
                tracing::info!("接收方加入房间 {room_id}");
            }
        }
    }

    // 心跳，穿透反向代理的空闲超时。
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = ping.tick() => {
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
            Some(msg) = rx.recv() => {
                let closing = matches!(msg, Message::Close(_));
                if sink.send(msg).await.is_err() || closing {
                    break;
                }
            }
            next = stream.next() => {
                match next {
                    Some(Ok(Message::Text(text))) => {
                        if let Some(v) = parse_ctl(text.as_str()) {
                            on_ctl(&state, &room_id, is_sender, &v, text.as_str());
                        }
                    }
                    // 控制连接不再承载数据帧；仅用于续活
                    Some(Ok(Message::Binary(_))) => state.rooms.touch(&room_id),
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => state.rooms.touch(&room_id),
                    Some(Err(_)) => break,
                }
            }
        }
    }

    match state.rooms.unregister_ctl(&room_id, is_sender, &tx) {
        Unregister::SenderRemoved {
            receiver_ctl,
            close_list,
        } => {
            for data_tx in close_list {
                let _ = data_tx.send(Message::Close(None)).await;
            }
            if let Some(receiver) = receiver_ctl {
                let _ =
                    receiver.send(Message::Text(json!({"t":"room-closed"}).to_string().into()));
                let _ = receiver.send(Message::Close(None));
            }
            tracing::info!("发送方离开，房间 {room_id} 关闭");
        }
        Unregister::ReceiverRemoved {
            sender_ctl,
            close_list,
        } => {
            for data_tx in close_list {
                let _ = data_tx.send(Message::Close(None)).await;
            }
            if let Some(sender) = sender_ctl {
                let _ = sender.send(Message::Text(json!({"t":"peer-left"}).to_string().into()));
            }
            tracing::info!("接收方离开房间 {room_id}");
        }
        Unregister::NotOwner => {}
    }
}

fn on_ctl(state: &AppState, room_id: &str, from_sender: bool, v: &Value, text: &str) {
    let t = v.get("t").and_then(Value::as_str).unwrap_or("");
    if !RELAYED_TYPES.contains(&t) {
        return;
    }
    if t == "meta" {
        state.rooms.store_meta(room_id, v.clone());
    }
    if let Some(peer) = state.rooms.peer_ctl_tx(room_id, from_sender) {
        let _ = peer.send(Message::Text(text.to_owned().into()));
    }
}

/// 数据连接：二进制帧按槽位号在对端同号槽位之间 1:1 转发。
async fn handle_data_socket(socket: WebSocket, params: WsParams, state: Arc<AppState>) {
    let is_sender = params.role == "sender";
    let room_id = params.r;
    let slot = params.slot.unwrap_or(0);

    let (mut sink, mut stream) = socket.split();
    // 有界队列：对端消费慢时 send 阻塞 → 不再读本端 socket → TCP 背压回传给发送方
    let (tx, mut rx) = mpsc::channel::<Message>(DATA_QUEUE_FRAMES);

    if !state.rooms.register_data(&room_id, is_sender, slot, tx.clone()) {
        tracing::debug!("数据槽位 {slot} 加入不存在的房间 {room_id}，拒绝");
        let _ = sink.send(Message::Close(None)).await;
        return;
    }

    let mut ping = tokio::time::interval(Duration::from_secs(25));
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = ping.tick() => {
                if sink.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
            Some(msg) = rx.recv() => {
                let closing = matches!(msg, Message::Close(_));
                if sink.send(msg).await.is_err() || closing {
                    break;
                }
            }
            next = stream.next() => {
                match next {
                    Some(Ok(Message::Binary(data))) => {
                        // 阻塞式转发：对端慢则在此等待，暂停读取发送方数据形成背压
                        let mut delivered = false;
                        if let Some(peer) = state.rooms.peer_data_tx(&room_id, is_sender, slot) {
                            delivered = peer.send(Message::Binary(data)).await.is_ok();
                        }
                        if !delivered {
                            tracing::debug!("槽位 {slot} 对端不可达，停止转发（房间 {room_id}）");
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => state.rooms.touch(&room_id),
                    Some(Err(_)) => break,
                }
            }
        }
    }

    state.rooms.unregister_data(&room_id, is_sender, slot, &tx);
}
