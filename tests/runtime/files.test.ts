import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { writeBytes } from "../../src/files/channel.ts";
import { estimateTransfer } from "../../src/files/eta.ts";
import { FileTransfers } from "../../src/files/tasks.ts";
import { TransferFault, type FileExecution } from "../../src/files/contract.ts";
import { advanceFileProtocol, parseFileEvent, type FileEvent, type FileProtocolState } from "../../src/files/protocol.ts";

test("dual ETA uses independent average/recent rates including connection delay and stalls", () => {
  const result = estimateTransfer({ started: 0, now: 20_000, wallNow: 0, total: 100, bytes: 80,
    samples: [{ at: 0, bytes: 0 }, { at: 5_000, bytes: 10 }, { at: 20_000, bytes: 80 }], state: "running" });
  expect(result.averageBytesPerSecond).toBe(4);
  expect(result.recentBytesPerSecond).toBeCloseTo(70 / 15);
  expect(result.etaAverage).toEqual({ state: "estimated", remainingSeconds: 5, estimatedTransferEndAt: "1970-01-01T00:00:05.000Z" });
  expect(result.etaRecent).toMatchObject({ state: "estimated", remainingSeconds: 30 / 7 });
  const stalled = estimateTransfer({ started: 0, now: 40_000, wallNow: 0, total: 100, bytes: 80,
    samples: [{ at: 20_000, bytes: 80 }], state: "running" });
  expect(stalled.etaRecent).toEqual({ state: "unknown", reason: "zero_speed" });
  expect(stalled.etaAverage).toMatchObject({ remainingSeconds: 10 });
});

test("ETA distinguishes early samples, unknown totals, completed bytes and terminal failure", () => {
  const input = { started: 0, now: 4_000, wallNow: 0, total: 100, bytes: 20, samples: [{ at: 0, bytes: 0 }], state: "running" as const };
  expect(estimateTransfer(input).etaRecent).toEqual({ state: "unknown", reason: "insufficient_samples" });
  expect(estimateTransfer({ ...input, total: null }).etaAverage).toEqual({ state: "unknown", reason: "total_unknown" });
  expect(estimateTransfer({ ...input, bytes: 100 }).etaRecent).toMatchObject({ state: "estimated", remainingSeconds: 0 });
  expect(estimateTransfer({ ...input, bytes: 0, total: 0 }).etaAverage).toMatchObject({ remainingSeconds: 0 });
  expect(estimateTransfer({ ...input, state: "failed" }).etaAverage).toEqual({ state: "unknown", reason: "not_running" });
  const sparse = estimateTransfer({ ...input, now: 20_000, bytes: 80, samples: [{ at: 0, bytes: 0 }, { at: 20_000, bytes: 80 }] });
  expect(sparse.recentBytesPerSecond).toBe(4);
});

test("deceleration increases the recent ETA independently of the whole-task estimate", () => {
  const result = estimateTransfer({ started: 0, now: 30_000, wallNow: 0, total: 1000, bytes: 600,
    samples: [{ at: 0, bytes: 0 }, { at: 15_000, bytes: 450 }, { at: 30_000, bytes: 600 }], state: "running" });
  expect(result.averageBytesPerSecond).toBe(20);
  expect(result.recentBytesPerSecond).toBe(10);
  expect(result.etaAverage).toMatchObject({ remainingSeconds: 20 });
  expect(result.etaRecent).toMatchObject({ remainingSeconds: 40 });
});

test("control schema rejects unversioned, oversized and unexpected fields without exposing payloads", () => {
  for (const line of ['{"event":"ready","size":1}', 'PFT1 {"event":"ready","size":104857601}',
    'PFT1 {"event":"progress","bytes":-1}', 'PFT1 {"event":"error","code":"io_failed"}',
    'PFT1 {"event":"ready","size":1,"payload":"secret"}', "PFT1 " + "x".repeat(8192)]) {
    expect(() => parseFileEvent(line)).toThrow("protocol_error");
  }
  expect(parseFileEvent('PFT1 {"event":"ready","size":0}')).toEqual({ event: "ready", size: 0 });
});

test("wire state machine requires verification and publication before upload completion", () => {
  const hash = "a".repeat(64);
  const events: Exclude<FileEvent, { event: "error" }>[] = [
    { event: "ready", size: 8 }, { event: "phase", phase: "transferring" }, { event: "progress", bytes: 8 },
    { event: "phase", phase: "verifying" }, { event: "verified", bytes: 8, sha256: hash },
    { event: "phase", phase: "awaiting_commit" }, { event: "phase", phase: "publishing" }, { event: "complete", bytes: 8, sha256: hash },
  ];
  let state: FileProtocolState = "initial";
  for (const event of events) state = advanceFileProtocol(state, "upload", event);
  expect(state).toBe("complete");
  for (const [direction, from, event] of [
    ["upload", "initial", { event: "progress", bytes: 0 }],
    ["upload", "transferring", { event: "complete", bytes: 8, sha256: hash }],
    ["upload", "verifying", { event: "phase", phase: "transferring" }],
    ["upload", "publishing", { event: "phase", phase: "complete" }],
    ["upload", "verified", { event: "phase", phase: "publishing" }],
    ["download", "transferring", { event: "verified", bytes: 8, sha256: hash }],
    ["download", "complete", { event: "ready", size: 8, sha256: hash }],
  ] as const) expect(() => advanceFileProtocol(from, direction, event)).toThrow("protocol_error");
});

