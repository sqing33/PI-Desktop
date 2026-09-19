# PI-Web — pi-host 的浏览器聊天前端

PI-Web 是一个极简的单页应用：在浏览器里连接 pi-host 的 Web 通道（RACP over
WebSocket），查看会话列表、收发消息、处理工具审批与提问卡片。

不提供附件、终端、workspace 浏览 —— 服务端本身就不向浏览器开放这些能力。

## 启动 pi-host（Web 模式）

在公司 Mac 上运行（默认监听 `8080`，同时在该端口提供本前端静态页与 API）：

```bash
# 设备令牌方式（长期使用）
pi-host --web --token pdt1.xxxxxxxx

# 一次性配对令牌方式（更安全，仅在启动时打印一次）
pi-host --web --pair
```

启动后终端会打印访问地址与令牌。`--pair` 打印的 `ppt1.…` 令牌用一次即失效。

## 获取令牌

- 一次性配对令牌：启动时加 `--pair`，从 pi-host 终端输出复制，形如 `ppt1.…`。
- 设备令牌：形如 `pdt1.…`，可长期使用，注意不要泄露。

## 访问

**生产方式（推荐）**：pi-host 直接在 8080 端口托管本页，浏览器打开
`http://<mac主机地址>:8080/` 即可。粘贴令牌登录。

**开发方式**：本目录起 Vite dev server（5173），`/v1` 已代理到
`http://127.0.0.1:8080`（含 WebSocket）：

```bash
pnpm --filter @pi-desktop/web dev     # http://localhost:5173
```

> 注意：通过 SSH 端口转发访问时，请转发 8080 并直接用生产方式访问，
> 避免开发代理带来的跨源 cookie 问题。登录使用 `fetch` 同源携带 cookie，
> WebSocket 升级也依赖同一 cookie。

## 构建

```bash
pnpm --filter @pi-desktop/web typecheck
pnpm --filter @pi-desktop/web build   # 产物在 apps/web/dist/
```

## 目录结构

| 文件 | 职责 |
| --- | --- |
| `src/racp.ts` | WebSocket + JSON-RPC 2.0 传输客户端（登录、自动重连、请求/通知/事件/server request） |
| `src/types.ts` | RACP 最小类型定义与类型守卫（payload 一律 `unknown` 收敛，无 `any`） |
| `src/api.ts` | RACP 操作封装（listSessions / createSession / attach / subscribe / turn / approval / input） |
| `src/content.ts` | 宽松的消息内容文本提取（字符串 / `{message}` / `{text}` / blocks 数组 / JSON 回退） |
| `src/chatReducer.ts` | 纯 reducer：snapshot + 事件流 → 消息/审批/输入卡片状态 |
| `src/App.tsx` | 应用状态机：登录探活、连接状态、会话列表事件同步 |
| `src/Login.tsx` | 令牌登录页 |
| `src/Sessions.tsx` | 会话侧栏（列表、状态徽标、新建会话） |
| `src/Chat.tsx` | 主聊天区（消息流、工具折叠块、审批/提问卡片、Composer） |

## 协议说明

WebSocket 子协议 `pi-racp.v1.jsonrpc`。连接建立后先发
`connection/initialize`，收到结果后发 `notifications/initialized` 通知，之后
按 JSON-RPC 2.0 调用操作。事件通过 `session/event` 通知推送。协议常量与
`packages/shared/src/racp.ts` 中的定义保持一致（前端按字面量写入，不做跨包
import）。
