import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { stopProcess } from "../process.ts";
import { fileLimits, TransferFault, type TransferProgress } from "./contract.ts";
import { advanceFileProtocol, parseFileEvent, type FileEvent, type FileProtocolState } from "./protocol.ts";

type Reply = Extract<FileEvent, { event: "ready" | "verified" | "complete" }>;

/** A bounded control channel alongside raw stdin/stdout; diagnostics never leave this boundary. */
export class FileChannel {
  private readonly child;
  private readonly replies: Reply[] = [];
  private notify: (() => void) | undefined;
  private failure: TransferFault | undefined;
  private exited = false;
  private state: FileProtocolState = "initial";
  private total = 0;
  private transferred = 0;
  private shutdown?: Promise<void>;
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly done: Promise<void>;
  readonly input: Writable;
  readonly output: Readable;
  private readonly direction: "upload" | "download";
  private readonly observe: (event: TransferProgress) => void;

  constructor(argv: string[], environment: Record<string, string>, direction: "upload" | "download",
    observe: (event: TransferProgress) => void) {
    const [executable, ...args] = argv;
    if (!executable) throw new TransferFault("invalid_input", "unpublished");
    this.direction = direction;
    this.observe = observe;
    this.child = spawn(executable, args, { env: environment, shell: false, windowsHide: true,
      detached: process.platform !== "win32", stdio: "pipe" });
    this.input = this.child.stdin;
    this.output = this.child.stdout;
    if (direction === "upload") this.output.on("data", (chunk: Buffer) => {
      if (chunk.length) this.fail(new TransferFault("protocol_error"));
    });
    // EPIPE is interpreted together with the target's control receipt/exit, not exposed as raw text.
    this.input.on("error", () => {});
    const exit = new Promise<void>((resolve) => {
      this.child.once("error", () => { this.fail(new TransferFault("target_unavailable")); resolve(); });
      this.child.once("close", (code) => {
        if (code !== 0) this.fail(new TransferFault("process_failed"));
        resolve();
      });
    });
    this.done = Promise.all([exit, this.readControl()]).then(() => {
      this.exited = true;
      this.notify?.();
    });
  }

  private fail(error: TransferFault): void {
    this.failure ??= error;
    this.controller.abort(this.failure);
    this.notify?.();
  }

  private accept(event: FileEvent): void {
    if (event.event === "error") {
      // A target receipt can provide more precise post-state than an earlier stream/exit failure.
      const postState = this.direction === "upload" && event.published ? "published" : "unpublished";
      this.failure = new TransferFault(event.code, postState, event.cleanupFailed);
      this.controller.abort(this.failure);
      this.notify?.();
      return;
    }
    this.state = advanceFileProtocol(this.state, this.direction, event);
    switch (event.event) {
      case "phase":
        this.observe({ phase: event.phase });
        return;
      case "progress":
        if (event.bytes < this.transferred || event.bytes > this.total) throw new TransferFault("protocol_error");
        this.transferred = event.bytes;
        this.observe({ bytes: event.bytes });
        return;
      case "ready":
        if (this.direction === "download" && !event.sha256) throw new TransferFault("protocol_error");
        this.total = event.size;
        this.observe({ total: event.size });
        break;
      case "verified": case "complete": break;
    }
    if (this.replies.length >= 3) throw new TransferFault("protocol_error");
    this.replies.push(event);
    this.notify?.();
  }

  private async readControl(): Promise<void> {
    let bytes = 0;
    let pending = "";
    try {
      for await (const chunk of this.child.stderr) {
        bytes += chunk.length;
        if (bytes > fileLimits.controlBytes) throw new TransferFault("protocol_error");
        pending += chunk.toString("utf8");
        let newline: number;
        while ((newline = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, newline).replace(/\r$/, "");
          pending = pending.slice(newline + 1);
          this.accept(parseFileEvent(line));
        }
        if (Buffer.byteLength(pending) > fileLimits.headerBytes) throw new TransferFault("protocol_error");
      }
      if (pending) throw new TransferFault("protocol_error");
    } catch (error) { this.fail(error instanceof TransferFault ? error : new TransferFault("process_failed")); }
  }

  async reply<E extends Reply["event"]>(event: E, signal: AbortSignal): Promise<Extract<Reply, { event: E }>> {
    while (true) {
      signal.throwIfAborted();
      if (this.failure) throw this.failure;
      const next = this.replies.shift();
      if (next) {
        if (next.event !== event) throw new TransferFault("protocol_error");
        // The discriminant was checked above; the generic retains the requested reply shape.
        return next as Extract<Reply, { event: E }>;
      }
      if (this.exited) throw new TransferFault("truncated");
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { this.notify = undefined; signal.removeEventListener("abort", abort); };
        const abort = () => { cleanup(); reject(signal.reason); };
        this.notify = () => { cleanup(); resolve(); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
  }

  async finish(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void this.done.then(resolve).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    if (this.failure) throw this.failure;
    if (this.state !== "complete" || this.replies.length) throw new TransferFault("truncated");
  }

  close(): Promise<void> {
    this.shutdown ??= this.stop();
    return this.shutdown;
  }

  private async stop(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TransferFault("cleanup_failed", "unknown", true)), fileLimits.cleanupMs);
      timer.unref();
    });
    try { await Promise.race([this.stopChild(), timeout]); }
    catch { this.child.unref(); throw new TransferFault("cleanup_failed", "unknown", true); }
    finally {
      clearTimeout(timer);
      this.output.destroy();
      this.child.stderr.destroy();
    }
    // A late target cleanup receipt must survive an earlier local cancellation.
    if (this.failure?.cleanupFailed) throw this.failure;
  }

  private async stopChild(): Promise<void> {
    this.input.destroy();
    // Closing stdin lets a live receiver report truncated and remove its own partial before hard stop.
    let grace: ReturnType<typeof setTimeout> | undefined;
    let quiet: boolean;
    try {
      quiet = await Promise.race([this.done.then(() => true), new Promise<false>((resolve) => { grace = setTimeout(() => resolve(false), 200); })]);
    } finally { clearTimeout(grace); }
    if (!quiet) await stopProcess(this.child);
    this.output.destroy();
    this.child.stderr.destroy();
    await this.done;
  }
}

export async function writeBytes(stream: Writable, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { stream.destroy(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    stream.write(bytes, (error) => { signal.removeEventListener("abort", abort); error ? reject(new TransferFault("process_failed")) : resolve(); });
    if (signal.aborted) abort();
  });
}
