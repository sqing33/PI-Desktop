import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createApi } from "./api";
import { Chat } from "./Chat";
import { Login } from "./Login";
import { RacpClient } from "./racp";
import type { RacpConnectionState } from "./racp";
import { Sessions } from "./Sessions";
import type { RacpEventEnvelope, RacpSession } from "./types";

type AuthPhase = "probing" | "unauthenticated" | "authenticated";

const STATE_LABEL: Record<RacpConnectionState, string> = {
  connected: "已连接",
  connecting: "连接中…",
  disconnected: "未连接",
  error: "连接异常",
};

export default function App(): React.JSX.Element {
  const clientRef = useRef<RacpClient | null>(null);
  if (clientRef.current === null) clientRef.current = new RacpClient();
  const client = clientRef.current;
  const api = useMemo(() => createApi(client), [client]);

  const [phase, setPhase] = useState<AuthPhase>("probing");
  const [authError, setAuthError] = useState<string | null>(null);
  const [connState, setConnState] = useState<RacpConnectionState>("disconnected");
  const [connDetail, setConnDetail] = useState("");
  const [sessions, setSessions] = useState<RacpSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [listError, setListError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<Record<string, string>>({});
  const [liveTurnId, setLiveTurnId] = useState<Record<string, string>>({});

  const refreshSessions = useCallback(async (): Promise<void> => {
    try {
      const list = await api.listSessions();
      setSessions(list);
      setListError(null);
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api]);

  // Connection state. On the initial probe, reaching "connected" proves a
  // session cookie exists; any terminal failure before that lands on the
  // login page with the retry loop parked.
  const probedRef = useRef(false);
  useEffect(() => {
    const unsubscribe = client.onStateChange((state, detail) => {
      setConnState(state);
      setConnDetail(detail);
      if (!probedRef.current && state !== "connecting" && state !== "disconnected") {
        probedRef.current = true;
        if (state === "connected") {
          setPhase("authenticated");
        } else {
          // 401 at upgrade (or host unreachable): stop auto-reconnect while
          // the login page is up; `handleLogin` reconnects after success.
          client.disconnect();
          setPhase("unauthenticated");
        }
      }
      if (state === "connected") {
        setSubject(client.principal?.principal.subject ?? "");
        void refreshSessions();
      }
    });
    client.connect();
    return () => {
      unsubscribe();
      client.disconnect();
    };
  }, [client, refreshSessions]);

  // Host-scoped events keep the session list and live turn status fresh.
  useEffect(() => {
    if (phase !== "authenticated") return;
    void api.subscribeHost().catch(() => undefined);
    return client.onEvent((envelope: RacpEventEnvelope) => {
      if (envelope.kind === "session.created" || envelope.kind === "session.changed") {
        void refreshSessions();
      } else if (envelope.kind === "session.archived") {
        setSessions((previous) => previous.filter((entry) => entry.id !== envelope.sessionId));
        setActiveId((current) => (current === envelope.sessionId ? null : current));
      } else if (envelope.kind === "turn.started" && envelope.sessionId) {
        setLiveStatus((previous) => ({ ...previous, [envelope.sessionId as string]: "running" }));
        if (envelope.turnId) setLiveTurnId((previous) => ({ ...previous, [envelope.sessionId as string]: envelope.turnId as string }));
      } else if (
        (envelope.kind === "turn.completed" || envelope.kind === "turn.failed" || envelope.kind === "turn.interrupted") &&
        envelope.sessionId
      ) {
        setLiveStatus((previous) => ({ ...previous, [envelope.sessionId as string]: "idle" }));
        setLiveTurnId((previous) => ({ ...previous, [envelope.sessionId as string]: "" }));
        void refreshSessions();
      }
    });
  }, [phase, client, api, refreshSessions]);

  // A reconnect replaces the socket, so every subscription is gone. Rebuild them
  // from the authoritative snapshot instead of trusting stale local state.
  useEffect(() => {
    if (phase !== "authenticated") return;
    return client.onReconnect(() => {
      void api.subscribeHost().catch(() => undefined);
      void refreshSessions();
    });
  }, [phase, client, api, refreshSessions]);

  async function handleLogin(token: string): Promise<void> {
    setAuthError(null);
    try {
      await client.login(token);
      probedRef.current = false; // re-arm so a failed connect re-enters probe
      client.disconnect();
      client.connect();
      setPhase("authenticated");
    } catch (cause) {
      setPhase("unauthenticated");
      setAuthError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }

  async function handleLogout(): Promise<void> {
    await client.logout();
    client.disconnect();
    probedRef.current = false;
    setPhase("unauthenticated");
    setSessions([]);
    setActiveId(null);
    setSubject("");
  }

  async function handleCreate(title: string, projectId?: string): Promise<void> {
    const session = await api.createSession({ title, projectId });
    await refreshSessions();
    setActiveId(session.id);
  }

  if (phase === "probing") {
    return (
      <div className="boot">
        <p>正在连接 pi-host…</p>
      </div>
    );
  }

  if (phase === "unauthenticated") {
    return <Login onLogin={handleLogin} error={authError} />;
  }

  const active = sessions.find((entry) => entry.id === activeId) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">PI-Web</span>
        <span className={`conn conn-${connState}`}>
          <span className="dot" aria-hidden="true" />
          {STATE_LABEL[connState]}
          {connState === "error" && connDetail ? ` · ${connDetail}` : ""}
        </span>
        {subject ? <span className="subject">{subject}</span> : null}
        <button className="btn btn-ghost" type="button" onClick={() => void handleLogout()}>
          登出
        </button>
      </header>
      <div className="layout">
        <Sessions sessions={sessions} activeId={activeId} onSelect={setActiveId} onCreate={handleCreate} />
        <main className="main">
          {listError ? (
            <div className="banner banner-warn">
              {listError}{" "}
              <button type="button" className="link" onClick={() => void refreshSessions()}>
                重试
              </button>
            </div>
          ) : null}
          {active ? (
            <Chat
              api={api}
              session={active}
              connected={connState === "connected"}
              liveStatus={liveStatus[active.id]}
              liveTurnId={liveTurnId[active.id] || undefined}
              onEvent={(listener) => client.onEvent(listener)}
              onServerRequest={(listener) => client.onServerRequest(listener)}
            />
          ) : (
            <div className="placeholder">
              <p>选择左侧会话，或新建一个会话开始</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
