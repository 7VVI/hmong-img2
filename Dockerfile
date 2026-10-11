# imgport — 单镜像部署
# 构建: docker build -t imgport .
# 运行: docker run -d -p 8080:8080 --name imgport imgport

# ---------- 编译阶段 ----------
FROM rust:1-slim AS build
WORKDIR /app

# 先只拷贝清单并预编译依赖，源码改动时可复用依赖缓存层
COPY Cargo.toml Cargo.lock* ./
RUN mkdir src && echo "fn main() {}" > src/main.rs \
    && cargo build --release \
    && rm -rf src target/release/deps/imgport* target/release/.fingerprint/imgport*

COPY src ./src
COPY static ./static
RUN touch src/main.rs && cargo build --release

# ---------- 运行阶段 ----------
FROM debian:bookworm-slim
COPY --from=build /app/target/release/imgport /usr/local/bin/imgport

ENV PORT=8080
EXPOSE 8080
USER 65534:65534
# 运行镜像不带 curl，用 bash 内置 /dev/tcp 探活
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${PORT} && printf 'GET /healthz HTTP/1.0\\r\\n\\r\\n' >&3 && grep -q ' 200 ' <&3"]
CMD ["imgport"]
