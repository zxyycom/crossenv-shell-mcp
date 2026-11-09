import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileLimits, TransferFault, transferFault, type FileExecutor, type TransferRequest, type TransferProgress,
  type TransferSnapshot, type TransferPhase, type TransferOutcome } from "./contract.ts";
import { estimateTransfer, type ByteSample } from "./eta.ts";

type Task = {
  id: string;
  request: TransferRequest;
  controller: AbortController;
  phase: TransferPhase;
  phaseStarted: number;
  started: number;
  lastIo: number | null;
  total: number | null;
  bytes: number;
  samples: ByteSample[];
  outcome: TransferOutcome;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval>;
  done: Promise<void>;
  ended?: number;
};

/** Owns one MCP process's bounded operations, not a persistent job service. */
export class FileTransfers {
  private readonly tasks = new Map<string, Task>();
  private closing = false;
  private shutdown?: Promise<void>;
  private readonly execute: FileExecutor;
  private readonly environments: readonly string[];
  private readonly clock: { now: () => number; wallNow: () => number };
  constructor(execute: FileExecutor, environments: readonly string[],
    clock = { now: () => performance.now(), wallNow: () => Date.now() }) {
    this.execute = execute;
    this.environments = environments;
    this.clock = clock;
  }

  private prune(): void {
    const finished = [...this.tasks.values()].filter((task) => task.ended !== undefined)
      .sort((a, b) => a.ended! - b.ended!);
    for (const [index, task] of finished.entries()) {
      if (this.clock.now() - task.ended! >= fileLimits.receiptMs || finished.length - index > fileLimits.receipts) this.tasks.delete(task.id);
    }
  }

  private changed(task: Task): void {
    for (const notify of [...task.listeners]) notify();
  }

  private observe(task: Task, event: TransferProgress): void {
    if (task.outcome.state !== "running" || task.controller.signal.aborted) return;
    const now = this.clock.now();
    if (event.total !== undefined) {
      if (!Number.isSafeInteger(event.total) || event.total < 0 || event.total > fileLimits.bytes) throw new TransferFault("protocol_error");
      if (task.total !== null && event.total !== task.total) throw new TransferFault("source_changed");
      task.total = event.total;
    }
    if (event.bytes !== undefined) {
      if (!Number.isSafeInteger(event.bytes) || event.bytes < task.bytes || event.bytes > (task.total ?? fileLimits.bytes)) throw new TransferFault("protocol_error");
      if (event.bytes > task.bytes) task.lastIo = now;
      task.bytes = event.bytes;
      const last = task.samples.at(-1)!;
      // Preserve fixed observations: replacing every recent sample erases the entire window under sustained I/O.
      if (now - last.at >= 250) task.samples.push({ at: now, bytes: task.bytes });
      while (task.samples.length > 2 && task.samples[1].at < now - 15_000) task.samples.shift();
    }
    if (event.phase && event.phase !== task.phase) {
      task.phase = event.phase;
      task.phaseStarted = now;
      if (event.phase === "transferring") task.lastIo ??= now;
    }
  }

  private tick(task: Task): void {
    const now = this.clock.now();
    let code: "deadline" | "phase_timeout" | "stalled" | undefined;
    if (now - task.started >= fileLimits.totalMs) code = "deadline";
    const phaseLimit = task.phase === "connecting" ? fileLimits.connectMs
      : task.phase === "verifying" || task.phase === "preparing" ? fileLimits.verifyMs
      : task.phase === "awaiting_commit" || task.phase === "publishing" ? fileLimits.publishMs : undefined;
    if (!code && phaseLimit && now - task.phaseStarted >= phaseLimit) code = "phase_timeout";
    if (!code && task.phase === "transferring" && now - (task.lastIo ?? task.phaseStarted) >= fileLimits.stallMs) code = "stalled";
    if (code) task.controller.abort(new TransferFault(code));
  }

