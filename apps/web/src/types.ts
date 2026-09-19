/**
 * Minimal RACP contract types for the web client.
 *
 * These mirror the normative typebox schemas in
 * `packages/shared/src/racp.ts` but stay structurally loose: anything the
 * server may evolve (payloads, content blocks, optional fields) is typed
 * `unknown` and narrowed with the guards below. Never `any`.
 */

export type RacpRole = "viewer" | "controller" | "approver" | "owner";

export type RacpPermissionMode = "ask" | "accept-edits" | "auto";

export type RacpSessionMode = "agent" | "plan" | "goal";

export type RacpSessionStatus = "idle" | "running" | "waiting_permission" | "aborted" | "error";

export type RacpItemType = "message" | "tool" | "compaction";

export type RacpApprovalDecision = "allow-once" | "allow-session" | "deny" | "approve" | "reject";

export interface RacpSession {
  id: string;
  title: string;
  projectId?: string;
  workspaceLabel?: string;
  mode: string;
  status: string;
  permissionMode: string;
  activeTurnId?: string;
  revision?: number;
  createdAt?: string;
  updatedAt: string;
}

export interface RacpItemSummary {
  id: string;
  turnId: string;
  itemType: string;
  status: string;
  content: unknown;
}

export interface RacpApprovalRequest {
  id: string;
  sessionId: string;
  turnId: string;
  kind: string;
  summary: string;
  expiresAt: string;
  revision?: number;
  toolName?: string;
  risk?: string;
  title?: string;
  question?: string;
  allowedDecisions: string[];
  allowedPermissionModes?: string[];
}

export interface RacpInputQuestion {
  id: string;
  question: string;
  options: string[];
  multiSelect: boolean;
}

export interface RacpInputRequest {
  id: string;
  sessionId: string;
  turnId: string;
  expiresAt: string;
  questions: RacpInputQuestion[];
}

export interface RacpCursor {
  epoch: string;
  sequence: number;
}

export interface RacpSessionSnapshot {
  session: RacpSession;
  items: RacpItemSummary[];
  activeItems: RacpItemSummary[];
  pendingApprovals: RacpApprovalRequest[];
  pendingInputs: RacpInputRequest[];
  cursor: RacpCursor;
  queuedTurns: unknown[];
}

export interface RacpEventEnvelope {
  eventId: string;
  scope: string;
  sessionId?: string;
  turnId?: string;
  epoch: string;
  sequence?: number;
  kind: string;
  revision: number;
  payload: unknown;
}

export interface RacpPrincipal {
  subject: string;
  roles: string[];
}

export interface RacpInitializeResult {
  protocolVersion: string;
  connectionId: string;
  principal: RacpPrincipal;
}

// ---------------------------------------------------------------------------
// JSON-RPC frame shapes (parsed defensively in racp.ts via isRecord)
// ---------------------------------------------------------------------------

export interface RacpRemoteError {
  code: string;
  message: string;
  retriable?: boolean;
  traceId?: string;
}

export type JsonRpcFrame =
  | { jsonrpc: "2.0"; id: string | number; method: string; params?: unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: string | number; result: unknown }
  | { jsonrpc: "2.0"; id: string | number; error: RacpRemoteError };

// ---------------------------------------------------------------------------
// Type guards (server responses are untrusted at the boundary)
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Narrow an event envelope payload to a `{item: ...}` shape (item.* events). */
export function readEventItem(payload: unknown): RacpItemSummary | null {
  if (!isRecord(payload)) return null;
  const item = payload.item;
  if (!isRecord(item)) return null;
  if (typeof item.id !== "string" || typeof item.turnId !== "string") return null;
  return {
    id: item.id,
    turnId: item.turnId,
    itemType: asString(item.itemType, "message"),
    status: asString(item.status, "streaming"),
    content: item.content,
  };
}

/** Narrow an event envelope payload to an approval request. */
export function readApproval(payload: unknown): RacpApprovalRequest | null {
  const approval = isRecord(payload) ? payload.approval : null;
  if (!isRecord(approval)) return null;
  if (typeof approval.id !== "string" || typeof approval.summary !== "string") return null;
  return {
    id: approval.id,
    sessionId: asString(approval.sessionId),
    turnId: asString(approval.turnId),
    kind: asString(approval.kind, "tool"),
    summary: approval.summary,
    expiresAt: asString(approval.expiresAt),
    revision: typeof approval.revision === "number" ? approval.revision : undefined,
    toolName: typeof approval.toolName === "string" ? approval.toolName : undefined,
    risk: typeof approval.risk === "string" ? approval.risk : undefined,
    title: typeof approval.title === "string" ? approval.title : undefined,
    question: typeof approval.question === "string" ? approval.question : undefined,
    allowedDecisions: stringArray(approval.allowedDecisions),
    allowedPermissionModes: Array.isArray(approval.allowedPermissionModes)
      ? stringArray(approval.allowedPermissionModes)
      : undefined,
  };
}

