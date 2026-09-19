/**
 * Typed RACP operations for the UI. Each helper sends one JSON-RPC request
 * and narrows the result with the guards in `types.ts`.
 */
import { RacpRequestError } from "./racp";
import type { RacpClient } from "./racp";
import { isRecord } from "./types";
import type { RacpApprovalDecision, RacpInputRequest, RacpPermissionMode, RacpSession, RacpSessionSnapshot } from "./types";
import { readSession, readSessions, readSnapshot } from "./types";

function newRequestId(): string {
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class RacpApiError extends RacpRequestError {}

function unwrapSessionList(result: unknown): RacpSession[] {
  return readSessions(result);
}

export function createApi(client: RacpClient) {
  return {
    async listSessions(): Promise<RacpSession[]> {
      return unwrapSessionList(await client.request("session/list", {}));
    },
    async createSession(input: { title: string; projectId?: string }): Promise<RacpSession> {
      const result = await client.request("session/create", {
        title: input.title,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      });
      const session = readSession(result);
      if (!session) throw new RacpApiError("INVALID_RESPONSE", "session/create 返回结果无法解析");
      return session;
    },
    async attach(sessionId: string): Promise<RacpSessionSnapshot> {
      const result = await client.request("session/attach", { sessionId, includeSnapshot: true });
      const snapshot = readSnapshot(result);
      if (!snapshot) throw new RacpApiError("INVALID_RESPONSE", "session/attach 返回结果无法解析");
      return snapshot;
    },
    async subscribe(sessionId: string): Promise<void> {
      await client.request("events/subscribe", { scope: "session", sessionId });
    },
    async subscribeHost(): Promise<void> {
      await client.request("events/subscribe", { scope: "host" });
    },
    async turnStart(sessionId: string, text: string): Promise<void> {
      const result = await client.request("turn/start", {
        sessionId,
        admission: "reject_if_busy",
        input: { text },
        context: { requestId: newRequestId() },
      });
      // `{accepted:false, turn}` means the session was busy; surface it.
      if (isRecord(result) && result.accepted === false) {
        throw new RacpApiError("AGENT_BUSY", "会话正忙，本次输入被拒绝（admission: reject_if_busy）");
      }
    },
    async turnStop(turnId: string): Promise<void> {
      await client.request("turn/stop", { turnId });
    },
    async turnInterrupt(turnId: string): Promise<void> {
      await client.request("turn/interrupt", { turnId });
    },
    async approvalRespond(
      approvalId: string,
      decision: RacpApprovalDecision,
      permissionMode?: RacpPermissionMode,
    ): Promise<void> {
      await client.request("approval/respond", {
        approvalId,
        decision,
        ...(permissionMode ? { permissionMode } : {}),
        context: { requestId: newRequestId() },
      });
    },
    async inputRespond(inputId: string, answers: Array<string[] | null>): Promise<void> {
      await client.request("input/respond", {
        inputId,
        answers,
        context: { requestId: newRequestId() },
      });
    },
  };
}

export type RacpApi = ReturnType<typeof createApi>;
export type { RacpInputRequest };