test("a byte write waits for sink acknowledgement under backpressure", async () => {
  let acknowledge: (() => void) | undefined;
  let settled = false;
  const sink = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { acknowledge = callback; } });
  try {
    const writing = writeBytes(sink, Buffer.alloc(65_536), new AbortController().signal).then(() => { settled = true; });
    await Promise.resolve();
    expect(acknowledge).toBeDefined();
    expect(settled).toBe(false);
    acknowledge!();
    await writing;
    expect(settled).toBe(true);
  } finally { sink.destroy(); }
});

const request = { environment: "fixture", direction: "upload" as const, localPath: "host", targetPath: "target", source: { targetId: "host", path: "host" }, destination: { targetId: "fixture", path: "target" } };
const receipt = { bytes: 100, sha256: "a".repeat(64), published: true as const };

function controlled() {
  let now = 0;
  let execution: FileExecution | undefined;
  const done = Promise.withResolvers<typeof receipt>();
  const manager = new FileTransfers(async (value) => {
    execution = value;
    await Promise.race([done.promise, new Promise<never>((_, reject) => {
      value.signal.addEventListener("abort", () => reject(value.signal.reason), { once: true });
    })]);
    return receipt;
  }, ["fixture"], { now: () => now, wallNow: () => now });
  return { manager, done, execution: () => execution!, time: (value: number) => { now = value; } };
}

test("wait budgets ignore progress, preserve task deadlines, and terminal receipts are stable", async () => {
  const c = controlled();
  try {
    const first = await c.manager.start(request, undefined, 0);
    const waiting = c.manager.wait(first.transfer_id, 1);
    c.time(20_000);
    c.execution().observe({ total: 100, bytes: 80, phase: "transferring" });
    let settled = false;
    void waiting.then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    const next = await waiting;
    expect(next).toMatchObject({ state: "running", transferredBytes: 80, deadlineRemainingSeconds: 580, etaAverage: { remainingSeconds: 5 } });
    await expect(c.manager.start(request, undefined, 0)).rejects.toMatchObject({ code: "busy" });
    for (const invalid of [-1, 121, 0.5]) await expect(c.manager.wait(first.transfer_id, invalid)).rejects.toMatchObject({ code: "invalid_input" });
    const observer = new AbortController();
    const observation = c.manager.wait(first.transfer_id, 1, observer.signal);
    observer.abort();
    await expect(observation).rejects.toBeDefined();
    expect(c.execution().signal.aborted).toBe(false);
    c.execution().observe({ bytes: 100, phase: "publishing" });
    expect(c.manager.snapshot(first.transfer_id)).toMatchObject({ state: "running", phase: "publishing", transferredBytes: 100,
      etaAverage: { remainingSeconds: 0 }, etaRecent: { remainingSeconds: 0 } });
    c.done.resolve(receipt);
    const terminal = await c.manager.wait(first.transfer_id, 1);
    expect(terminal).toEqual({ transfer_id: first.transfer_id, state: "completed", source: request.source, destination: request.destination, receipt });
    c.time(30_000);
    expect(await c.manager.wait(first.transfer_id, 120)).toEqual(terminal);
    c.time(619_999);
    expect(await c.manager.wait(first.transfer_id, 0)).toEqual(terminal);
    c.time(620_000);
    expect(() => c.manager.snapshot(first.transfer_id)).toThrow("unknown_transfer");
  } finally { await c.manager.close(); }
});

