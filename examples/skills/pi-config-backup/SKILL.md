---
name: pi-config-backup
version: 1.0.0
description: "PI-Desktop 配置备份与迁移：把应用设置、Provider、项目、插件、Subagent、Skill、MCP 与全局指令导出为 JSON 备份，对比检查差异并给出恢复清单，支持与 WebDAV 同步。当用户要备份/导出/恢复/迁移 PI-Desktop 配置，或要查看当前配置差异、把配置同步到网盘时使用。不负责备份会话正文与 API 密钥。"
---

# PI-Desktop 配置备份

用本 skill 自带的脚本完成配置备份与恢复检查，**不要临场重写采集逻辑**——脚本已针对真实数据布局验证过。

## 脚本位置

本 skill 目录下的 `scripts/`，三个都是零依赖 Node 脚本（需要 **Node 22.5+**，用内置 `node:sqlite` 读数据库）：

| 脚本 | 用途 |
| --- | --- |
| `export-config.mjs` | 导出当前配置为 JSON |
| `inspect-backup.mjs` | 对比备份与当前配置，输出恢复报告（只读） |
| `webdav.mjs` | WebDAV 上传/下载/列举（Node 内置 fetch + Basic 认证） |

在本 skill 目录执行，或用绝对路径调用。

## 1. 导出

```bash
node scripts/export-config.mjs                       # 默认写到桌面
node scripts/export-config.mjs --out D:\backup\b.json
node scripts/export-config.mjs --include-sessions     # 附带会话索引（不含正文）
```

采集内容：应用设置、Provider（**密钥脱敏**）、项目、已装插件及各自设置、Subagent 清单、Skill 清单、MCP 服务器配置（凭证脱敏）、全局 AGENTS.md、Agent 设置。会话正文**不采集**。

输出 JSON 结构：`{ format: "pi-desktop-config-backup", schemaVersion: 1, data: {...}, manual: [...], warnings: [...] }`。

**执行后必须向用户报告**：文件路径、各分区条目数、以及 `redactions`/`manual` 的要点。备份是**明文**，提醒用户自行保管存放位置。

## 2. 检查差异（恢复前必做）

```bash
node scripts/inspect-backup.mjs <备份文件.json>
node scripts/inspect-backup.mjs <备份文件.json> --json    # 机器可读
```

脚本**只读**，绝不改写运行中的数据库。输出分为「可自动恢复」和「需手动处理」两段。

拿到报告后：
1. 先把差异摘要告诉用户，**等确认再动手**。
2. 「可自动恢复」项：主题类走设置或 Agent 的 setTheme 能力；全局 AGENTS.md 可用你的文件工具写入，但覆盖前必须先确认。
3. 「需手动处理」项：把步骤转述给用户，让他们自己在应用里操作。

## 3. WebDAV 同步

凭据通过环境变量或参数传入，**不要把密码写进任何文件**：

```bash
export WEBDAV_URL="https://dav.example.com/remote.php/dav"
export WEBDAV_USERNAME="you"
export WEBDAV_PASSWORD="..."        # 或每次用 --pass 临时传入
export WEBDAV_DIR="pi-desktop-backup"

node scripts/webdav.mjs test                    # 先测连接
node scripts/webdav.mjs list
node scripts/webdav.mjs push <本地备份.json>
node scripts/webdav.mjs pull <远端文件名> --out <本地.json>
```

典型流程：导出 → `push` 到网盘；换机器时 `list` → `pull` → `inspect-backup` → 按清单恢复。

## 能力边界（必须如实告知用户）

- **API 密钥无法备份**：宿主把密钥存在独立的 secrets 区，外部脚本与本流程都读不到，备份里是 `<redacted>`。恢复后需手动重填。
- **应用设置不可脚本写回**：运行中的应用持有数据库与设置存储，不要尝试直接改写。`settings.set` 对插件/脚本都不可用。
- **Skill 与 Subagent 只存清单与路径**，正文需用户另行复制 `~/.agents/skills`、`~/.agents/subagents` 目录。
- 会话正文不采集；`--include-sessions` 也只有 id/标题/项目/时间。
- 数据目录默认 `~/.pi-desktop`，可用 `PI_DESKTOP_DATA_DIR` 覆盖。

## 安全要求

- 不修改、不删除用户的任何现有文件；导出只写新文件（显式 `--out` 或桌面）。
- 不在输出、日志或回复里复述任何凭证明文。
- 覆盖性操作（写 AGENTS.md、恢复设置）前必须先征得用户同意。
