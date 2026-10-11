//! 实时传输层：WebSocket 升级、连接登记、信令转发与数据中转。
//!
//! 数据帧（DataChannel 与 WebSocket 二进制帧通用）：`[u16 文件序号(小端)] + [文件内容分片]`；
//! 控制消息为 JSON 文本帧，字段 `t` 表示类型。帧的具体含义由前端约定，本层只负责转发。

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

/// 需要在收发双方之间转发的控制消息类型。
const RELAYED_TYPES: &[&str] = &[
    "sdp", "ice", "meta", "relay-mode", "file-start", "file-end", "complete", "cancel", "received",
    "error",
];

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/ws", get(ws_handler))
}

#[derive(Deserialize)]
struct WsParams {
    r: String,
    role: String,
    token: Option<String>,
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
    ws.on_upgrade(move |socket| handle_socket(socket, params, state))
}

async fn handle_socket(socket: WebSocket, params: WsParams, state: Arc<AppState>) {
    let is_sender = params.role == "sender";
    let room_id = params.r;

    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    // 登记到房间：发送方不存在则自动补建；接收方顶替旧连接。
    if is_sender {
        if let Some(old) = state.rooms.register_sender(&room_id, tx.clone()) {
            let _ = old.send(Message::Close(None));
        }
    } else {
        let Some(join) = state.rooms.register_receiver(&room_id, tx.clone()) else {
            tracing::info!("接收方加入不存在的房间 {room_id}，拒绝");
            let _ = sink.send(Message::Close(None)).await;
            return;
        };
        if let Some(old) = join.replaced_tx {
            let _ = old.send(Message::Close(None));
        }
        if let Some(meta) = join.meta {
            let _ = tx.send(Message::Text(meta.to_string().into()));
        }
        if let Some(sender) = state.rooms.peer_tx(&room_id, false) {
            let _ = sender.send(Message::Text(json!({"t":"peer-joined"}).to_string().into()));
        }
        tracing::info!("接收方加入房间 {room_id}");
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
                        on_text(&state, &room_id, is_sender, text.as_str());
                    }
                    Some(Ok(Message::Binary(data))) => {
                        // 数据帧原样转发给对端（中转模式）。
                        if let Some(peer) = state.rooms.peer_tx(&room_id, is_sender) {
                            let _ = peer.send(Message::Binary(data));
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => state.rooms.touch(&room_id),
                    Some(Err(_)) => break,
                }
            }
        }
    }

    // 注销：只清理仍然属于自己的槽位，避免误伤顶替上来的新连接。
    match state.rooms.unregister(&room_id, is_sender, &tx) {
        Unregister::SenderRemoved { receiver } => {
            if let Some(receiver) = receiver {
                let _ = receiver.send(Message::Text(json!({"t":"room-closed"}).to_string().into()));
                let _ = receiver.send(Message::Close(None));
            }
            tracing::info!("发送方离开，房间 {room_id} 关闭");
        }
        Unregister::ReceiverRemoved { sender } => {
            if let Some(sender) = sender {
                let _ = sender.send(Message::Text(json!({"t":"peer-left"}).to_string().into()));
            }
            tracing::info!("接收方离开房间 {room_id}");
        }
        Unregister::NotOwner => {}
    }
}

fn on_text(state: &AppState, room_id: &str, from_sender: bool, text: &str) {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return;
    };
    let t = v.get("t").and_then(Value::as_str).unwrap_or("");
    if !RELAYED_TYPES.contains(&t) {
        return;
    }
    if t == "meta" {
        state.rooms.store_meta(room_id, v.clone());
    }
    if let Some(peer) = state.rooms.peer_tx(room_id, from_sender) {
        let _ = peer.send(Message::Text(text.to_owned().into()));
    }
}
