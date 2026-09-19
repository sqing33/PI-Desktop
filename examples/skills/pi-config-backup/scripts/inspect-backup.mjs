/**
 * Inspect a PI-Desktop config backup and produce a restore report.
 *
 * This script NEVER writes to the application. It compares a backup against the
 * live configuration and prints:
 *   - what differs
 *   - what can be restored automatically (and how)
 *   - what must be done by hand
 *
 * Usage:
 *   node inspect-backup.mjs <备份文件.json> [--json]
 *
 * Restore policy: the running application owns its database and settings store,
 * so the script deliberately refuses to write them. Automatic items are limited
 * to plain files under the agent config directory (e.g. global AGENTS.md), which
 * the agent can apply with its own file tools after the user confirms.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const home = homedir();
const dataDir = process.env.PI_DESKTOP_DATA_DIR
  ? resolve(process.env.PI_DESKTOP_DATA_DIR)
  : join(home, ".pi-desktop");
const agentCfgDir = join(home, ".pi", "agent");
const FORMAT = "pi-desktop-config-backup";

function parseArgs(argv) {
  return { file: argv[0] ?? "", json: argv.includes("--json") };
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function diffSettings(backup, live) {
  const changes = [];
  for (const [key, value] of Object.entries(backup ?? {})) {
    if (!same(value, live?.[key])) {
      changes.push({ key, backup: value, current: live?.[key] ?? null });
    }
  }
  return changes;
}

function diffLists(backupList, liveList, keyOf = (x) => x?.id ?? x?.path ?? x?.name ?? null) {
  const liveMap = new Map((liveList ?? []).map((item) => [keyOf(item), item]));
  const added = [];
  const changed = [];
  for (const item of backupList ?? []) {
    const key = keyOf(item);
    const current = liveMap.get(key);
    if (!current) added.push({ key, item });
    else if (!same(item, current)) changed.push({ key, backup: item, current });
  }
  const backupKeys = new Set((backupList ?? []).map(keyOf));
  const removed = (liveList ?? []).filter((item) => !backupKeys.has(keyOf(item))).map(keyOf);
  return { added, changed, removed };
}

function currentState() {
  const state = { settings: {}, providers: [], projects: [], plugins: [], subagents: [], skills: [], instructions: null, errors: [] };
  const dbPath = join(dataDir, "pi.sqlite");
  if (!existsSync(dbPath)) {
    state.errors.push(`找不到数据库 ${dbPath}（可用 PI_DESKTOP_DATA_DIR 覆盖）`);
    return state;
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const app = db.prepare("SELECT value_json FROM kv WHERE ns='app' AND key='app'").get();
    state.settings = app ? readJson(JSON.parse(app.value_json), {}) : {};
    state.providers = db.prepare("SELECT id,name,base_url,enabled,vendor_key,default_model_id FROM providers").all();
    state.projects = db.prepare("SELECT id,path,name,pinned FROM projects").all();
  } catch (error) {
    state.errors.push(`读取当前配置失败：${error?.message ?? error}`);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  const registry = readJson(join(dataDir, "plugins", "registry.json"), []);
  const list = Array.isArray(registry) ? registry : registry.runtime ?? [];
  state.plugins = list.map((p) => ({ id: p.id, name: p.name, version: p.version, enabled: p.enabled !== false }));
  return state;
}


function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file || args.file === "--json") {
    console.error("用法：node inspect-backup.mjs <备份文件.json> [--json]");
    process.exit(1);
  }
  const backupPath = resolve(args.file);
  const raw = readJson(backupPath);
  if (!raw) {
    console.error(`无法读取或解析备份：${backupPath}`);
    process.exit(1);
  }
  if (raw.format !== FORMAT) {
    console.error(`不是 PI-Desktop 配置备份（format=${JSON.stringify(raw.format)}）`);
    process.exit(1);
  }
  if (Number(raw.schemaVersion) !== 1) {
    console.error(`暂不支持的备份版本：${raw.schemaVersion}`);
    process.exit(1);
  }

  const data = raw.data ?? {};
  const live = currentState();

  const report = {
    backup: { file: backupPath, exportedAt: raw.exportedAt ?? null, schemaVersion: raw.schemaVersion },
    current: { dataDir, readErrors: live.errors },
    diff: {
      settings: diffSettings(data.settings, live.settings),
      providers: diffLists(data.providers, live.providers, (p) => p?.id ?? null),
      projects: diffLists(data.projects, live.projects, (p) => p?.path ?? null),
      plugins: diffLists(data.plugins?.installed, live.plugins, (p) => p?.id ?? null),
      subagents: diffLists(data.subagents, [], (p) => p?.name ?? null),
      skills: diffLists(data.skills, [], (p) => p?.id ?? null),
      mcpServers: diffLists(data.mcpServers, [], (p) => p?.name ?? null),
      instructionsChanged:
        typeof data.instructions?.global === "string" &&
        !same(data.instructions.global, null),
    },
    auto: [],
    manual: [...(Array.isArray(raw.manual) ? raw.manual : [])],
  };

  // Automatic restore candidates.
  for (const change of report.diff.settings) {
    if (change.key === "theme") {
      report.auto.push({
        item: `主题 -> ${change.backup}`,
        how: "在设置 → 外观/主题中选择，或用 Agent 的 setTheme 能力切换",
      });
    } else {
      report.manual.push({
        item: `应用设置 ${change.key}`,
        reason: "运行中的应用不应被外部脚本直接改写数据库",
        steps: [`打开设置，将 ${change.key} 调整为 ${JSON.stringify(change.backup)}`],
      });
    }
  }
  if (typeof data.instructions?.global === "string" && data.instructions.source) {
    report.auto.push({
      item: "全局 AGENTS.md 指令",
      how: `用文件工具覆盖写入 ${data.instructions.source}（先确认用户同意）`,
    });
  }
  for (const item of report.diff.providers.added) {
    report.manual.push({ item: `新增 Provider ${item.key}`, reason: "需在设置中手工添加并填写 API 密钥", steps: ["设置 → 模型提供商 → 新增"] });
  }
  for (const item of report.diff.plugins.added) {
    report.manual.push({ item: `插件 ${item.key}`, reason: "需在 Plugins 页安装", steps: ["Plugins 页按清单安装"] });
  }
  for (const item of report.diff.subagents.added) {
    report.manual.push({ item: `Subagent ${item.key}`, reason: "需复制定义文件", steps: [`将 ${item.item.path} 复制到 ~/.agents/subagents/`] });
  }
  for (const item of report.diff.skills.added) {
    report.manual.push({ item: `Skill ${item.key}`, reason: "需复制技能目录", steps: [`将 ${item.item.path} 复制到 ~/.agents/skills/`] });
  }
  for (const item of report.diff.mcpServers.added) {
    report.manual.push({ item: `MCP 服务器组 ${item.key}`, reason: "需复制配置文件并补齐凭证", steps: ["复制对应 json 到 ~/.agents/servers/"] });
  }

  const total =
    report.diff.settings.length +
    Object.values(report.diff).reduce((sum, v) => {
      if (!v || !Array.isArray(v.added)) return sum;
      return sum + v.added.length + v.changed.length + v.removed.length;
    }, 0);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`备份：${report.backup.file}`);
  console.log(`导出时间：${report.backup.exportedAt ?? "未知"}`);
  console.log(`当前数据目录：${dataDir}`);
  if (live.errors.length) console.log(`读取警告：${live.errors.join("；")}`);
  console.log(`\n差异合计：${total} 处\n`);

  console.log("== 可自动恢复 ==");
  if (!report.auto.length) console.log("（无）");
  for (const item of report.auto) console.log(` - ${item.item}\n     方式：${item.how}`);

  console.log("\n== 需手动处理 ==");
  if (!report.manual.length) console.log("（无）");
  for (const item of report.manual) {
    console.log(` - ${item.item}${item.reason ? `（${item.reason}）` : ""}`);
    for (const step of item.steps ?? []) console.log(`     · ${step}`);
  }

  console.log("\n注意：本脚本不修改任何运行中的应用数据；请在确认后再逐项执行上述操作。");
}

main();
