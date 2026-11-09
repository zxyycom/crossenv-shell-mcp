import type { Eta, TransferState } from "./contract.ts";

export type ByteSample = { at: number; bytes: number };

/** Explicit observations only; this calculation never reads a clock or mutates history. */
export function estimateTransfer(input: {
  now: number; wallNow: number; started: number; bytes: number; total: number | null;
  samples: readonly ByteSample[]; state: TransferState;
}) {
  const { now, wallNow, started, bytes, total, samples, state } = input;
  const elapsed = (now - started) / 1000;
  const windowStart = Math.max(started, now - 15_000);
  const before = samples.findLast((sample) => sample.at <= windowStart) ?? samples[0];
  const after = samples.find((sample) => sample.at >= windowStart);
  const baselineBytes = before && after && after.at > before.at
    ? before.bytes + (after.bytes - before.bytes) * (windowStart - before.at) / (after.at - before.at)
    : before?.bytes;
  const windowSeconds = (now - windowStart) / 1000;
  const average = elapsed > 0 ? bytes / elapsed : null;
  const recent = windowSeconds >= 5 && baselineBytes !== undefined ? (bytes - baselineBytes) / windowSeconds : null;
  const eta = (speed: number | null): Eta => {
    if (total !== null && bytes === total) return { state: "estimated", remainingSeconds: 0, estimatedTransferEndAt: new Date(wallNow).toISOString() };
    if (state !== "running") return { state: "unknown", reason: "not_running" };
    if (total === null) return { state: "unknown", reason: "total_unknown" };
    if (speed === null) return { state: "unknown", reason: "insufficient_samples" };
    if (speed <= 0) return { state: "unknown", reason: "zero_speed" };
    const remainingSeconds = (total - bytes) / speed;
    return { state: "estimated", remainingSeconds, estimatedTransferEndAt: new Date(wallNow + remainingSeconds * 1000).toISOString() };
  };
  return { averageBytesPerSecond: average, recentBytesPerSecond: recent, etaAverage: eta(average), etaRecent: eta(recent) };
}
