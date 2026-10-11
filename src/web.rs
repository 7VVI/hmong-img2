//! 表现层：静态资源托管、二维码生成与总路由组装。
//!
//! 各业务模块（auth/rooms/transfer）各自暴露子路由，这里只做拼装，
//! 新增页面或接口时在对应模块内扩展路由即可。

use std::sync::Arc;

use axum::{
    extract::{Path, Query},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use rust_embed::RustEmbed;
use serde::Deserialize;

use crate::{auth, rooms, state::AppState, transfer};

#[derive(RustEmbed)]
#[folder = "static"]
struct Assets;

/// 组装全部路由并绑定共享状态。
pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/asset/{*path}", get(asset))
        .route("/api/qr", get(qr))
        .merge(auth::router())
        .merge(rooms::router())
        .merge(transfer::router())
        .route("/healthz", get(|| async { "ok" }))
        .with_state(state)
}

// ---------- 静态资源 ----------

async fn index() -> Response {
    serve_asset("index.html")
}

async fn asset(Path(path): Path<String>) -> Response {
    serve_asset(&path)
}

fn serve_asset(path: &str) -> Response {
    match Assets::get(path) {
        Some(file) => {
            let mime = match path.rsplit('.').next() {
                Some("html") => "text/html; charset=utf-8",
                Some("js") => "text/javascript; charset=utf-8",
                Some("css") => "text/css; charset=utf-8",
                Some("svg") => "image/svg+xml",
                Some("png") => "image/png",
                Some("ico") => "image/x-icon",
                Some("json") => "application/json",
                _ => "application/octet-stream",
            };
            // no-cache：每次刷新向服务器确认，保证换镜像后前端立即更新
            (
                [
                    (header::CONTENT_TYPE, mime),
                    (header::CACHE_CONTROL, "no-cache"),
                ],
                file.data.to_vec(),
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

// ---------- 二维码 ----------

#[derive(Deserialize)]
struct QrParams {
    text: String,
}

async fn qr(Query(params): Query<QrParams>) -> Response {
    let text = params.text;
    if text.is_empty() || text.len() > 512 {
        return (StatusCode::BAD_REQUEST, "invalid text").into_response();
    }
    let code = match qrcode::QrCode::with_error_correction_level(text.as_bytes(), qrcode::EcLevel::M)
    {
        Ok(c) => c,
        Err(_) => return (StatusCode::BAD_REQUEST, "qr encode failed").into_response(),
    };
    let svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(256, 256)
        .quiet_zone(true)
        .dark_color(qrcode::render::svg::Color("#0b1020"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();
    (
        [(header::CONTENT_TYPE, "image/svg+xml; charset=utf-8")],
        svg,
    )
        .into_response()
}
