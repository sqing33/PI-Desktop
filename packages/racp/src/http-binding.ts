import { createReadStream } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { extname, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { RACP_WS_PATH, RACP_WS_SUBPROTOCOL, type RacpRole } from "@pi-desktop/shared";
import { WebSocket, WebSocketServer } from "ws";

import { type ConnectionAuth, type DeviceTokenAuthenticator } from "./auth.js";
import type { RacpServer, ServerConnectionTransport } from "./server.js";

/** Cookie name the browser profile uses for its session id. */
export const RACP_WEB_SESSION_COOKIE = "pi_web_session";

/** Roles a web browser session may hold; `owner` is never granted (security §3.4). */
export const RACP_WEB_ROLES: readonly RacpRole[] = ["viewer", "controller", "approver"];

const LOGIN_PATH = "/v1/racp/auth/login";
const LOGOUT_PATH = "/v1/racp/auth/logout";
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const MAX_LOGIN_BODY_BYTES = 4_096;
const LOGIN_RATE_LIMIT = 10;
const LOGIN_RATE_WINDOW_MS = 60_000;

export type HttpBindingOptions = {
  server: RacpServer;
  authenticator: DeviceTokenAuthenticator;
  /** Bind address; the web profile is meant for browsers on other machines, so any host is allowed. */
  host?: string;
  port: number;
  /** Static web assets (Vite build output); when absent every GET is 404. */
  webRoot?: string | null;
  /** Cookie session lifetime; defaults to 7 days. */
  sessionTtlMs?: number;
  log: (level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>) => void;
  heartbeatMs?: number;
};

export type HttpBinding = {
  address: { host: string; port: number };
  close(): Promise<void>;
};

type WebSession = {
  auth: ConnectionAuth;
  deviceToken: string;
  expiresAt: number;
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** Local copy of the ws transport adapter (`ws-binding.ts` keeps its own private one). */
function wsTransport(socket: WebSocket): ServerConnectionTransport {
  return {
    send: (frame) => socket.send(frame),
    close: (code, reason) => socket.close(code, reason),
    onMessage: (handler) => {
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          socket.close(1003, "binary frames are not accepted");
          return;
        }
        const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8");
        handler(text, Buffer.byteLength(text, "utf8"));
      });
    },
    onClose: (handler) => {
      socket.once("close", handler);
      socket.once("error", () => handler());
    },
  };
}

function parseSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== RACP_WEB_SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), ...headers });
  response.end(payload);
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<{ ok: true; body: unknown } | { ok: false; reason: "too-large" | "invalid" }> {
  const declared = Number(request.headers["content-length"] ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too-large" };
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    received += buffer.byteLength;
    if (received > maxBytes) return { ok: false, reason: "too-large" };
    chunks.push(buffer);
  }
  if (chunks.length === 0) return { ok: false, reason: "invalid" };
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/**
 * Serve `webRoot` with path-traversal protection: the resolved real path must
 * stay inside the real `webRoot` (prefix check with a separator boundary).
 */
async function serveStatic(webRoot: string, pathname: string, response: ServerResponse): Promise<void> {
  if (pathname.includes("\0") || pathname.includes("..")) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not Found");
    return;
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (relative.length === 0 || relative.endsWith("/")) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not Found");
    return;
  }
  const realRoot = await realpath(webRoot).catch(() => null);
  if (!realRoot) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not Found");
    return;
  }
  const candidate = resolve(realRoot, relative);
  if (candidate !== realRoot && !candidate.startsWith(realRoot + sep)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not Found");
    return;
  }
  const realFile = await realpath(candidate).catch(() => null);
  if (!realFile || (realFile !== realRoot && !realFile.startsWith(realRoot + sep))) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not Found");
    return;
  }
  const type = CONTENT_TYPES[extname(realFile).toLowerCase()];
  if (!type) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not Found");
    return;
  }
  response.writeHead(200, { "Content-Type": type });
  await pipelineFile(realFile, response);
}

