# imgport · 快传

免安装的图片/视频**无损**传输服务。发送方选择文件生成二维码，接收方手机扫码后自动接收；
两台设备之间**优先 WebRTC P2P 直连**，打洞失败时**自动回退到服务器中转**，全程无需安装任何 App。

```
发送方浏览器 ──┬── 信令（WebSocket：SDP/ICE）──┐
              │                               ├── 服务器（单镜像）
              └── P2P 数据通道（WebRTC DataChannel，直连，文件不过服务器）
接收方浏览器 ──┴── 打洞失败时：数据经服务器 WebSocket 内存中转（不落盘）
```

## 特性

- **无损传输**：文件原样搬运，不压缩、不转码、不改动字节
- **方向自动矫正**：发送前自动把照片的方向/前置镜像元数据烘焙进像素（HEIC 等转存为 JPEG），接收方在任何设备上看到的都与发送方一致；PNG、视频保持字节原样
- **自动选择通道**：先尝试 P2P 直连（STUN 打洞），8 秒内建不成自动切服务器中转，用户无感
- **并行分块传输**：每个文件切 3 个分段，走 3 条并行通道（P2P 多 DataChannel / 中转多 WebSocket 连接，服务端按槽位 1:1 转发），配合读预取流水线与独立背压，大幅提升大文件吞吐
- **扫码即收**：接收方扫码打开网页即自动连接、自动接收、自动保存，无需任何操作
- **点击预览原图**：发送方点击已选缩略图即可灯箱预览原图/播放视频（原始文件，非缩略图）
- **随时重新开始**：等待扫码阶段可点「新建传输」，旧房间与二维码立即销毁失效，已选文件保留
- **发送方密钥门禁**：发送前需输入访问密钥，验证后 30 天免输入；接收方扫码即用不受限
- **免安装**：收发双方都只是浏览器网页，前端已内嵌进服务端二进制，无外部依赖
- **单镜像部署**：`docker run` 一条命令起服务；一个二进制包含全部功能
- **隐私友好**：P2P 时文件不经过服务器；中转模式数据仅驻留内存，服务不写任何磁盘文件

## 快速开始

### Docker（推荐）

```bash
docker build -t imgport:latest .
docker run -d --name imgport -p 8080:8080 -e KEY=我的密钥 imgport
```

### 离线部署（tar 包 + docker compose）

在有外网的机器上构建并导出镜像归档：

```bash
docker build -t imgport:latest .
docker save -o release/imgport-latest.tar imgport:latest
```

把 `imgport-latest.tar` 与 `docker-compose.yml` 拷到目标机器（无需 Rust/Docker 构建环境），按需修改
compose 文件中的 `KEY`，然后：

```bash
docker load -i imgport-latest.tar
docker compose up -d
```

访问 `http://<主机IP>:8080` 即可使用；`docker compose down` 停止，`restart: unless-stopped`
保证开机自启与崩溃自动拉起。

### 本地运行（需 Rust 工具链）

```bash
cargo run --release
# 默认监听 0.0.0.0:8080，可通过 PORT 环境变量修改
PORT=9000 cargo run --release
```

打开 `http://<服务器IP>:8080` 即可使用。

## 使用流程

1. **发送方**：电脑/手机打开服务首页 → 点选或拖入图片、视频（支持多选，也接受任意其他文件）→ 点「生成二维码，开始发送」
2. **接收方**：手机相机扫码 → 浏览器自动打开接收页 → 自动连接、自动接收
3. 传输过程中双方实时显示进度、速度和通道类型（`P2P 直连` / `服务器中转`）；接收方自动触发保存并生成可回看的相册

> 二维码里编码的是发送方当前访问的地址（`location.origin`）。若发送方用 `localhost` 打开页面，
> 手机扫出来无法访问 —— 页面上提供了可编辑的地址栏，改成局域网 IP（如 `http://192.168.1.10:8080`）
> 后点「刷新二维码」即可。

## 工作原理

### 房间与信令

- 发送方 `POST /api/rooms` 创建房间（8 位随机 ID，约 1e12 组合，30 分钟无活动自动回收）
- 双方各持一条 WebSocket（`/ws?r=<房间>&role=sender|receiver`），服务器在两条连接之间转发
  SDP offer/answer 与 ICE candidate
- 服务器同时缓存文件清单（meta），接收方无论何时加入（含断线重连）都能立即看到待收文件列表

### 数据通道（自动协商）

1. 接收方收到 offer 后建立 `RTCPeerConnection`（STUN：Google 公共服务器）
2. **DataChannel 打开** → 双方进入 `P2P 直连` 模式，文件分片（16 KB）直接走 DataChannel，
   利用 `bufferedAmountLowThreshold` 做背压控制
3. **8 秒看门狗超时 / ICE failed** → 接收方发送 `relay-mode`，双方销毁 PeerConnection，
   改走 WebSocket：发送方以 64 KB 分片发二进制帧，服务器原样转发给接收方
