# pi-host Web 远程控制

在浏览器里直接操作公司 Mac 上运行的 `pi-host`：从家里或任意设备打开网页，就能看到会话、发消息、审批工具调用、管理任务。

## 它是什么

同一个 Agent Host 的第二种访问通道。`pi-host` 原本只通过 RACP-WS 服务桌面客户端；开启 `--web` 后它会额外监听一个 HTTP 端口，托管一个浏览器前端并开放一条 Cookie 认证的 WebSocket 通道。

核心区别只有一个：**浏览器不能设置 `Authorization` header**（WebSocket API 不支持自定义头），而 RACP 原本只认 Bearer header。所以 Web 通道在握手前先用一次 HTTP 请求把令牌换成会话 Cookie，后续连接由 Cookie 维持身份。

```
浏览器 ──POST /v1/racp/auth/login──▶ pi-host （交换令牌 → Set-Cookie）
浏览器 ──WS /v1/racp/ws（自动带 Cookie）──▶ pi-host （RACP-WS JSON-RPC）
```

数据全部走同一条 RACP 协议线：会话、回合、审批、事件流、工具执行都在公司机器上发生，浏览器只是远程显示器和输入端。

## 启用

### 1. 启动 pi-host 的 Web 模式

```bash
~/.pi-desktop/pi-host/current/pi-host.js --web --web-port 8080 --pair --data-dir ~/.pi-desktop
```

- `--web` 打开 Web 通道（默认关闭，不加这个参数 pi-host 行为与之前完全一致）
- `--web-port 8080` HTTP 端口（默认 8080）
- `--web-host` 绑定地址（默认 `127.0.0.1`）
- `--pair` 启动时打印一个一次性登录令牌（10 分钟有效）

日志里的关键行：

```
PI_HOST_WEB_READY {"host":"127.0.0.1","port":8080}
PI_HOST_PAIRING_TOKEN {"token":"ppt1.…","expiresAt":"…"}
```

### 2. 浏览器打开并登录

浏览器访问 `http://<host>:8080`，把终端里的 `ppt1.…` 令牌粘进登录框。

令牌是一次性的（消费后立刻失效），换取的是有效期 7 天的会话 Cookie。之后直接刷新页面就免密进入。

### 3. 远程访问

不要把 8080 端口直接暴露到公网。推荐按需选择：

- **Tailscale / 内网**：把公司机器加入私有组网，用 `tailscale ip serve` 提供 TLS，或直接用 Tailscale IP 访问（WireGuard 本身已加密）
- **SSH 隧道**：从家里建隧道再访问 127.0.0.1
- **反向代理**：Caddy / Nginx 终止 TLS 后转发到 127.0.0.1:8080

## 能做什么

- 浏览、切换、创建会话
- 发送消息、停止/中断正在运行的回合
- 审批工具调用（`allow-once` / `allow-session` / `deny`）
- 审批 Plan / Goal 合约（`approve` / `reject`）
- 回答 Agent 的提问
- 实时看到工具调用与流式输出

**不能做**：附件上传、终端、Steering。这些在 RACP 协议层就没有对浏览器开放，前端不提供对应入口。

## 权限边界

Web 会话的角色**固定降权为 `viewer + controller + approver`**，**永远不含 `owner`**。即使你用设备令牌登录，拿到的也是降权角色。

这意味着 Web 端**不能**：删除或归档会话、撤销设备、注册项目、广播工具（`tools/advertise`）。需要这些操作请在桌面端进行。

会话默认继承 Host 的 `remoteMaxPermissionMode` 上限（默认 `ask`），所以远程回合的写操作仍会请求确认，除非你在 Host 上调整策略。

## 本地开发

```bash
# 终端 1：跑 Host（源码模式）
pnpm build:js
pnpm --filter @pi-desktop/racp build
pnpm --filter @pi-desktop/pi-host build
node apps/pi-host/dist/cli.js --web --web-port 8080 --pair

# 终端 2：前端热更新
pnpm --filter @pi-desktop/web dev   # http://127.0.0.1:5173，已配 /v1 代理
```

构建产物在 `apps/web/dist`，`bundle.mjs` 会自动把它装进 `pi-host` bundle 的 `dist-web/`。

## 安全清单

- 默认只绑 `127.0.0.1`；绑定非回环地址会打印警告
- Cookie 是 `HttpOnly` + `SameSite=Strict`，凭据不出浏览器
- 令牌不出现在 URL 里（带 token/auth 查询参数的连接直接拒绝）
- 登录接口按 IP 限流（每分钟 10 次）
- 静态资源有路径穿越防护（realpath 双重前缀校验）
- 会话只存在于内存，进程重启即失效，需要重新配对

仍建议配合 TLS 或私有组网：单靠 WireGuard/Tailscale 传输是安全的，但若裸奔在公网，登录接口在风控和可用性上都没有生产级保证。
