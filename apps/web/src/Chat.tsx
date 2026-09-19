import { useEffect, useReducer, useRef, useState } from "react";
import type { RacpApi } from "./api";
import { chatReducer, initialChatState } from "./chatReducer";
import { approvalFromServerRequest, inputFromServerRequest } from "./chatReducer";
import { toolSummary } from "./content";
import type { RacpApprovalDecision, RacpApprovalRequest, RacpEventEnvelope, RacpInputRequest, RacpPermissionMode, RacpSession } from "./types";

export interface ChatProps {
  api: RacpApi;
  session: RacpSession;
  connected: boolean;
  /** Live session status from host events (may run ahead of the list). */
  liveStatus: string | undefined;
  liveTurnId: string | undefined;
  onEvent: (listener: (envelope: RacpEventEnvelope) => void) => () => void;
  onServerRequest: (listener: (method: string, params: unknown) => void) => () => void;
}

const DECISION_LABEL: Record<string, string> = {
  "allow-once": "允许一次",
  "allow-session": "本次会话内允许",
  deny: "拒绝",
  approve: "批准",
  reject: "驳回",
};

function useCountdown(expiresAt: string | undefined): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!expiresAt) {
      setRemaining(null);
      return;
    }
    const deadline = Date.parse(expiresAt);
    if (Number.isNaN(deadline)) {
      setRemaining(null);
      return;
    }
    const tick = (): void => setRemaining(Math.max(0, deadline - Date.now()));
    tick();
    const timer = setInterval(tick, 1_000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return remaining;
}

