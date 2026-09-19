/**
 * Upload / download / list PI-Desktop config backups on a WebDAV server.
 *
 * Uses Node's built-in fetch (Node 18+) and HTTP Basic auth — no curl, no
 * third-party dependency. Credentials come from environment variables or CLI
 * flags so nothing has to be written to disk by this script.
 *
 * Usage:
 *   node webdav.mjs list
 *   node webdav.mjs push <本地备份.json>
 *   node webdav.mjs pull <远端文件名> --out <本地文件.json>
 *   node webdav.mjs test
 *
 * Environment:
 *   WEBDAV_URL        服务根地址，例如 https://dav.example.com/remote.php/dav
 *   WEBDAV_USERNAME
 *   WEBDAV_PASSWORD
 *   WEBDAV_DIR         远端子目录，默认 pi-desktop-backup
 *
 * Flags override the environment: --url --user --pass --dir
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const action = args.find((a) => !a.startsWith("-")) ?? "test";
const positional = args.filter((a, i) => !a.startsWith("-") && !(i > 0 && args[i - 1].startsWith("-") && !["--out", "-o"].includes(args[i - 1])));
const flag = (name, fallback = "") => {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  const j = args.indexOf(`-${name}`);
  if (j >= 0 && args[j + 1] && !args[j + 1].startsWith("-")) return args[j + 1];
  return fallback;
};

const cfg = {
  url: (flag("url") || process.env.WEBDAV_URL || "").replace(/\/+$/, ""),
  user: flag("user") || process.env.WEBDAV_USERNAME || "",
  pass: flag("pass") || process.env.WEBDAV_PASSWORD || "",
  dir: (flag("dir") || process.env.WEBDAV_DIR || "pi-desktop-backup").replace(/^\/+|\/+$/g, ""),
  out: flag("out", ""),
};

const USAGE = `WebDAV 配置备份同步

  node webdav.mjs test                       测试连接与目录
  node webdav.mjs list                       列出远端备份
  node webdav.mjs push <本地.json>            上传备份
  node webdav.mjs pull <远端文件名> [-o 本地]  下载备份

配置来源：--url/--user/--pass/--dir 参数，或环境变量
WEBDAV_URL / WEBDAV_USERNAME / WEBDAV_PASSWORD / WEBDAV_DIR
`;

function authHeaders(extra = {}) {
  const raw = `${cfg.user}:${cfg.pass}`;
  return {
    Authorization: `Basic ${Buffer.from(raw, "utf8").toString("base64")}`,
    "User-Agent": "PI-Desktop-Config-Backup/1",
    ...extra,
  };
}

async function req(method, path, init = {}) {
  return fetch(`${cfg.url}/${path}`, {
    method,
    headers: authHeaders(init.headers),
    ...init,
    redirect: "follow",
  });
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function requireConfig() {
  if (!cfg.url) fail("缺少 WebDAV 地址：请设置 WEBDAV_URL 或 --url");
  if (!cfg.user) fail("缺少 WebDAV 用户名：请设置 WEBDAV_USERNAME 或 --user");
}

function describeStatus(status) {
  switch (status) {
    case 401: return "认证失败：请检查用户名与密码";
    case 403: return "权限不足：该账号可能没有读写权限";
    case 404: return "路径不存在：请检查 WebDAV 地址与目录名";
    case 405: return "该服务器不支持所需的 WebDAV 方法";
    case 409: return "远端已存在同名文件";
    case 413:
    case 507: return "远端存储空间不足";
    default: return `服务器返回 ${status}`;
  }
}

async function ensureDir() {
  // WebDAV servers usually auto-create on PUT; PROPFIND the directory to check.
  const res = await req("PROPFIND", cfg.dir, { headers: { Depth: "0" } });
  if (res.status === 404) {
    await req("MKCOL", cfg.dir);
    return;
  }
  if (!res.ok) fail(`目录检查失败：${describeStatus(res.status)}`);
}

async function listRemote() {
  const res = await req("PROPFIND", cfg.dir, { headers: { Depth: "1" } });
  if (res.status === 404) return [];
  if (!res.ok) fail(`列举失败：${describeStatus(res.status)}`);
  const xml = await res.text();
  const files = [];
  for (const match of xml.matchAll(/<[^>]*:?href>([^<]+)<\//gi)) {
    const name = decodeURIComponent(match[1].split("/").filter(Boolean).at(-1) ?? "");
    if (!name.endsWith(".json")) continue;
    const stamp = /<(?:[^>]*:)?(?:get)?lastmodified>([^<]+)</i.exec(xml.slice(match.index, match.index + 800));
    files.push({ name, modifiedAt: stamp ? stamp[1] : null });
  }
  files.sort((a, b) => Date.parse(b.modifiedAt ?? 0) - Date.parse(a.modifiedAt ?? 0));
  return files;
}

async function main() {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  requireConfig();

  if (action === "test") {
    const res = await req("PROPFIND", cfg.dir, { headers: { Depth: "0" } });
    if (res.ok) console.log(JSON.stringify({ ok: true, status: res.status, url: cfg.url, dir: cfg.dir }, null, 2));
    else fail(`连接失败：${describeStatus(res.status)}`);
    return;
  }

  if (action === "list") {
    const files = await listRemote();
    console.log(JSON.stringify({ count: files.length, files }, null, 2));
    return;
  }

  if (action === "push") {
    const local = positional[0];
    if (!local) fail("用法：node webdav.mjs push <本地备份.json>");
    if (!existsSync(resolve(local))) fail(`本地文件不存在：${local}`);
    const content = readFileSync(resolve(local), "utf8");
    await ensureDir();
    const res = await req("PUT", `${cfg.dir}/${local.split(/[/\\]/).at(-1)}`, {
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: content,
    });
    if (res.ok) console.log(JSON.stringify({ ok: true, status: res.status, bytes: content.length, file: local.split(/[/\\]/).at(-1) }, null, 2));
    else fail(`上传失败：${describeStatus(res.status)}`);
    return;
  }

  if (action === "pull") {
    const remoteName = positional[0];
    if (!remoteName) fail("用法：node webdav.mjs pull <远端文件名> [-o <本地文件>]");
    const res = await req("GET", `${cfg.dir}/${remoteName}`);
    if (!res.ok) fail(`下载失败：${describeStatus(res.status)}`);
    const content = await res.text();
    const outFile = resolve(cfg.out || join(homedir(), "Desktop", remoteName));
    mkdirSync(outFile.slice(0, Math.max(outFile.lastIndexOf("/"), outFile.lastIndexOf("\\"))) || ".", { recursive: true });
    writeFileSync(outFile, content, "utf8");
    console.log(JSON.stringify({ ok: true, file: outFile, bytes: content.length }, null, 2));
    return;
  }

  fail(`未知操作：${action}\n\n${USAGE}`);
}

main();