4. 两种通道使用相同的数据帧格式：`[u16 文件序号(小端)] + [文件内容分片]`，控制消息为 JSON 文本帧

### 完整性

WebRTC DataChannel 基于 DTLS（SCTP 可靠有序），WebSocket 基于 TCP，传输层保证字节级完整；
接收完成后逐文件回执（`received`），发送方据此标记「已送达 ✓」。

## 隐私与安全

- 服务端**不落盘**：所有中转数据仅存于进程内存，房间过期即随连接释放
- 房间 ID 即临时凭证：知道 8 位房间号的人（扫到码的人）才能加入；每个房间同一时刻只有一个接收方，后加入者顶替前者
- 服务无鉴权、无限速，公网部署时建议置于反向代理（Nginx/Caddy）之后并加 TLS，WebRTC 数据通道本身已是 DTLS 加密

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | HTTP 监听端口 |
| `KEY` | `imgport` | 发送方访问密钥；`KEY=off` 关闭门禁。验证通过后签发 30 天有效的签名令牌（存于浏览器），期间免重复输入；服务端在创建房间和发送方建连时强制校验 |
| `RUST_LOG` | `imgport=info` | 日志级别 |

```bash
# 自定义密钥启动
docker run -d --name imgport -p 8080:8080 -e KEY=我的密钥 imgport
```

## 常见问题

- **手机扫码打不开页面？** 确认接收地址与手机网络可达：同一 Wi-Fi 下用局域网 IP；跨网络需公网域名或内网穿透。
- **为什么显示「服务器中转」？** 双方处于对称型 NAT 等无法打洞的网络环境，自动回退是预期行为，传输继续、速度受服务器带宽限制。
- **iOS Safari 没有自动保存？** iOS 对无用户手势的下载限制较严，请点相册里的「⬇ 保存」或底部「保存全部」。
- **Windows 本机编译报错 os error 4551（应用程序控制策略）？** 系统开启了 Smart App Control，会拦截新编译的未签名 exe；用 Docker 构建（`docker build`）或在允许策略的环境下编译即可。

## Live Photo 传输

Live Photo 实际是「HEIC/JPEG 静态图 + MOV 视频」一对文件，靠 Apple 的 ContentIdentifier（UUID）关联。
本服务通过流式扫描双方文件中的匹配 UUID（MOV 侧须含 `com.apple.quicktime.content.identifier` 标记）
自动识别配对，命中后两端都以 **Live** 标签展示，字节原样传输、文件名原样保留，接收方连续保存两个文件，
一起导入相册即恢复 Live 效果。

使用方法（iPhone）：先把 Live Photo 通过分享菜单「存储到文件」导出为 `.HEIC` + `.mov` 两个文件，
点击发送方选择框 → 在弹出的系统面板中选**「选取文件」** → 进入「文件」App 同时选中两个文件。
识别命中后两端显示 **Live** 标签，直接生成二维码传输即可。

> 若只选到了 Live 的静态部分（直接从相册选取时 iOS 只会给出静态画面），发送方会出现醒目的
> 操作指引横幅，按提示导出并补选配对视频后横幅自动消失。
> iOS 系统限制：相册选取器（照片图库）只会返回 Live Photo 的静态部分且可能被转码，
> 因此完整 Live 对必须走「选取文件」路径；选择框不设类型限制，此时照片图库返回的也是原始 HEIC 不转码。
> HEIC 在浏览器端无法解码预览时，缩略图/预览会回退为图标，传输本身不受影响。

## 项目结构

```
├── Cargo.toml          # Rust 依赖（axum + tokio + qrcode + rust-embed + hmac）
├── Dockerfile          # 多阶段构建：编译 → debian-slim 运行镜像
├── static/             # 前端（编译期内嵌进二进制）
│   ├── index.html      # 单页骨架（发送方/接收方共用，按 ?r= 参数分流）
│   ├── style.css       # 浅色主题样式
│   └── app.js          # 核心逻辑：密钥门禁、文件选择、二维码、WebRTC 协商、传输泵、回退、自动接收
└── src/
    ├── main.rs         # 入口：日志/状态初始化、路由装配、监听（薄壳）
    ├── config.rs       # 配置：PORT / KEY / ROOM_TTL / MAX_ROOMS，集中从环境变量解析
    ├── state.rs        # 全局共享状态（配置 + 门禁 + 房间登记簿）
    ├── auth.rs         # 密钥门禁：HMAC 令牌签发/校验 + 门禁接口
    ├── rooms.rs        # 房间域：登记簿（语义化操作）+ 房间 API + 过期回收
    ├── transfer.rs     # 实时传输层：WS 升级、信令转发、数据中转
    └── web.rs          # 静态资源、二维码、总路由组装
```

扩展方式：新增页面/接口时，在对应业务模块的 `router()` 里加路由即可（`web.rs` 自动合并）；
新增配置项在 `config.rs` 集中解析；传输层只依赖 `rooms.rs` 的语义化登记接口，不接触内部数据结构。