function ApprovalCard(props: { api: RacpApi; approval: RacpApprovalRequest; onResolved: (id: string) => void }): React.JSX.Element {
  const { approval } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<string>("");
  const remaining = useCountdown(approval.expiresAt);

  async function respond(decision: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await props.api.approvalRespond(approval.id, decision as RacpApprovalDecision, (permissionMode || undefined) as RacpPermissionMode | undefined);
      props.onResolved(approval.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const seconds = remaining === null ? null : Math.ceil(remaining / 1000);
  return (
    <div className="card card-approval">
      <div className="card-head">
        <span className="card-kind">
          {approval.kind === "tool" ? "工具审批" : approval.kind === "plan" ? "计划审批" : "目标审批"}
          {approval.toolName ? ` · ${approval.toolName}` : ""}
        </span>
        {approval.risk ? <span className={`risk risk-${approval.risk}`}>{approval.risk}</span> : null}
        {seconds !== null ? <span className={`countdown ${seconds <= 30 ? "is-urgent" : ""}`}>{seconds}s</span> : null}
      </div>
      {approval.title ? <strong className="card-title">{approval.title}</strong> : null}
      <p className="card-body">{approval.question ?? approval.summary}</p>
      {approval.allowedPermissionModes && approval.allowedPermissionModes.length > 0 ? (
        <label className="card-mode">
          权限模式
          <select className="input" value={permissionMode} onChange={(event) => setPermissionMode(event.target.value)}>
            <option value="">不调整</option>
            {approval.allowedPermissionModes.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="card-actions">
        {approval.allowedDecisions.map((decision) => (
          <button
            key={decision}
            type="button"
            className={`btn ${decision === "deny" || decision === "reject" ? "btn-danger" : "btn-primary"}`}
            disabled={busy}
            onClick={() => void respond(decision)}
          >
            {DECISION_LABEL[decision] ?? decision}
          </button>
        ))}
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

function InputCard(props: { api: RacpApi; input: RacpInputRequest; onResolved: (id: string) => void }): React.JSX.Element {
  const { input } = props;
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remaining = useCountdown(input.expiresAt);

  function toggle(questionIndex: number, option: string, multiSelect: boolean): void {
    setSelected((previous) => {
      const current = previous[questionIndex] ?? [];
      if (!multiSelect) return { ...previous, [questionIndex]: [option] };
      return {
        ...previous,
        [questionIndex]: current.includes(option) ? current.filter((entry) => entry !== option) : [...current, option],
      };
    });
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const answers = input.questions.map((question, index) => {
        const chosen = selected[index];
        if (chosen && chosen.length > 0) return chosen;
        return question.multiSelect ? [] : null;
      });
      await props.api.inputRespond(input.id, answers);
      props.onResolved(input.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const seconds = remaining === null ? null : Math.ceil(remaining / 1000);
  return (
    <div className="card card-input">
      <div className="card-head">
        <span className="card-kind">需要输入</span>
        {seconds !== null ? <span className={`countdown ${seconds <= 30 ? "is-urgent" : ""}`}>{seconds}s</span> : null}
      </div>
      {input.questions.map((question, questionIndex) => (
        <fieldset key={question.id || questionIndex} className="input-question">
          <legend>{question.question}</legend>
          {question.options.length === 0 ? (
            <p className="card-body">（该问题没有提供选项）</p>
          ) : (
            question.options.map((option) => {
              const chosen = (selected[questionIndex] ?? []).includes(option);
              return (
                <label key={option} className={`option ${chosen ? "is-chosen" : ""}`}>
                  <input
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={`q-${input.id}-${questionIndex}`}
                    checked={chosen}
                    onChange={() => toggle(questionIndex, option, question.multiSelect)}
                  />
                  <span>{option}</span>
                </label>
              );
            })
          )}
        </fieldset>
      ))}
      <div className="card-actions">
        <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void submit()}>
          {busy ? "提交中…" : "提交"}
        </button>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

function ToolBlock(props: { item: { text: string; raw: unknown } }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const { name, args } = toolSummary(props.item.raw);
  return (
    <div className="tool-block">
      <button type="button" className="tool-head" onClick={() => setOpen((value) => !value)}>
        <span className="tool-name">🔧 {name}</span>
        <span className="tool-summary">{args || props.item.text}</span>
        <span className="tool-chevron">{open ? "收起" : "展开"}</span>
      </button>
      {open ? <pre className="tool-detail">{safeJson(props.item.raw)}</pre> : null}
    </div>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

export function Chat(props: ChatProps): React.JSX.Element {
  const { api, session } = props;
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const attachedRef = useRef<string>("");

  // Attach + subscribe whenever the selected session changes, the transport
  // reconnects (subscriptions are per-connection), or a resync.required event
  // invalidates the local snapshot.
  useEffect(() => {
    if (!props.connected) return; // keep the transcript while offline
    let cancelled = false;
    attachedRef.current = session.id;
    dispatch({ type: "reset" });
    (async () => {
      try {
        const snapshot = await api.attach(session.id);
        if (cancelled || attachedRef.current !== session.id) return;
        dispatch({ type: "snapshot", snapshot });
        await api.subscribe(session.id);
      } catch (cause) {
        if (!cancelled) setSendError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, session.id, props.connected, state.resyncCount]);

  // Live session events → transcript. Handler indirection via a ref keeps the
  // subscription stable across re-renders of the parent.
  const eventRef = useRef(props.onEvent);
  const serverRequestRef = useRef(props.onServerRequest);
  eventRef.current = props.onEvent;
  serverRequestRef.current = props.onServerRequest;
  useEffect(() => {
    const unsubscribeEvents = eventRef.current((envelope) => {
      if (envelope.sessionId && envelope.sessionId !== session.id) return;
      dispatch({ type: "event", envelope });
    });
    const unsubscribeRequests = serverRequestRef.current((method, params) => {
      if (method === "approval/request") {
        const approval = approvalFromServerRequest(params);
        if (approval) dispatch({ type: "event", envelope: fakeEnvelope("approval.requested", { approval }, session.id) });
      } else if (method === "input/request") {
        const input = inputFromServerRequest(params);
        if (input) dispatch({ type: "event", envelope: fakeEnvelope("input.requested", { input }, session.id) });
      }
    });
    return () => {
      unsubscribeEvents();
      unsubscribeRequests();
    };
  }, [session.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [state.items, state.approvals, state.inputs]);

  async function send(): Promise<void> {
    const text = draft.trim();
    if (!text) return;
    const echoId = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    dispatch({ type: "localUserMessage", id: echoId, text });
    setSending(true);
    setSendError(null);
    try {
      await api.turnStart(session.id, text);
      setDraft("");
    } catch (cause) {
      // Roll the echo back so the user can edit and retry.
      dispatch({ type: "removeItem", id: echoId });
      setSendError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  const running = props.liveStatus === "running" || (props.liveStatus === undefined && session.status === "running") || Boolean(props.liveTurnId ?? session.activeTurnId);

  return (
    <section className="chat">
      <header className="chat-head">
        <div className="chat-head-main">
          <h2>{session.title || "(未命名会话)"}</h2>
          <span className="chat-head-meta">
            {session.workspaceLabel ? `${session.workspaceLabel} · ` : ""}
            {session.mode} · {props.liveStatus ?? session.status}
          </span>
        </div>
      </header>

      {!props.connected ? <div className="banner banner-warn">连接已断开，正在自动重连…</div> : null}
      {!state.attached ? <div className="banner">正在加载会话快照…</div> : null}

      <div className="cards">
        {state.approvals.map((approval) => (
          <ApprovalCard
            key={approval.id}
            api={api}
            approval={approval}
            onResolved={(id) => dispatch({ type: "event", envelope: fakeEnvelope("approval.resolved", { approvalId: id }, session.id) })}
          />
        ))}
        {state.inputs.map((input) => (
          <InputCard
            key={input.id}
            api={api}
            input={input}
            onResolved={(id) => dispatch({ type: "event", envelope: fakeEnvelope("input.resolved", { inputId: id }, session.id) })}
          />
        ))}
      </div>

      <div className="transcript">
        {state.items.map((item) => {
          if (item.itemType === "tool") return <ToolBlock key={item.id} item={item} />;
          const mine = item.local === "user";
          return (
            <div key={item.id} className={`bubble ${mine ? "bubble-user" : "bubble-agent"} ${item.status === "streaming" ? "is-streaming" : ""}`}>
              {item.itemType === "compaction" ? <em className="compaction">〔上下文压缩〕{item.text}</em> : item.text}
            </div>
          );
        })}
        {state.items.length === 0 && state.attached ? <p className="transcript-empty">发送第一条消息开始对话</p> : null}
        <div ref={bottomRef} />
      </div>

      {sendError ? <p className="form-error send-error">{sendError}</p> : null}

      <footer className="composer">
        <textarea
          value={draft}
          placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
          rows={Math.min(6, Math.max(1, draft.split("\n").length))}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-actions">
          {running ? (
            <button className="btn btn-danger" type="button" disabled={sending} onClick={() => void stop()}>
              停止
            </button>
          ) : null}
          <button className="btn btn-primary" type="button" disabled={sending || draft.trim().length === 0} onClick={() => void send()}>
            {sending ? "发送中…" : "发送"}
          </button>
        </div>
      </footer>
    </section>
  );
}

/** Build a synthetic envelope so server requests reuse the event reducer. */
function fakeEnvelope(kind: string, payload: unknown, sessionId: string): RacpEventEnvelope {
  return {
    eventId: `local-${kind}-${Math.random().toString(36).slice(2, 8)}`,
    scope: "session",
    sessionId,
    epoch: "",
    kind,
    revision: 0,
    payload,
  };
}