test("initial wait ignores phase changes and returns on terminal completion", async () => {
  const c = controlled();
  try {
    let settled = false;
    const initial = c.manager.start(request, undefined, 1).then((value) => { settled = true; return value; });
    c.execution().observe({ phase: "connecting" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    c.done.resolve(receipt);
    expect(await initial).toMatchObject({ state: "completed", source: request.source, destination: request.destination, receipt });
  } finally { await c.manager.close(); }
});

test("sustained high-frequency progress retains the recent window when speed changes", async () => {
  const c = controlled();
  try {
    const first = await c.manager.start(request, undefined, 0);
    c.execution().observe({ total: 1000, phase: "transferring" });
    // 10 bytes/s for 15 seconds, then 30 bytes/s for 15 seconds; observations arrive every 100 ms.
    for (let ms = 100; ms <= 30_000; ms += 100) {
      c.time(ms);
      const bytes = ms <= 15_000 ? ms / 100 : 150 + (ms - 15_000) * 3 / 100;
      c.execution().observe({ bytes });
    }
    const snapshot = c.manager.snapshot(first.transfer_id);
    if (snapshot.state !== "running") throw new Error("expected running transfer");
    expect(snapshot.averageBytesPerSecond).toBe(20);
    expect(snapshot.recentBytesPerSecond).toBe(30);
    expect(snapshot.etaAverage).toMatchObject({ remainingSeconds: 20 });
    expect(snapshot.etaRecent).toMatchObject({ remainingSeconds: 40 / 3 });
  } finally { await c.manager.close(); }
});

test("receipt count eviction preserves active jobs and the latest 64 terminal receipts", async () => {
  const done = Promise.withResolvers<never>();
  const manager = new FileTransfers(async ({ request, signal }) => {
    if (request.environment === "active") {
      signal.addEventListener("abort", () => done.reject(signal.reason), { once: true });
      return done.promise;
    }
    return receipt;
  }, ["fixture", "active"]);
  try {
    const active = await manager.start({ ...request, environment: "active" }, undefined, 0);
    const ids: string[] = [];
    for (let index = 0; index < 65; index++) ids.push((await manager.start(request)).transfer_id);
    expect(() => manager.snapshot(ids[0])).toThrow("unknown_transfer");
    expect(manager.snapshot(ids[1]).state).toBe("completed");
    expect(manager.snapshot(ids[64]).state).toBe("completed");
    expect(manager.snapshot(active.transfer_id).state).toBe("running");
  } finally { await manager.close(); }
});

test("cleanup observations do not overwrite the original failure phase", async () => {
  const manager = new FileTransfers(async ({ observe }) => {
    observe({ phase: "cleanup" });
    throw new TransferFault("hash_mismatch", "unpublished", false, "verifying");
  }, ["fixture"]);
  try {
    expect(await manager.start(request)).toMatchObject({ state: "failed", source: request.source, destination: request.destination, failure: { code: "hash_mismatch", phase: "verifying", postState: "unpublished", cleanupFailed: false } });
  } finally { await manager.close(); }
});

test("initial-call cancellation and explicit cancel terminate the job, while close owns remaining jobs", async () => {
  const c = controlled();
  const signal = new AbortController();
  try {
    const initial = c.manager.start(request, signal.signal, 1);
    signal.abort();
    await expect(initial).rejects.toBeDefined();
    expect(c.execution().signal.aborted).toBe(true);
    const first = await c.manager.start(request, undefined, 0);
    c.manager.cancel(first.transfer_id);
    expect((await c.manager.wait(first.transfer_id, 1)).state).toBe("cancelled");
    const second = await c.manager.start(request, undefined, 0);
    await c.manager.close();
    expect(c.manager.snapshot(second.transfer_id)).toMatchObject({ state: "cancelled", failure: { code: "server_closed" } });
  } finally { await c.manager.close(); }
});

test("progress and waiting cannot reset the absolute deadline", async () => {
  const c = controlled();
  try {
    const first = await c.manager.start(request, undefined, 0);
    c.time(600_000);
    c.execution().observe({ total: 100, bytes: 80, phase: "transferring" });
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(c.manager.snapshot(first.transfer_id)).toMatchObject({ state: "failed", failure: { code: "deadline" } });
  } finally { await c.manager.close(); }
});

test.each([
  ["preparing", 60_000, "phase_timeout"], ["connecting", 30_000, "phase_timeout"],
  ["verifying", 60_000, "phase_timeout"], ["awaiting_commit", 10_000, "phase_timeout"], ["publishing", 10_000, "phase_timeout"],
  ["transferring", 60_000, "stalled"],
] as const)("%s enforces its own deadline without waiting ten minutes", async (phase, elapsed, code) => {
  const c = controlled();
  try {
    const first = await c.manager.start(request, undefined, 0);
    c.execution().observe({ phase });
    c.time(elapsed);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(c.manager.snapshot(first.transfer_id)).toMatchObject({ state: "failed", failure: { code, phase } });
  } finally { await c.manager.close(); }
});

test("only effective byte progress resets the transfer stall clock", async () => {
  const c = controlled();
  try {
    const first = await c.manager.start(request, undefined, 0);
    c.execution().observe({ phase: "transferring", total: 100 });
    c.time(59_000);
    c.execution().observe({ bytes: 80 });
    c.time(61_000);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(c.manager.snapshot(first.transfer_id).state).toBe("running");
    c.time(119_000);
    c.execution().observe({ bytes: 80 });
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(c.manager.snapshot(first.transfer_id)).toMatchObject({ state: "failed", failure: { code: "stalled" } });
  } finally { await c.manager.close(); }
});

test("executor failure has a safe category and never exposes raw diagnostics", async () => {
  const c = new FileTransfers(async () => { throw new Error("secret-path diagnostic"); }, ["fixture"]);
  try {
    const result = await c.start(request);
    expect(result).toMatchObject({ state: "failed", failure: { code: "io_failed" } });
    expect(JSON.stringify(result)).not.toContain("secret-path");
  } finally { await c.close(); }
  expect(new TransferFault("conflict").message).toContain("不会自动重试");
});