function pipelineFile(file: string, response: ServerResponse): Promise<void> {
  return new Promise((resolvePromise) => {
    const stream = createReadStream(file);
    stream.on("error", () => {
      if (!response.headersSent) response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end();
      resolvePromise();
    });
    response.on("close", () => {
      stream.destroy();
      resolvePromise();
    });
    stream.pipe(response);
    stream.on("end", () => resolvePromise());
  });
}

/**
 * Bind the RACP server to an HTTP listener for browsers (spec §11.1 cookie
 * profile): `POST /v1/racp/auth/login` exchanges a device or pairing token for
 * an HttpOnly session cookie, `GET /v1/racp/ws` upgrades after resolving that
 * cookie, and `webRoot` (when present) serves the web client. Unlike the
 * loopback ws-binding, peers are not restricted to loopback: the security
 * posture is the cookie session plus the host opting in by binding this at all.
 */
export async function bindRacpHttp(options: HttpBindingOptions): Promise<HttpBinding> {
  const host = options.host ?? "127.0.0.1";
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const webRoot = options.webRoot ?? null;
  const sessions = new Map<string, WebSession>();
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();
  const sockets = new Set<WebSocket>();

  const pruneSessions = () => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now) sessions.delete(id);
    }
  };

  const issueSession = (auth: ConnectionAuth, deviceToken: string): { cookieId: string; subject: string; roles: RacpRole[] } => {
    pruneSessions();
    const cookieId = randomBytes(24).toString("base64url");
    const roles = [...RACP_WEB_ROLES];
    sessions.set(cookieId, {
      auth: { ...auth, principal: { ...auth.principal, roles, pairedDevice: false } },
      deviceToken,
      expiresAt: Date.now() + sessionTtlMs,
    });
    return { cookieId, subject: auth.principal.subject, roles };
  };

  const takeLoginAttempt = (ip: string): boolean => {
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (!entry || entry.resetAt <= now) {
      loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_RATE_WINDOW_MS });
      return true;
    }
    entry.count += 1;
    return entry.count <= LOGIN_RATE_LIMIT;
  };

  const handleLogin = async (request: IncomingMessage, response: ServerResponse, ip: string): Promise<void> => {
    if (!takeLoginAttempt(ip)) {
      sendError(response, 429, "RATE_LIMITED", "too many login attempts; retry in a minute");
      return;
    }
    const parsed = await readJsonBody(request, MAX_LOGIN_BODY_BYTES);
    if (!parsed.ok) {
      if (parsed.reason === "too-large") sendError(response, 413, "PAYLOAD_TOO_LARGE", "login body exceeds 4KB");
      else sendError(response, 400, "INVALID_ARGUMENT", "login body must be JSON: { token: string }");
      return;
    }
    const token = (parsed.body as { token?: unknown } | null)?.token;
    if (typeof token !== "string" || token.length === 0 || token.length > 512) {
      sendError(response, 400, "INVALID_ARGUMENT", "login body must be JSON: { token: string }");
      return;
    }
    const auth = await options.authenticator.authenticateToken(token, "web-login");
    if (!auth) {
      options.log("warn", "racp web login refused", { peer: ip });
      sendError(response, 401, "UNAUTHORIZED", "the token is unknown, expired, or revoked");
      return;
    }
    let sessionAuth: ConnectionAuth = auth;
    let deviceToken = token;
    if (auth.kind === "pairing") {
      let paired: { deviceId: string; token: string };
      try {
        paired = await options.authenticator.pair(auth.tokenHash, "web-browser", [...RACP_WEB_ROLES]);
      } catch (error) {
        const code = (error as { errorCode?: string })?.errorCode ?? "PAIRING_FAILED";
        options.log("warn", "racp web pairing failed", { code, peer: ip });
        sendError(response, 401, "UNAUTHORIZED", "the pairing token could not be exchanged");
        return;
      }
      deviceToken = paired.token;
      // Re-authenticate the minted token so the session carries the device principal, not the pairing one.
      const deviceAuth = await options.authenticator.authenticateToken(deviceToken, "web-login");
      if (!deviceAuth || deviceAuth.kind !== "device") {
        sendError(response, 401, "UNAUTHORIZED", "the paired device credential is not usable");
        return;
      }
      sessionAuth = deviceAuth;
    }
    const issued = issueSession(sessionAuth, deviceToken);
    const maxAge = Math.max(1, Math.floor(sessionTtlMs / 1000));
    options.log("info", "racp web session issued", { subject: issued.subject, peer: ip });
    sendJson(
      response,
      200,
      { ok: true, subject: issued.subject, roles: issued.roles },
      {
        "Set-Cookie": `${RACP_WEB_SESSION_COOKIE}=${issued.cookieId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
        "Cache-Control": "no-store",
      },
    );
  };

  const handleLogout = (request: IncomingMessage, response: ServerResponse): void => {
    const cookieId = parseSessionCookie(request.headers.cookie);
    if (cookieId && sessions.delete(cookieId)) {
      options.log("info", "racp web session cleared", { peer: request.socket.remoteAddress });
    }
    sendJson(
      response,
      200,
      { ok: true },
      { "Set-Cookie": `${RACP_WEB_SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`, "Cache-Control": "no-store" },
    );
  };

  const http: Server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (request.method === "POST" && url.pathname === LOGIN_PATH) {
          await handleLogin(request, response, request.socket.remoteAddress ?? "unknown");
          return;
        }
        if (request.method === "POST" && url.pathname === LOGOUT_PATH) {
          handleLogout(request, response);
          return;
        }
        if (request.method === "GET" || request.method === "HEAD") {
          if (!webRoot) {
            response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            response.end("Not Found");
            return;
          }
          await serveStatic(webRoot, url.pathname, response);
          return;
        }
        response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Method Not Allowed");
      } catch (error) {
        options.log("error", "racp http request failed", { error: String(error) });
        if (!response.headersSent) sendError(response, 500, "INTERNAL", "internal error");
        else response.end();
      }
    })();
  });

  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has(RACP_WS_SUBPROTOCOL) ? RACP_WS_SUBPROTOCOL : false) });

  http.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const reject = (status: number, reason: string) => {
        options.log("warn", "racp web upgrade refused", { reason, peer: request.socket.remoteAddress });
        socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      };
      if (url.pathname !== RACP_WS_PATH) return reject(404, "Not Found");
      const urlHasToken = [...url.searchParams.keys()].some((key) => /token|auth/i.test(key));
      if (urlHasToken) return reject(401, "Unauthorized");
      pruneSessions();
      const cookieId = parseSessionCookie(request.headers.cookie);
      const session = cookieId ? sessions.get(cookieId) : undefined;
      if (!session) return reject(401, "Unauthorized");
      wss.handleUpgrade(request, socket, head, (ws) => {
        sockets.add(ws);
        ws.once("close", () => sockets.delete(ws));
        const connection = options.server.accept(session.auth, wsTransport(ws));
        if (!connection) return;
        // Heartbeat (spec §11.1): a peer that stops answering pings is dropped.
        let alive = true;
        ws.on("pong", () => {
          alive = true;
        });
        const heartbeat = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (!alive) {
            ws.terminate();
            return;
          }
          alive = false;
          ws.ping();
        }, heartbeatMs);
        heartbeat.unref?.();
        ws.once("close", () => clearInterval(heartbeat));
      });
    })().catch((error) => {
      options.log("error", "racp web upgrade failed", { error: String(error) });
      socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  options.log("info", "racp web listening", { host, port, webRoot: webRoot ?? null });
  return {
    address: { host, port },
    close: async () => {
      for (const ws of sockets) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      sessions.clear();
      loginAttempts.clear();
    },
  };
}
