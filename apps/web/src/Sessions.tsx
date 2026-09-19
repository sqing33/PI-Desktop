import { useState } from "react";
import type { RacpSession } from "./types";

export interface SessionsProps {
  sessions: RacpSession[];
  activeId: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: (title: string, projectId?: string) => Promise<void>;
}

const STATUS_LABEL: Record<string, string> = {
  idle: "空闲",
  running: "运行中",
  waiting_permission: "等待审批",
  aborted: "已中止",
  error: "错误",
};

function formatUpdatedAt(value: string): string {
  const time = Date.parse(value);
  if (Number.isNaN(time)) return "";
  const diff = Date.now() - time;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const date = new Date(time);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : date.toLocaleDateString("zh-CN");
}

export function Sessions(props: SessionsProps): React.JSX.Element {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) {
      setError("请输入会话标题");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await props.onCreate(trimmed, projectPath.trim() || undefined);
      setCreating(false);
      setTitle("");
      setProjectPath("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="sessions">
      <div className="sessions-head">
        <span className="sessions-title">会话</span>
        <button className="btn btn-ghost" type="button" onClick={() => setCreating((value) => !value)}>
          {creating ? "取消" : "＋ 新建"}
        </button>
      </div>
      {creating ? (
        <div className="session-create">
          <input
            className="input"
            value={title}
            placeholder="会话标题"
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
          />
          <input
            className="input"
            value={projectPath}
            placeholder="项目路径（可选）"
            spellCheck={false}
            onChange={(event) => setProjectPath(event.target.value)}
          />
          <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void create()}>
            {busy ? "创建中…" : "创建会话"}
          </button>
          {error ? <p className="form-error">{error}</p> : null}
        </div>
      ) : null}
      {props.sessions.length === 0 ? <p className="sessions-empty">暂无会话</p> : null}
      <ul className="session-list">
        {props.sessions.map((session) => (
          <li key={session.id}>
            <button
              type="button"
              className={`session-item ${props.activeId === session.id ? "is-active" : ""}`}
              onClick={() => props.onSelect(session.id)}
            >
              <span className={`dot dot-${session.status}`} aria-hidden="true" />
              <span className="session-item-title">{session.title || "(未命名会话)"}</span>
              <span className={`badge badge-${session.status}`}>{STATUS_LABEL[session.status] ?? session.status}</span>
              {session.updatedAt ? <span className="session-item-time">{formatUpdatedAt(session.updatedAt)}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
