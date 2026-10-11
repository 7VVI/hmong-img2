//! imgport — 免安装的图片/视频无损传输服务（入口）。
//!
//! 模块划分：
//! - [`config`]：环境变量配置
//! - [`auth`]：发送方密钥门禁
//! - [`rooms`]：房间域（登记簿 + 生命周期）
//! - [`transfer`]：WebSocket 实时传输（信令转发 + 数据中转）
//! - [`state`]：全局共享状态
//! - [`web`]：静态资源与总路由组装
//!
//! 本文件只负责装配：初始化日志与状态、启动回收任务、监听端口。

mod auth;
mod config;
mod rooms;
mod state;
mod transfer;
mod web;

use std::sync::Arc;

use crate::config::Config;
use crate::state::AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "imgport=info,tower_http=off".into()),
        )
        .init();

    let config = Config::from_env();
    let state = Arc::new(AppState::new(config.clone()));
    if state.auth.enabled() {
        tracing::info!(
            "发送方访问密钥已启用（{} 天有效），设 KEY=off 可关闭门禁",
            auth::AUTH_DAYS
        );
    } else {
        tracing::info!("访问密钥门禁已关闭（KEY=off）");
    }
    tokio::spawn(rooms::cleanup_loop(state.clone()));

    let app = web::router(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", config.port))
        .await
        .unwrap_or_else(|e| panic!("无法绑定 0.0.0.0:{}: {e}", config.port));
    tracing::info!("imgport 已启动: http://0.0.0.0:{}", config.port);
    axum::serve(listener, app).await.unwrap();
}
