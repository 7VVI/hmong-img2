//! 全局共享状态：聚合配置、门禁与房间登记簿，供各模块按需取用。

use axum::extract::ws::Message;
use tokio::sync::mpsc;

use crate::auth::Auth;
use crate::config::Config;
use crate::rooms::RoomRegistry;

/// 发往单个控制连接的出站通道（信令/控制消息，量小）。
pub type ClientTx = mpsc::UnboundedSender<Message>;

/// 发往单个数据连接的出站通道（有界队列：接收方消费慢时填满并阻塞转发，
/// 把背压逐层传回发送方，避免服务器内存被慢速接收方拖垮）。
pub type DataTx = mpsc::Sender<Message>;

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
