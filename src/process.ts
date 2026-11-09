import path from "node:path";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { text } from "node:stream/consumers";

export class ShellProcessError extends Error {
  readonly code: "invalid_input" | "spawn_failed" | "cancelled" | "execution_interrupted" | "cleanup_failed";
  readonly stage: "execute" | "cleanup";
  readonly execution: "not_started" | "unknown";
  constructor(
    code: ShellProcessError["code"],
    stage: ShellProcessError["stage"],
    execution: ShellProcessError["execution"],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.stage = stage;
    this.execution = execution;
  }
}

export class ShellProcessCleanupError extends ShellProcessError {
  constructor() {
    super("cleanup_failed", "cleanup", "unknown", "停止本次 Shell 本机进程树失败；需核对后态，不会自动重试命令");
  }
}

export type ShellProcessRequest = {
  argv: string[];
  environment: Record<string, string>;
  stdin?: Uint8Array;
  cwd?: string;
  signal?: AbortSignal;
};

/** Only terminates the process tree rooted at the child created by this call. */
export async function stopProcess(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const root = process.env.SystemRoot;
      if (!root || !path.win32.isAbsolute(root)) { reject(new ShellProcessCleanupError()); return; }
      const stop = spawn(path.win32.join(root, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      stop.once("error", () => reject(new ShellProcessCleanupError()));
      stop.once("close", (code) => {
        if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve();
        else reject(new ShellProcessCleanupError());
      });
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw new ShellProcessCleanupError();
    }
  }
}

export async function runShellProcess(
  { argv, environment, stdin, cwd, signal }: ShellProcessRequest,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (signal?.aborted) throw new ShellProcessError("cancelled", "execute", "not_started", "Shell 调用在启动前取消");
  const [executable, ...args] = argv;
  if (!executable) throw new ShellProcessError("spawn_failed", "execute", "not_started", "Shell 本机进程缺少可执行文件");
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(executable, args, {
      cwd,
      env: environment,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
  } catch {
    throw new ShellProcessError("spawn_failed", "execute", "not_started", "Shell 本机进程无法启动");
  }
  let inputFailure: Error | undefined;
  let stopping: Promise<void> | undefined;
  const stopFailed = Promise.withResolvers<never>();
  const abort = () => {
    stopping ??= stopProcess(child).catch((error) => {
      child.unref();
      throw error;
    }).finally(() => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    });
    void stopping.catch(stopFailed.reject);
  };
  const completed = new Promise<number>((resolve, reject) => {
    let started = false;
    child.once("spawn", () => { started = true; });
    child.once("error", () => reject(started
      ? new ShellProcessError("execution_interrupted", "execute", "unknown", "Shell 本机进程被中断；目标可能已经执行，不会自动重试")
      : new ShellProcessError("spawn_failed", "execute", "not_started", "Shell 本机进程无法启动")));
    child.once("close", (code) => {
      if (signal?.aborted) reject(new ShellProcessError("cancelled", "execute", "unknown", "Shell 调用取消；目标可能已经执行，不会自动重试"));
      else if (code === null) reject(new ShellProcessError("execution_interrupted", "execute", "unknown", "Shell 本机进程被中断；目标可能已经执行，不会自动重试"));
      else if (inputFailure && code === 0) reject(new ShellProcessError("execution_interrupted", "execute", "unknown", "Shell 输入传输失败；目标可能已经执行，不会自动重试"));
      else resolve(code);
    });
  });
  child.stdin.once("error", (error: Error) => { inputFailure = error; });
  const output = Promise.all([completed, text(child.stdout), text(child.stderr)]);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  child.stdin.end(stdin);
  try {
    const [exitCode, stdout, stderr] = await Promise.race([output, stopFailed.promise]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    if (error instanceof ShellProcessError) throw error;
    if (signal?.aborted) throw new ShellProcessError("cancelled", "execute", "unknown", "Shell 调用取消；目标可能已经执行，不会自动重试");
    throw new ShellProcessError("execution_interrupted", "execute", "unknown", "Shell 输出读取失败；目标可能已经执行，不会自动重试");
  } finally {
    signal?.removeEventListener("abort", abort);
    if (child.exitCode === null && child.signalCode === null) abort();
    if (stopping) await stopping;
    await completed.catch(() => undefined);
  }
}