  async start(request: TransferRequest, signal?: AbortSignal, waitSeconds = 5): Promise<TransferSnapshot> {
    signal?.throwIfAborted();
    this.validateWait(waitSeconds);
    this.prune();
    if (this.closing) throw new TransferFault("server_closed", "unpublished");
    if (!this.environments.includes(request.environment)) throw new TransferFault("invalid_input", "unpublished");
    if ([...this.tasks.values()].some((task) => task.outcome.state === "running" && task.request.environment === request.environment)) throw new TransferFault("busy", "unpublished");
    const now = this.clock.now();
    const task: Task = {
      id: randomUUID(), request, controller: new AbortController(), phase: "preparing", phaseStarted: now,
      started: now, lastIo: null, total: null, bytes: 0, samples: [{ at: now, bytes: 0 }],
      outcome: { state: "running" }, listeners: new Set(), timer: setInterval(() => this.tick(task), 200), done: Promise.resolve(),
    };
    task.timer.unref();
    this.tasks.set(task.id, task);
    const cancel = () => task.controller.abort(new TransferFault("cancelled"));
    signal?.addEventListener("abort", cancel, { once: true });
    task.done = this.run(task);
    try { return await this.wait(task.id, waitSeconds, signal); }
    finally { signal?.removeEventListener("abort", cancel); }
  }

  private async run(task: Task): Promise<void> {
    try {
      const receipt = await this.execute({ request: task.request, signal: task.controller.signal, observe: (event) => this.observe(task, event) });
      task.outcome = { state: "completed", receipt };
      task.phase = "complete";
      task.phaseStarted = this.clock.now();
    } catch (error) {
      const fault = transferFault(error);
      const reason = task.controller.signal.aborted && !fault.cleanupFailed
        ? transferFault(task.controller.signal.reason) : fault;
      task.outcome = {
        state: reason.code === "cancelled" || reason.code === "server_closed" ? "cancelled" : "failed",
        failure: { code: reason.code, phase: fault.phase ?? task.phase, postState: fault.postState, cleanupFailed: fault.cleanupFailed },
      };
    } finally {
      clearInterval(task.timer);
      task.ended = this.clock.now();
      this.changed(task);
      this.prune();
    }
  }

  private get(id: string): Task {
    this.prune();
    const task = this.tasks.get(id);
    if (!task) throw new TransferFault("unknown_transfer");
    return task;
  }

  snapshot(id: string): TransferSnapshot {
    const task = this.get(id);
    if (task.outcome.state !== "running") {
      return { transfer_id: id, source: task.request.source, destination: task.request.destination, ...task.outcome };
    }
    const now = this.clock.now();
    const wallNow = this.clock.wallNow();
    return {
      transfer_id: id, state: "running", phase: task.phase,
      transferredBytes: task.bytes, totalBytes: task.total,
      lastProgressAgeSeconds: task.lastIo === null ? null : (now - task.lastIo) / 1000,
      ...estimateTransfer({ now, wallNow, started: task.started, bytes: task.bytes, total: task.total, samples: task.samples, state: "running" }),
      deadlineRemainingSeconds: Math.max(0, (fileLimits.totalMs - now + task.started) / 1000),
    };
  }

  private validateWait(waitSeconds: number): void {
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 120) throw new TransferFault("invalid_input", "unpublished");
  }

  async wait(id: string, waitSeconds = 5, signal?: AbortSignal): Promise<TransferSnapshot> {
    signal?.throwIfAborted();
    this.validateWait(waitSeconds);
    const task = this.get(id);
    if (task.outcome.state === "running" && waitSeconds > 0) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); task.listeners.delete(finish); signal?.removeEventListener("abort", abort); };
        const finish = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal?.reason); };
        const timer = setTimeout(finish, waitSeconds * 1000);
        task.listeners.add(finish);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    signal?.throwIfAborted();
    return this.snapshot(id);
  }

  cancel(id: string): TransferSnapshot {
    const task = this.get(id);
    if (task.outcome.state === "running") task.controller.abort(new TransferFault("cancelled"));
    return this.snapshot(id);
  }

  close(): Promise<void> {
    this.shutdown ??= this.stop();
    return this.shutdown;
  }

  private async stop(): Promise<void> {
    this.closing = true;
    const tasks = [...this.tasks.values()];
    for (const task of tasks) if (task.outcome.state === "running") task.controller.abort(new TransferFault("server_closed"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(tasks.map((task) => task.done)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TransferFault("cleanup_failed", "unknown", true)), fileLimits.cleanupMs);
      })]);
    } finally { clearTimeout(timer); }
  }
}
