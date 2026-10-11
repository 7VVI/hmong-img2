//! 服务配置：集中从环境变量解析，启动一次、全局只读。

use std::time::Duration;

#[derive(Clone)]
pub struct Config {
    pub port: u16,
    /// 发送方访问密钥；`off`（不分大小写）表示关闭门禁。
    pub key: String,
    /// 房间无活动后的回收时长。
    pub room_ttl: Duration,
    /// 同时存在的最大房间数（防内存滥用）。
    pub max_rooms: usize,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            port: env_parse("PORT", 8080),
            key: std::env::var("KEY")
                .unwrap_or_else(|_| "imgport".to_string())
                .trim()
                .to_string(),
            room_ttl: Duration::from_secs(env_parse("ROOM_TTL", 30 * 60)),
            max_rooms: env_parse("MAX_ROOMS", 512),
        }
    }
}

fn env_parse<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}
