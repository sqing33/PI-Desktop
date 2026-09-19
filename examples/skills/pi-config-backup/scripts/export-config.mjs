/**
 * Export PI-Desktop configuration to a single JSON document.
 *
 * Usage:
 *   node export-config.mjs                       # -> Desktop/pi-desktop-backup-<ts>.json
 *   node export-config.mjs --out D:\backup\b.json
 *   node export-config.mjs --include-sessions     # add a session index (ids/titles only)
 *   node export-config.mjs --include-secrets      # NOT recommended; see --help below
 *
 * Data sources (read-only):
 *   <data>/pi.sqlite            app settings (kv), providers, projects
 *   <data>/plugins/registry.json installed plugins + granted permissions
 *   <data>/plugins/data/<id>/settings.json   per-plugin settings
 *   ~/.agents/subagents/*.md    subagent definitions
 *   ~/.agents/skills/<id>/SKILL.md  skill manifest (name/description/path)
 *   ~/.agents/servers/*.json    user MCP servers (redacted)
 *   ~/.pi/agent/AGENTS.md       global instructions
 *   ~/.pi/agent/settings.json   agent CLI settings
 *
 * Secrets are NEVER copied. Provider API keys and MCP server credentials are
 * replaced with "<redacted>"; the host's own settings store is not readable
 * from a backup by design.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";

const FORMAT = "pi-desktop-config-backup";
const SCHEMA_VERSION = 1;
const REDACTED = "<redacted>";

// ---------- helpers ----------
const home = homedir();
const dataDir = process.env.PI_DESKTOP_DATA_DIR
  ? resolve(process.env.PI_DESKTOP_DATA_DIR)
  : join(home, ".pi-desktop");
const agentsDir = join(home, ".agents");
const agentCfgDir = join(home, ".pi", "agent");

function parseArgs(argv) {
  const args = { out: "", includeSessions: false, pretty: true };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--out" || token === "-o") args.out = argv[++i] ?? "";
    else if (token === "--include-sessions") args.includeSessions = true;
    else if (token === "--pretty") args.pretty = true;
    else if (token === "--compact") args.pretty = false;
    else if (token === "--help" || token === "-h") args.help = true;
  }
  return args;
}

const USAGE = `PI-Desktop 配置导出

  node export-config.mjs [选项]

选项
  -o, --out <文件>     输出路径（默认写入桌面 pi-desktop-backup-<时间戳>.json）
      --include-sessions   附带会话索引（仅 id/标题/项目/时间，不含正文）
      --compact          输出单行 JSON（体积更小）
  -h, --help           显示本帮助

数据目录：${dataDir}
说明：API 密钥等敏感值一律写为 "${REDACTED}"，不会出现在备份中。
`;

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function listFiles(dir, filter) {
  try {
    return readdirSync(dir).filter((name) => !filter || filter(name));
  } catch {
    return [];
  }
}

function frontmatterOf(file) {
  try {
    const raw = readFileSync(file, "utf8").slice(0, 4000);
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!match) return {};
    const out = {};
    for (const line of match[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      let value = kv[2].trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      out[kv[1]] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function backupFileName(iso) {
  return `pi-desktop-backup-${String(iso).replace(/[:.]/g, "-")}.json`;
}

// ---------- collectors ----------
function collectAppSettings(db) {
  const row = db.prepare("SELECT value_json FROM kv WHERE ns='app' AND key='app'").get();
  if (!row) return {};
  try {
    return JSON.parse(row.value_json);
  } catch {
    return {};
  }
}

function collectProviders(db) {
  const rows = db
    .prepare(
      "SELECT id,name,vendor_key,type,protocol,api_style,base_url,enabled,default_model_id,config_json FROM providers ORDER BY id",
    )
    .all();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    vendorKey: row.vendor_key,
    type: row.type,
    protocol: row.protocol,
    apiStyle: row.api_style,
    baseUrl: row.base_url,
    enabled: !!row.enabled,
    defaultModelId: row.default_model_id,
    config: readJson(row.config_json, row.config_json ?? null),
    apiKey: REDACTED,
    secretRef: row.id,
  }));
}

function collectProjects(db) {
  return db
    .prepare("SELECT id,path,name,pinned,created_at,last_opened_at FROM projects ORDER BY id")
    .all()
    .map((row) => ({
      id: row.id,
      path: row.path,
      name: row.name,
      pinned: !!row.pinned,
      createdAt: row.created_at,
      lastOpenedAt: row.last_opened_at,
    }));
}

function collectPlugins() {
  const registry = readJson(join(dataDir, "plugins", "registry.json"), []);
  const list = Array.isArray(registry) ? registry : registry.runtime ?? [];
  const installed = list.map((p) => ({
    id: p.id,
    name: p.name,
    version: p.version,
    enabled: p.enabled !== false,
    source: p.source ?? null,
    permissions: Array.isArray(p.permissions) ? p.permissions : [],
  }));
  const settings = {};
  const dataRoot = join(dataDir, "plugins", "data");
  for (const id of listFiles(dataRoot)) {
    const file = join(dataRoot, id, "settings.json");
    if (!existsSync(file)) continue;
    const raw = readJson(file);
    if (!raw || typeof raw !== "object") continue;
    // The host reserves some keys; the rest is plugin-owned state.
    const { settings: _host, ...rest } = raw;
    if (Object.keys(rest).length) settings[id] = { values: rest };
  }
  return { installed, settings };
}

function collectSubagents() {
  const dir = join(agentsDir, "subagents");
  return listFiles(dir, (n) => n.endsWith(".md")).map((name) => {
    const file = join(dir, name);
    const meta = frontmatterOf(file);
    return { name: name.replace(/\.md$/, ""), model: meta.model ?? null, path: file };
  });
}

function collectSkills() {
  const dir = join(agentsDir, "skills");
  return listFiles(dir, (n) => !n.startsWith("."))
    .map((id) => {
      const file = join(dir, id, "SKILL.md");
      if (!existsSync(file)) return null;
      const meta = frontmatterOf(file);
      return {
        id,
        name: meta.name ?? id,
        description: meta.description ?? null,
        path: join(dir, id),
      };
    })
    .filter(Boolean);
}

function collectMcpServers() {
  const dir = join(agentsDir, "servers");
  return listFiles(dir, (n) => n.endsWith(".json")).map((name) => {
    const file = join(dir, name);
    const raw = readJson(file, {});
    const servers = raw.mcpServers ?? raw.servers ?? raw;
    const redact = (value) =>
      typeof value === "string" && /(?:secret|token|password|api[_-]?key)/i.test(value)
        ? REDACTED
        : value;
    // Redact credential-bearing header/env values regardless of shape.
    const redactMap = (map) =>
      map && typeof map === "object"
        ? Object.fromEntries(Object.entries(map).map(([k, v]) => [k, redact(String(v))]))
        : null;
    if (Array.isArray(servers)) {
      return {
        name,
        servers: servers.map((s) => ({
          id: s?.id ?? s?.name ?? null,
          command: s?.command ?? null,
          args: s?.args ?? null,
          url: s?.url ?? null,
          env: redactMap(s?.env),
          headers: redactMap(s?.headers),
        })),
      };
    }
    const entries = Object.entries(servers && typeof servers === "object" ? servers : {}).map(
      ([id, cfg]) => [
        id,
        cfg && typeof cfg === "object"
          ? { ...cfg, headers: redactMap(cfg.headers) ?? undefined, env: redactMap(cfg.env) ?? undefined }
          : cfg,
      ],
    );
    return { name, servers: Object.fromEntries(entries) };
  });
}

function collectInstructions() {
  const candidates = [
    join(agentCfgDir, "AGENTS.md"),
    join(home, ".pi", "AGENTS.md"),
    join(home, "AGENTS.md"),
  ];
  for (const file of candidates) {
    if (existsSync(file)) {
      return { global: readFileSync(file, "utf8"), source: file };
    }
  }
  return { global: null, source: null };
}

function collectSessionIndex(db) {
  try {
    return db
      .prepare("SELECT id,title,project_path,updated_at,created_at FROM sessions ORDER BY updated_at DESC LIMIT 500")
      .all()
      .map((s) => ({
        id: s.id,
        title: s.title,
        projectPath: s.project_path,
        updatedAt: s.updated_at,
        createdAt: s.created_at,
      }));
  } catch {
    return [];
  }
}

// ---------- main ----------
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const dbPath = join(dataDir, "pi.sqlite");
  if (!existsSync(dbPath)) {
    console.error(`找不到数据库：${dbPath}\n可用环境变量 PI_DESKTOP_DATA_DIR 覆盖数据目录。`);
    process.exit(1);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let backup;
  try {
    const settings = collectAppSettings(db);
    const providers = collectProviders(db);
    const projects = collectProjects(db);
    const sessions = args.includeSessions ? collectSessionIndex(db) : [];
    const plugins = collectPlugins();
    const sessionTotal = db.prepare("SELECT COUNT(*) AS c FROM sessions").get().c;
    db.close();

    const exportedAt = new Date().toISOString();
    backup = {
      format: FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportedAt,
      note: null,
      app: {
        platform: platform(),
        dataDir,
        dbFile: "pi.sqlite",
        sessionTotal,
      },
      data: {
        settings,
        providers,
        projects,
        plugins,
        subagents: collectSubagents(),
        skills: collectSkills(),
        mcpServers: collectMcpServers(),
        instructions: collectInstructions(),
        agentSettings: readJson(join(agentCfgDir, "settings.json")),
        sessions,
      },
      redactions: [
        ...providers.map((p) => `providers.${p.id}.apiKey`),
        ...collectMcpServers().map((s) => `mcpServers.${s.name}（凭证已脱敏）`),
      ],
      manual: [
        {
          item: "应用设置中主题以外的项",
          reason: "运行中的应用不应被外部脚本直接改写数据库",
          steps: ["打开设置，按 data.settings 逐项手动调整"],
        },
        {
          item: "Provider API 密钥与 OAuth 凭证",
          reason: "密钥存储在宿主的 secrets 区，脚本与备份都无法读取",
          steps: ["设置 → 模型提供商 → 手动重新添加并填写密钥"],
        },
        {
          item: "Skill 正文与 Subagent 全文",
          reason: "备份只记录清单与路径，正文文件体积大且可由仓库还原",
          steps: ["需要时单独复制 ~/.agents/skills 与 ~/.agents/subagents 目录"],
        },
      ],
      warnings: args.includeSessions
        ? [`已包含会话索引（最多 500 条，共 ${sessionTotal} 个会话），不含正文`]
        : [`未包含会话索引（共 ${sessionTotal} 个会话），需要时加 --include-sessions`],
    };
  } catch (error) {
    try { db.close(); } catch { /* already closed */ }
    console.error(`导出失败：${error?.message ?? error}`);
    process.exit(1);
  }

  const fileName = backupFileName(backup.exportedAt);
  const outFile = args.out
    ? resolve(args.out)
    : join(home, "Desktop", fileName);
  mkdirSync(dirnameSafe(outFile), { recursive: true });
  const text = args.pretty ? `${JSON.stringify(backup, null, 2)}\n` : JSON.stringify(backup);
  writeFileSync(outFile, text, "utf8");

  const counts = {
    settings: Object.keys(backup.data.settings).length,
    providers: backup.data.providers.length,
    projects: backup.data.projects.length,
    plugins: backup.data.plugins.installed.length,
    subagents: backup.data.subagents.length,
    skills: backup.data.skills.length,
    mcpServers: backup.data.mcpServers.length,
    instructions: backup.data.instructions.global ? 1 : 0,
    sessions: backup.data.sessions.length,
  };
  console.log(JSON.stringify({ ok: true, file: outFile, bytes: text.length, counts }, null, 2));
}

function dirnameSafe(p) {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx > 0 ? p.slice(0, idx) : ".";
}

main();
