export const fileLimits = {
  bytes: 100 * 1024 * 1024,
  chunkBytes: 64 * 1024,
  pathBytes: 4096,
  headerBytes: 8192,
  controlBytes: 512 * 1024,
  totalMs: 600_000,
  connectMs: 30_000,
  verifyMs: 60_000,
  publishMs: 10_000,
  stallMs: 60_000,
  cleanupMs: 10_000,
  receiptMs: 600_000,
  receipts: 64,
} as const;

export const transferPhases = ["preparing", "connecting", "transferring", "verifying", "awaiting_commit", "publishing", "cleanup", "complete"] as const;
export type TransferPhase = typeof transferPhases[number];
export type TransferState = TransferOutcome["state"];
export type FileEndpoint = { targetId: string; path: string };
export type FileRequest = { environment: string; direction: "upload" | "download"; localPath: string; targetPath: string };
export type TransferRequest = FileRequest & { source: FileEndpoint; destination: FileEndpoint };
export type FileReceipt = { bytes: number; sha256: string; published: true };
export type PostState = "unpublished" | "published" | "unknown";
export const transferErrorCodes = [
  "invalid_input", "busy", "unknown_transfer", "source_missing", "path_link", "not_regular",
  "parent_missing", "conflict", "too_large", "source_changed", "truncated", "hash_mismatch", "protocol_error",
  "target_unavailable", "process_failed", "cancelled", "deadline", "stalled", "phase_timeout", "cleanup_failed", "io_failed", "server_closed",
] as const;
export type TransferErrorCode = typeof transferErrorCodes[number];

export class TransferFault extends Error {
  readonly code: TransferErrorCode;
  readonly postState: PostState;
  readonly cleanupFailed: boolean;
  readonly phase?: TransferPhase;
  constructor(code: TransferErrorCode, postState: PostState = "unknown", cleanupFailed = false, phase?: TransferPhase) {
    super(`文件收发失败：${code}；不会自动重试写入`);
    this.code = code;
    this.postState = postState;
    this.cleanupFailed = cleanupFailed;
    this.phase = phase;
  }
}

export type TransferProgress = { phase?: TransferPhase; bytes?: number; total?: number };
export type FileExecution = {
  request: FileRequest;
  signal: AbortSignal;
  observe: (event: TransferProgress) => void;
};
export type FileExecutor = (execution: FileExecution) => Promise<FileReceipt>;
export type Eta = { state: "estimated"; remainingSeconds: number; estimatedTransferEndAt: string }
  | { state: "unknown"; reason: "total_unknown" | "insufficient_samples" | "zero_speed" | "not_running" };
export type TransferFailure = { code: TransferErrorCode; phase: TransferPhase; postState: PostState; cleanupFailed: boolean };
export type TransferOutcome = { state: "running" }
  | { state: "completed"; receipt: FileReceipt }
  | { state: "failed" | "cancelled"; failure: TransferFailure };
export type TransferSnapshot = { transfer_id: string } & (
  | { state: "running"; phase: TransferPhase; transferredBytes: number; totalBytes: number | null;
      lastProgressAgeSeconds: number | null; averageBytesPerSecond: number | null; recentBytesPerSecond: number | null;
      etaAverage: Eta; etaRecent: Eta; deadlineRemainingSeconds: number }
  | { state: "completed"; source: FileEndpoint; destination: FileEndpoint; receipt: FileReceipt }
  | { state: "failed" | "cancelled"; source: FileEndpoint; destination: FileEndpoint; failure: TransferFailure }
);

export function assertTransferPath(value: string): void {
  if (!value || Buffer.byteLength(value, "utf8") > fileLimits.pathBytes || /[\x00-\x1f\x7f]/.test(value)) {
    throw new TransferFault("invalid_input", "unpublished");
  }
}

export function transferFault(error: unknown): TransferFault {
  return error instanceof TransferFault ? error : new TransferFault("io_failed");
}
