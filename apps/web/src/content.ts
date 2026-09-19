/**
 * Lenient content extraction for `RacpItemSummary.content`.
 *
 * The Host may send a plain string, `{message}`, `{text}`, a block array,
 * or something new; the transcript must never crash on any shape.
 */
import type { RacpItemSummary } from "./types";
import { isRecord } from "./types";

const FALLBACK_TRUNCATE = 400;

function textFromBlock(block: unknown): string | null {
  if (typeof block === "string") return block;
  if (!isRecord(block)) return null;
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (typeof block.text === "string") return block.text;
  return null;
}

/** Best-effort plain-text extraction from an unknown content value. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (isRecord(content)) {
    if (typeof content.message === "string") return content.message;
    if (typeof content.text === "string") return content.text;
    if (typeof content.summary === "string") return content.summary;
    if (Array.isArray(content.blocks)) {
      return content.blocks
        .map(textFromBlock)
        .filter((part): part is string => part !== null)
        .join("");
    }
    if (Array.isArray(content.content)) return extractText(content.content);
  }
  if (Array.isArray(content)) {
    return content
      .map(textFromBlock)
      .filter((part): part is string => part !== null)
      .join("");
  }
  try {
    const json = JSON.stringify(content);
    return json.length > FALLBACK_TRUNCATE ? `${json.slice(0, FALLBACK_TRUNCATE)}…` : json;
  } catch {
    return "[无法序列化的内容]";
  }
}

/** Tool display name + one-line argument summary for tool items. */
export function toolSummary(content: unknown): { name: string; args: string } {
  const empty = { name: "tool", args: "" };
  if (!isRecord(content)) return empty;
  const name = typeof content.toolName === "string" ? content.toolName : typeof content.name === "string" ? content.name : "tool";
  const rawArgs =
    typeof content.arguments === "string"
      ? content.arguments
      : isRecord(content.arguments) || Array.isArray(content.arguments)
        ? safeStringify(content.arguments)
        : typeof content.input === "string"
          ? content.input
          : "";
  return { name, args: rawArgs.length > 300 ? `${rawArgs.slice(0, 300)}…` : rawArgs };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function itemText(item: RacpItemSummary): string {
  return extractText(item.content);
}