/** Narrow an event envelope payload to an input request. */
export function readInputRequest(payload: unknown): RacpInputRequest | null {
  const input = isRecord(payload) ? payload.input : null;
  if (!isRecord(input)) return null;
  if (typeof input.id !== "string") return null;
  const questions = Array.isArray(input.questions)
    ? input.questions
        .map((entry): RacpInputQuestion | null => {
          if (!isRecord(entry) || typeof entry.question !== "string") return null;
          return {
            id: asString(entry.id, ""),
            question: entry.question,
            options: stringArray(entry.options),
            multiSelect: entry.multiSelect === true,
          };
        })
        .filter((entry): entry is RacpInputQuestion => entry !== null)
    : [];
  return {
    id: input.id,
    sessionId: asString(input.sessionId),
    turnId: asString(input.turnId),
    expiresAt: asString(input.expiresAt),
    questions,
  };
}

function coerceSession(record: Record<string, unknown>): RacpSession | null {
  if (typeof record.id !== "string") return null;
  return {
    id: record.id,
    title: asString(record.title),
    projectId: typeof record.projectId === "string" ? record.projectId : undefined,
    workspaceLabel: typeof record.workspaceLabel === "string" ? record.workspaceLabel : undefined,
    mode: asString(record.mode, "agent"),
    status: asString(record.status, "idle"),
    permissionMode: asString(record.permissionMode, "ask"),
    activeTurnId: typeof record.activeTurnId === "string" ? record.activeTurnId : undefined,
    revision: typeof record.revision === "number" ? record.revision : undefined,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
    updatedAt: asString(record.updatedAt),
  };
}

/** Extract the session list from a `session/list` result. */
export function readSessions(result: unknown): RacpSession[] {
  if (!isRecord(result) || !Array.isArray(result.sessions)) return [];
  return result.sessions
    .map((entry): RacpSession | null => (isRecord(entry) ? coerceSession(entry) : null))
    .filter((entry): entry is RacpSession => entry !== null);
}

export function readSession(result: unknown): RacpSession | null {
  if (!isRecord(result) || !isRecord(result.session)) return null;
  return coerceSession(result.session);
}

export function readSnapshot(result: unknown): RacpSessionSnapshot | null {
  if (!isRecord(result) || !isRecord(result.snapshot)) return null;
  const snapshot = result.snapshot;
  const session = isRecord(snapshot.session) ? coerceSession(snapshot.session) : null;
  if (!session) return null;
  const items = (Array.isArray(snapshot.items) ? snapshot.items : [])
    .map((entry) => (isRecord(entry) && typeof entry.id === "string" && typeof entry.turnId === "string" ? readEventItem({ item: entry }) : null))
    .filter((entry): entry is RacpItemSummary => entry !== null);
  const activeItems = (Array.isArray(snapshot.activeItems) ? snapshot.activeItems : [])
    .map((entry) => (isRecord(entry) && typeof entry.id === "string" && typeof entry.turnId === "string" ? readEventItem({ item: entry }) : null))
    .filter((entry): entry is RacpItemSummary => entry !== null);
  const pendingApprovals = (Array.isArray(snapshot.pendingApprovals) ? snapshot.pendingApprovals : [])
    .map((entry) => readApproval({ approval: entry }))
    .filter((entry): entry is RacpApprovalRequest => entry !== null);
  const pendingInputs = (Array.isArray(snapshot.pendingInputs) ? snapshot.pendingInputs : [])
    .map((entry) => readInputRequest({ input: entry }))
    .filter((entry): entry is RacpInputRequest => entry !== null);
  const cursorRecord = isRecord(snapshot.cursor) ? snapshot.cursor : {};
  return {
    session,
    items,
    activeItems,
    pendingApprovals,
    pendingInputs,
    cursor: {
      epoch: asString(cursorRecord.epoch),
      sequence: typeof cursorRecord.sequence === "number" ? cursorRecord.sequence : 0,
    },
    queuedTurns: Array.isArray(snapshot.queuedTurns) ? snapshot.queuedTurns : [],
  };
}
