/**
 * RACP-WS transport client: native WebSocket + JSON-RPC 2.0.
 *
 * Protocol literals below intentionally duplicate the constants in
 * `packages/shared/src/racp.ts` (RACP_WS_SUBPROTOCOL, RACP_WS_PATH,
 * "connection/initialize", RACP_INITIALIZED_NOTIFICATION,
 * RACP_EVENT_NOTIFICATION, RACP_PROTOCOL_VERSION). The web app is a
 * standalone browser bundle and must not import across packages; if the
 * shared contract changes, update the literals here to match.
 */
import type { JsonRpcFrame, RacpEventEnvelope, RacpInitializeResult } from "./types";
import { isRecord } from "./types";

const WS_SUBPROTOCOL = "pi-racp.v1.jsonrpc";
const WS_PATH = "/v1/racp/ws";
const INITIALIZE_METHOD = "connection/initialize";
const INITIALIZED_NOTIFICATION = "notifications/initialized";
const EVENT_NOTIFICATION = "session/event";
const PROTOCOL_VERSION = "1.0";
const CLIENT_NAME = "pi-web";
const CLIENT_VERSION = "0.1.0";

const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 8_000;

export type RacpConnectionState = "disconnected" | "connecting" | "connected" | "error";

export class RacpRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RacpRequestError";
    this.code = code;
  }
}

type EventListener = (envelope: RacpEventEnvelope) => void;
type ServerRequestListener = (method: string, params: unknown) => void;
type StateListener = (state: RacpConnectionState, detail: string) => void;
type ReconnectListener = () => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function readableError(code: string, message: string): string {
  const map: Record<string, string> = {
    UNAUTHORIZED: "未登录或会话已过期，请重新登录",
    FORBIDDEN: "没有执行该操作的权限",
    NOT_FOUND: "目标不存在（会话或轮次可能已被删除）",
    AGENT_BUSY: "会话正在处理其他请求",
    APPROVAL_EXPIRED: "该审批已过期",
    APPROVAL_STALE: "审批已被处理，请刷新",
    RATE_LIMITED: "请求过于频繁，请稍后再试",
    INVALID_ARGUMENT: "参数不合法",
    PROTOCOL_MISMATCH: "服务端协议版本不兼容",
    INTERNAL: "服务端内部错误",
  };
  const suffix = message ? `（${message}）` : "";
  return `${map[code] ?? `请求失败（${code}）`}${suffix}`;
}

