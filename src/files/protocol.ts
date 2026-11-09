import * as v from "valibot";
import { fileLimits, assertTransferPath, TransferFault, transferErrorCodes, transferPhases } from "./contract.ts";

const bytes = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(fileLimits.bytes));
const sha256 = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const eventSchema = v.variant("event", [
  v.strictObject({ event: v.literal("phase"), phase: v.picklist(transferPhases) }),
  v.strictObject({ event: v.literal("ready"), size: bytes, sha256: v.optional(sha256) }),
  v.strictObject({ event: v.literal("progress"), bytes }),
  v.strictObject({ event: v.literal("verified"), bytes, sha256 }),
  v.strictObject({ event: v.literal("complete"), bytes, sha256 }),
  v.strictObject({ event: v.literal("error"), code: v.picklist(transferErrorCodes), published: v.boolean(), cleanupFailed: v.boolean() }),
]);
export type FileEvent = v.InferOutput<typeof eventSchema>;

export type FileProtocolState = "initial" | "hashing_source" | "ready" | "transferring" | "verifying" | "verified" | "awaiting_commit" | "publishing" | "complete";
type Action = "ready" | "progress" | "verified" | "complete" | "phase:transferring" | "phase:verifying" | "phase:awaiting_commit" | "phase:publishing";
type Transitions = Partial<Record<FileProtocolState, Partial<Record<Action, FileProtocolState>>>>;
const transitions: Record<"upload" | "download", Transitions> = {
  upload: {
    initial: { ready: "ready" }, ready: { "phase:transferring": "transferring" },
    transferring: { progress: "transferring", "phase:verifying": "verifying" },
    verifying: { verified: "verified" }, verified: { "phase:awaiting_commit": "awaiting_commit" },
    awaiting_commit: { "phase:publishing": "publishing" }, publishing: { complete: "complete" },
  },
  download: {
    initial: { "phase:verifying": "hashing_source", ready: "ready" }, hashing_source: { ready: "ready" },
    ready: { "phase:transferring": "transferring" }, transferring: { complete: "complete" },
  },
};

/** Legal wire transitions are independent of child-process timing and local cleanup. */
export function advanceFileProtocol(state: FileProtocolState, direction: "upload" | "download",
  event: Exclude<FileEvent, { event: "error" }>): FileProtocolState {
  const action = event.event === "phase" ? `phase:${event.phase}` : event.event;
  const actions = transitions[direction][state];
  if (!actions || !(action in actions)) throw new TransferFault("protocol_error");
  const next = actions[action as Action];
  if (!next) throw new TransferFault("protocol_error");
  return next;
}

export function parseFileEvent(line: string): FileEvent {
  if (!line.startsWith("PFT1 ") || Buffer.byteLength(line) > fileLimits.headerBytes) throw new TransferFault("protocol_error");
  let value: unknown;
  try { value = JSON.parse(line.slice(5)); } catch { throw new TransferFault("protocol_error"); }
  const result = v.safeParse(eventSchema, value);
  if (!result.success) throw new TransferFault("protocol_error");
  return result.output;
}

export function fileHeader(input: { operation: "put" | "get"; targetPath: string; size?: number; sha256?: string; id: string }): Buffer {
  assertTransferPath(input.targetPath);
  const header = `PFT1\t${input.operation}\t${Buffer.from(input.targetPath, "utf8").toString("base64")}\t${input.size ?? "-"}\t${input.sha256 ?? "-"}\t${input.id}\n`;
  if (Buffer.byteLength(header) > fileLimits.headerBytes) throw new TransferFault("invalid_input", "unpublished");
  return Buffer.from(header, "ascii");
}
