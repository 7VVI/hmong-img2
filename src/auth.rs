//! 发送方访问密钥门禁。
//!
//! `POST /api/auth` 校验密钥并签发 `过期时间戳.HMAC签名` 形式的令牌（30 天有效）；
//! 客户端保存令牌，服务端在创建房间与发送方建连时强制校验。
//! `KEY=off` 可整体关闭门禁；更换密钥会使所有已签发令牌立即失效。

use std::{sync::Arc, time::{Duration, SystemTime, UNIX_EPOCH}};

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::state::AppState;

pub const AUTH_DAYS: u64 = 30;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub struct Auth {
    key: String,
}

impl Auth {
    pub fn new(key: &str) -> Self {
        Self { key: key.to_string() }
    }

    pub fn enabled(&self) -> bool {
        !self.key.is_empty() && !self.key.eq_ignore_ascii_case("off")
    }

    /// 为给定过期时间计算签名。
    fn sign(&self, exp: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(self.key.as_bytes()).expect("hmac 接受任意长度密钥");
        mac.update(exp.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    /// 签发新令牌。
    pub fn issue(&self) -> Value {
        let exp = (now_secs() + AUTH_DAYS * 86400).to_string();
        json!({ "token": format!("{exp}.{}", self.sign(&exp)), "expiresIn": AUTH_DAYS * 86400 })
    }

    /// 校验令牌：签名正确且未过期。
    pub fn verify(&self, token: &str) -> bool {
        let Some((exp, sig)) = token.split_once('.') else {
            return false;
        };
        if exp.parse::<u64>().map(|e| e < now_secs()).unwrap_or(true) {
            return false;
        }
        let Ok(sig_bytes) = hex::decode(sig) else {
            return false;
        };
        let mut mac = HmacSha256::new_from_slice(self.key.as_bytes()).expect("hmac 接受任意长度密钥");
        mac.update(exp.as_bytes());
        mac.verify_slice(&sig_bytes).is_ok()
    }

    /// 常数时间比较密钥，防时序攻击。
    fn key_matches(&self, provided: &str) -> bool {
        provided.as_bytes().ct_eq(self.key.as_bytes()).into()
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Deserialize)]
struct KeyBody {
    key: String,
}

#[derive(Deserialize)]
struct TokenQuery {
    token: Option<String>,
}

async fn auth_info(State(state): State<Arc<AppState>>) -> Response {
    Json(json!({ "required": state.auth.enabled(), "days": AUTH_DAYS })).into_response()
}

async fn auth_login(State(state): State<Arc<AppState>>, Json(body): Json<KeyBody>) -> Response {
    if !state.auth.enabled() || state.auth.key_matches(&body.key) {
        return Json(state.auth.issue()).into_response();
    }
    // 轻微减速，抑制暴力尝试
    tokio::time::sleep(Duration::from_millis(500)).await;
    (StatusCode::UNAUTHORIZED, "密钥错误").into_response()
}

async fn auth_check(State(state): State<Arc<AppState>>, Query(p): Query<TokenQuery>) -> Response {
    let valid = !state.auth.enabled()
        || p.token
            .as_deref()
            .map(|t| state.auth.verify(t))
            .unwrap_or(false);
    if valid {
        Json(json!({ "valid": true })).into_response()
    } else {
        StatusCode::UNAUTHORIZED.into_response()
    }
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/auth/info", get(auth_info))
        .route("/api/auth", post(auth_login))
        .route("/api/auth/check", get(auth_check))
}
