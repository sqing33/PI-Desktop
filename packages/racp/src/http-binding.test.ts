import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { RACP_WS_SUBPROTOCOL } from "@pi-desktop/shared";

import { RacpClient } from "./client.js";
import { bindRacpHttp, type HttpBinding } from "./http-binding.js";
import { OWNER_TOKEN, harness } from "./test-harness.js";

const bindings: HttpBinding[] = [];
const webRoots: string[] = [];

async function startBinding(): Promise<{ binding: HttpBinding; base: string; h: Awaited<ReturnType<typeof harness>> }> {
  const h = await harness();
  const binding = await bindRacpHttp({ server: h.server, authenticator: h.authenticator, port: 0, log: () => undefined, heartbeatMs: 60_000 });
  return { binding, base: `http://127.0.0.1:${binding.address.port}`, h };
}

type LoginResult = { status: number; body: { ok?: boolean; subject?: string; roles?: string[]; error?: { code: string; message: string } }; setCookie: string[] };

function login(base: string, token: string): Promise<LoginResult> {
  return fetch(`${base}/v1/racp/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).then(async (response) => ({ status: response.status, body: await response.json(), setCookie: response.headers.getSetCookie() }));
}

function cookieValue(setCookie: string[]): string {
  const entry = setCookie.find((line) => line.startsWith("pi_web_session="));
  expect(entry).toBeTruthy();
  return entry!.split(";")[0]!;
}

function wsStatus(url: string, headers: Record<string, string> = {}): Promise<number | "open"> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, [RACP_WS_SUBPROTOCOL], { headers, handshakeTimeout: 5_000 });
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.once("open", () => {
      resolve("open");
      socket.close();
    });
    socket.once("error", () => resolve(0));
  });
}

afterEach(async () => {
  while (bindings.length > 0) await bindings.pop()!.close();
});

afterAll(async () => {
  for (const root of webRoots) await rm(root, { recursive: true, force: true });
});

describe("RACP web HTTP binding", () => {
  it("refuses a login with a garbage token", async () => {
    const { base } = await startBinding();
    const result = await login(base, "pdt1.not-a-real-token");
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe("UNAUTHORIZED");
  });

  it("refuses a malformed login body", async () => {
    const { base } = await startBinding();
    const response = await fetch(`${base}/v1/racp/auth/login`, { method: "POST", body: "nope" });
    expect(response.status).toBe(400);
    const oversized = await fetch(`${base}/v1/racp/auth/login`, { method: "POST", body: JSON.stringify({ token: "x".repeat(8_192) }) });
    expect(oversized.status).toBe(413);
  });

  it("logs in an owner device token but never grants the owner role", async () => {
    const { base } = await startBinding();
    const result = await login(base, OWNER_TOKEN);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.subject).toBe("dev_owner");
    // Security: a web browser session never holds `owner`, even when the token does.
    expect(result.body.roles).not.toContain("owner");
    expect((result.body.roles as string[]).sort()).toEqual(["approver", "controller", "viewer"]);
    const cookie = cookieValue(result.setCookie);
    expect(cookie.startsWith("pi_web_session=")).toBe(true);
    expect(result.setCookie.some((line) => line.includes("HttpOnly") && line.includes("SameSite=Strict"))).toBe(true);
  });

  it("exchanges a pairing token for a downgraded web session", async () => {
    const { base, h } = await startBinding();
    const pairing = await h.authenticator.issuePairingToken(10 * 60 * 1000);
    const result = await login(base, pairing.token);
    expect(result.status).toBe(200);
    expect(result.body.roles).toEqual(["viewer", "controller", "approver"]);
    expect(result.body.roles).not.toContain("owner");
    // The pairing token is single-use: a second exchange is refused.
    const replay = await login(base, pairing.token);
    expect(replay.status).toBe(401);
  });

  it("clears the session on logout and then refuses the websocket", async () => {
    const { base } = await startBinding();
    const result = await login(base, OWNER_TOKEN);
    const cookie = cookieValue(result.setCookie);
    const logout = await fetch(`${base}/v1/racp/auth/logout`, { method: "POST", headers: { Cookie: cookie } });
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ ok: true });
    expect(logout.headers.getSetCookie().some((line) => line.includes("Max-Age=0"))).toBe(true);
    expect(await wsStatus(`ws://127.0.0.1:${new URL(base).port}/v1/racp/ws`, { Cookie: cookie })).toBe(401);
  });

  it("refuses the websocket without a cookie, with a bad cookie, or on a wrong path", async () => {
    const { base } = await startBinding();
    const port = new URL(base).port;
    expect(await wsStatus(`ws://127.0.0.1:${port}/v1/racp/ws`)).toBe(401);
    expect(await wsStatus(`ws://127.0.0.1:${port}/v1/racp/ws`, { Cookie: "pi_web_session=unknown-cookie-id" })).toBe(401);
    expect(await wsStatus(`ws://127.0.0.1:${port}/elsewhere`, { Cookie: "pi_web_session=whatever" })).toBe(404);
  });

  it("upgrades with a valid cookie and completes connection/initialize", async () => {
    const { base } = await startBinding();
    const result = await login(base, OWNER_TOKEN);
    const cookie = cookieValue(result.setCookie);
    const port = new URL(base).port;
    expect(await wsStatus(`ws://127.0.0.1:${port}/v1/racp/ws`, { Cookie: cookie })).toBe("open");

    const client = new RacpClient({
      transport: () =>
        new Promise((resolve, reject) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/racp/ws`, [RACP_WS_SUBPROTOCOL], {
            headers: { Cookie: cookie },
            handshakeTimeout: 5_000,
          });
          socket.once("open", () =>
            resolve({
              send: (frame) => socket.send(frame),
              close: (code, reason) => socket.close(code ?? 1000, reason),
              onMessage: (handler) => {
                socket.on("message", (data, isBinary) => {
                  if (isBinary) return;
                  handler(typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.concat(data as Buffer[]).toString("utf8"));
                });
              },
              onClose: (handler) => socket.once("close", (code, reason) => handler({ code, reason: reason.toString() })),
              onError: () => undefined,
            }),
          );
          socket.once("error", (error) => reject(error));
          socket.once("unexpected-response", (_request, response) => {
            reject(new Error(`upgrade refused: ${response.statusCode}`));
            socket.terminate();
          });
        }),
      client: { name: "web-test", version: "0.15.0" },
      requestTimeoutMs: 5_000,
    });
    try {
      const init = await client.connect();
      expect(init.server.hostId).toBe("host_test");
      expect(init.capabilities.eventReplay).toBe(true);
      // The initialize result reflects the downgraded web principal.
      expect(init.principal.roles).not.toContain("owner");
      expect(init.principal.roles.sort()).toEqual(["approver", "controller", "viewer"]);
    } finally {
      await client.close();
    }
  });

  it("rate-limits repeated logins from one IP", async () => {
    const { base } = await startBinding();
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await fetch(`${base}/v1/racp/auth/login`, { method: "POST", body: JSON.stringify({ token: "pdt1.garbage" }) });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 401));
    expect(statuses[10]).toBe(429);
  });

  it("serves index.html from webRoot and 404s elsewhere", async () => {
    const h = await harness();
    const root = await mkdtemp(join(tmpdir(), "racp-web-"));
    webRoots.push(root);
    await writeFile(join(root, "index.html"), "<!doctype html><title>pi web</title>", "utf8");
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "app.js"), "console.log('ok')", "utf8");
    const binding = await bindRacpHttp({ server: h.server, authenticator: h.authenticator, port: 0, webRoot: root, log: () => undefined });
    bindings.push(binding);
    const base = `http://127.0.0.1:${binding.address.port}`;

    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("pi web");

    const script = await fetch(`${base}/assets/app.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");

    expect((await fetch(`${base}/missing.png`)).status).toBe(404);

    // Path traversal must not escape webRoot.
    const escape = await fetch(`${base}/../package.json`);
    expect(escape.status).toBe(404);
    const escaped = await fetch(`${base}/%2e%2e/package.json`);
    expect(escaped.status).toBe(404);
  });

  it("returns 404 for every GET when webRoot is not configured", async () => {
    const { base } = await startBinding();
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/anything.js`)).status).toBe(404);
  });
});