export class RacpClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string | number, PendingRequest>();
  private eventListeners = new Set<EventListener>();
  private serverRequestListeners = new Set<ServerRequestListener>();
  private stateListeners = new Set<StateListener>();
  private reconnectListeners = new Set<ReconnectListener>();
  private state: RacpConnectionState = "disconnected";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private initializeResult: RacpInitializeResult | null = null;
  /** True after the first successful initialize, so a reconnect can re-subscribe. */
  private everConnected = false;

  get connectionState(): RacpConnectionState {
    return this.state;
  }

  get principal(): RacpInitializeResult | null {
    return this.initializeResult;
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onServerRequest(listener: ServerRequestListener): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state, "");
    return () => this.stateListeners.delete(listener);
  }


  /**
   * Fires after a reconnect completes initialize. Every subscription lives on
   * the old socket and is gone once it closed, so callers re-issue them here.
   */
  onReconnect(listener: ReconnectListener): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }
  private setState(state: RacpConnectionState, detail = ""): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state, detail);
  }

  // -------------------------------------------------------------------------
  // HTTP auth
  // -------------------------------------------------------------------------

  async login(token: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch("/v1/racp/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token }),
      });
    } catch {
      throw new RacpRequestError("NETWORK", "无法连接服务端，请确认 pi-host 已启动并监听 8080 端口");
    }
    if (response.ok) return;
    const body = await readErrorBody(response);
    throw new RacpRequestError(body.code, readableError(body.code, body.message));
  }

  async logout(): Promise<void> {
    try {
      await fetch("/v1/racp/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {
      // Logout is best-effort: the cookie dies with the server session.
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket lifecycle
  // -------------------------------------------------------------------------

  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.closedByUser = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setState("connecting");

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${protocol}//${location.host}${WS_PATH}`, [WS_SUBPROTOCOL]);
    } catch (error) {
      this.setState("error", `无法建立 WebSocket 连接：${describe(error)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      void this.initialize();
    };
    socket.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data);
    };
    socket.onclose = () => {
      this.failAllPending("连接已断开");
      this.socket = null;
      this.initializeResult = null;
      if (this.closedByUser) {
        this.setState("disconnected");
        return;
      }
      this.setState("error", "连接已断开，正在重连…");
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      // onclose follows for real failures; keep the error state visible.
      if (this.state !== "connected") this.setState("error", "WebSocket 连接失败");
    };
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failAllPending("连接已关闭");
    this.socket?.close();
    this.socket = null;
    this.initializeResult = null;
    this.reconnectAttempts = 0;
    this.setState("disconnected");
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async initialize(): Promise<void> {
    try {
      const result = await this.request(INITIALIZE_METHOD, {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: CLIENT_NAME, version: CLIENT_VERSION },
        bindings: ["RACP-WS"],
        // The schema requires this object; omitting it fails initialize with
        // INVALID_ARGUMENT. Keep it aligned with the desktop client's set.
        capabilities: {
          eventReplay: true,
          approvals: true,
          inputRequests: true,
          turnQueue: true,
          hostEvents: true,
          history: true,
        },
      });
      if (!isRecord(result)) throw new RacpRequestError("PROTOCOL_MISMATCH", "initialize 返回结果无法解析");
      const principalRecord = isRecord(result.principal) ? result.principal : {};
      const roles = Array.isArray(principalRecord.roles)
        ? principalRecord.roles.filter((entry): entry is string => typeof entry === "string")
        : [];
      this.initializeResult = {
        protocolVersion: typeof result.protocolVersion === "string" ? result.protocolVersion : "",
        connectionId: typeof result.connectionId === "string" ? result.connectionId : "",
        principal: {
          subject: typeof principalRecord.subject === "string" ? principalRecord.subject : "",
          roles: roles as RacpInitializeResult["principal"]["roles"],
        },
      };
      this.notify(INITIALIZED_NOTIFICATION, {});
      this.reconnectAttempts = 0;
      this.setState("connected");
      if (this.everConnected) {
        for (const listener of this.reconnectListeners) {
          try {
            listener();
          } catch {
            // A resubscribe failure must not break an already-live connection.
          }
        }
      }
      this.everConnected = true;
    } catch (error) {
      if (error instanceof RacpRequestError && (error.code === "UNAUTHORIZED" || error.code === "HTTP_401")) {
        // Auth cookie missing/expired: park the retry loop, user must log in.
        this.closedByUser = true;
        this.setState("error", "未登录或会话已过期，请重新登录");
        this.socket?.close();
        return;
      }
      this.setState("error", `初始化失败：${describe(error)}`);
      this.socket?.close();
    }
  }

  // -------------------------------------------------------------------------
  // JSON-RPC send
  // -------------------------------------------------------------------------

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new RacpRequestError("NOT_CONNECTED", "尚未连接到 pi-host"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RacpRequestError("TIMEOUT", `请求 ${method} 超时（30 秒）`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(frame: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  private failAllPending(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new RacpRequestError("DISCONNECTED", reason));
    }
    this.pending.clear();
  }

  // -------------------------------------------------------------------------
  // JSON-RPC receive
  private handleMessage(raw: unknown): void {
    let parsed: unknown;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    // Server request (has both id and method): acknowledge, then surface.
    if (typeof parsed.id === "string" || typeof parsed.id === "number") {
      if (typeof parsed.method === "string") {
        this.send({ jsonrpc: "2.0", id: parsed.id, result: { ok: true } });
        for (const listener of this.serverRequestListeners) listener(parsed.method, parsed.params);
        return;
      }
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      clearTimeout(pending.timer);
      if ("error" in parsed && isRecord(parsed.error)) {
        const code = typeof parsed.error.code === "string" ? parsed.error.code : "INTERNAL";
        const message = typeof parsed.error.message === "string" ? parsed.error.message : "";
        pending.reject(new RacpRequestError(code, readableError(code, message)));
      } else {
        pending.resolve("result" in parsed ? parsed.result : undefined);
      }
      return;
    }

    // Notification: only session/event matters to the UI.
    if (typeof parsed.method === "string" && parsed.method === EVENT_NOTIFICATION && isRecord(parsed.params)) {
      const envelope = parsed.params as unknown as RacpEventEnvelope;
      for (const listener of this.eventListeners) listener(envelope);
    }
  }
}
async function readErrorBody(response: Response): Promise<{ code: string; message: string }> {
  try {
    const body = (await response.json()) as unknown;
    if (isRecord(body) && isRecord(body.error)) {
      return {
        code: typeof body.error.code === "string" ? body.error.code : `HTTP_${response.status}`,
        message: typeof body.error.message === "string" ? body.error.message : "",
      };
    }
  } catch {
    // fall through to status-only mapping
  }
  const code = `HTTP_${response.status}`;
  const map: Record<number, string> = {
    401: "令牌无效或已过期，请重新获取",
    403: "没有权限",
    404: "接口不存在，请确认 pi-host 版本",
  };
  return { code, message: map[response.status] ?? `HTTP ${response.status}` };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
