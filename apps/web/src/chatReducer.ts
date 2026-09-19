/**
 * Session transcript state machine: snapshot → live event application.
 * Kept as a pure reducer so event application is testable in isolation.
 */
import type { RacpApprovalRequest, RacpEventEnvelope, RacpInputRequest, RacpItemSummary, RacpSessionSnapshot } from "./types";
import { extractText } from "./content";
import { isRecord, readApproval, readEventItem, readInputRequest } from "./types";

export interface ChatItem {
  id: string;
  turnId: string;
  itemType: string;
  status: string;
  text: string;
  raw: unknown;
  /** Local heuristic: bubbles echoed from the composer render as user-side. */
  local?: "user";
}

export interface ChatState {
  items: ChatItem[];
  approvals: RacpApprovalRequest[];
  inputs: RacpInputRequest[];
  attached: boolean;
  /** Bumped by resync.required; drives re-attach in Chat. */
  resyncCount: number;
}

export type ChatAction =
  | { type: "reset" }
  | { type: "snapshot"; snapshot: RacpSessionSnapshot }
  | { type: "event"; envelope: RacpEventEnvelope }
  | { type: "localUserMessage"; id: string; text: string }
  | { type: "removeItem"; id: string };

export const initialChatState: ChatState = { items: [], approvals: [], inputs: [], attached: false, resyncCount: 0 };

function toChatItem(item: RacpItemSummary): ChatItem {
  return {
    id: item.id,
    turnId: item.turnId,
    itemType: item.itemType,
    status: item.status,
    text: extractText(item.content),
    raw: item.content,
  };
}

/** Lenient delta-text extraction: `{delta}`, `{text}`, `{item:{...}}`. */
function deltaText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!isRecord(payload)) return "";
  if (typeof payload.delta === "string") return payload.delta;
  if (typeof payload.text === "string") return payload.text;
  const item = readEventItem(payload);
  return item ? extractText(item.content) : "";
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "reset":
      return initialChatState;
    case "snapshot": {
      const items = [...action.snapshot.items.map(toChatItem)];
      for (const active of action.snapshot.activeItems) {
        if (!items.some((item) => item.id === active.id)) items.push(toChatItem(active));
      }
      return {
        items,
        approvals: [...action.snapshot.pendingApprovals],
        inputs: [...action.snapshot.pendingInputs],
        attached: true,
        resyncCount: state.resyncCount,
      };
    }
    case "event":
      return applyEvent(state, action.envelope);
    case "localUserMessage":
      return {
        ...state,
        items: [
          ...state.items,
          { id: action.id, turnId: "", itemType: "message", status: "completed", text: action.text, raw: action.text, local: "user" },
        ],
      };
    case "removeItem":
      return { ...state, items: state.items.filter((existing) => existing.id !== action.id) };
  }
}

function applyEvent(state: ChatState, envelope: RacpEventEnvelope): ChatState {
  switch (envelope.kind) {
    case "item.started": {
      const item = readEventItem(envelope.payload);
      if (!item) return state;
      if (state.items.some((existing) => existing.id === item.id)) return state;
      return { ...state, items: [...state.items, toChatItem(item)] };
    }
    case "item.delta": {
      const delta = deltaText(envelope.payload);
      if (!delta) return state;
      const payloadItem = readEventItem(envelope.payload);
      const targetId = payloadItem?.id;
      let updated = false;
      const items = state.items.map((existing) => {
        const match = targetId !== undefined ? existing.id === targetId : existing.turnId === envelope.turnId;
        if (!match || updated) return existing;
        updated = true;
        return { ...existing, text: existing.text + delta, status: "streaming" };
      });
      return updated ? { ...state, items } : state;
    }
    case "item.completed": {
      const item = readEventItem(envelope.payload);
      if (!item) return state;
      const finalText = extractText(item.content);
      let found = false;
      const items = state.items.map((existing) => {
        if (existing.id !== item.id) return existing;
        found = true;
        return {
          ...existing,
          status: "completed",
          raw: item.content,
          text: finalText.length > 0 ? finalText : existing.text,
        };
      });
      if (!found) {
        // The persisted user message may correspond to a locally echoed
        // bubble: adopt the server item id, keep the user-side styling.
        const echoIndex = items.findIndex(
          (existing) => existing.local === "user" && finalText.length > 0 && existing.text === finalText,
        );
        if (echoIndex >= 0) {
          items.splice(echoIndex, 1, { ...toChatItem(item), local: "user" });
        } else {
          items.push(toChatItem(item));
        }
      }
      return { ...state, items };
    }
    case "approval.requested": {
      const approval = readApproval(envelope.payload);
      if (!approval) return state;
      if (state.approvals.some((existing) => existing.id === approval.id)) return state;
      return { ...state, approvals: [...state.approvals, approval] };
    }
    case "approval.resolved": {
      const record = isRecord(envelope.payload) ? envelope.payload : {};
      const approvalId = typeof record.approvalId === "string" ? record.approvalId : "";
      return { ...state, approvals: state.approvals.filter((existing) => existing.id !== approvalId) };
    }
    case "input.requested": {
      const input = readInputRequest(envelope.payload);
      if (!input) return state;
      if (state.inputs.some((existing) => existing.id === input.id)) return state;
      return { ...state, inputs: [...state.inputs, input] };
    }
    case "input.resolved": {
      const record = isRecord(envelope.payload) ? envelope.payload : {};
      const inputId = typeof record.inputId === "string" ? record.inputId : "";
      return { ...state, inputs: state.inputs.filter((existing) => existing.id !== inputId) };
    }
    case "resync.required":
      return { ...state, attached: false, resyncCount: state.resyncCount + 1 };
    default:
      return state;
  }
}

/** Normalize a server-request params payload into an approval request. */
export function approvalFromServerRequest(params: unknown): RacpApprovalRequest | null {
  return readApproval(params) ?? readApproval({ approval: params });
}

/** Normalize a server-request params payload into an input request. */
export function inputFromServerRequest(params: unknown): RacpInputRequest | null {
  return readInputRequest(params) ?? readInputRequest({ input: params });
}
