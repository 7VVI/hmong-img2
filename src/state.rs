//! 全局共享状态：聚合配置、门禁与房间登记簿，供各模块按需取用。

use axum::extract::ws::Message;
use tokio::sync::mpsc;

use crate::auth::Auth;
use crate::config::Config;
use crate::rooms::RoomRegistry;

/// 发往单个客户端连接的出站通道。
pub type ClientTx = mpsc::UnboundedSender<Message>;

pub struct AppState {
    pub config: Config,
    pub auth: Auth,
    pub rooms: RoomRegistry,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        Self {
            auth: Auth::new(&config.key),
            rooms: RoomRegistry::new(),
            config,
        }
    }
}
