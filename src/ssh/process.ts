import { spawn } from "node:child_process";
import { text } from "node:stream/consumers";
import fs from "node:fs/promises";
import path from "node:path";
import { SshTargetBoundaryError } from "./errors.ts";

export type SshProcessResult = { exitCode: number; stdout: string; stderr: string };
export type SshProcessRunner = (
  argv: string[], environment: Record<string, string>, stdin?: Uint8Array,
) => Promise<SshProcessResult>;

/** Resolve Windows' own OpenSSH tools, never a PATH-selected distribution. */
export async function resolveSystemOpenSshPrograms(environment: NodeJS.ProcessEnv = process.env): Promise<{ ssh: string; sshAdd: string; sshKeygen: string }> {
  const windir = environment.SystemRoot ?? environment.WINDIR;
  if (!windir || !path.isAbsolute(windir)) throw new Error("Windows 系统目录不可用");
  const directory = path.join(windir, "System32", "OpenSSH");
  const programs = { ssh: path.join(directory, "ssh.exe"), sshAdd: path.join(directory, "ssh-add.exe"), sshKeygen: path.join(directory, "ssh-keygen.exe") };
  for (const program of Object.values(programs)) {
    if (!(await fs.stat(program)).isFile()) throw new Error("Windows 系统 OpenSSH 程序不可用");
  }
  return programs;
}

export const SSH_PROCESS_TIMEOUT_MS = 30_000;

export async function runSshProcess(
  argv: string[], environment: Record<string, string>, stdin?: Uint8Array,
  timeoutMs = SSH_PROCESS_TIMEOUT_MS,
): Promise<SshProcessResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("SSH 本机进程 deadline 必须是正整数毫秒");
  const [executable, ...args] = argv;
  if (!executable) throw new Error("SSH 本机进程缺少可执行文件");
  const child = spawn(executable, args, {
    env: environment, stdio: "pipe",
    shell: false, windowsHide: true,
  });
  let timedOut = false;
  let inputFailure: Error | undefined;
  const completed = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (timedOut) {
        reject(new SshTargetBoundaryError("ssh_process_timeout", "SSH 本机子进程超过执行时间上限，已停止本机进程；不会自动重试"));
      } else if (code === null) {
        reject(new SshTargetBoundaryError("ssh_execution_interrupted", "SSH 本机子进程被中断；远端命令可能已经执行，不会自动重试"));
      } else if (inputFailure && code === 0) {
        reject(inputFailure);
      } else {
        resolve(code);
      }
    });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  child.stdin.once("error", (error: Error) => { inputFailure = error; });
  child.stdin.end(stdin);
  const output = Promise.all([
    completed, text(child.stdout), text(child.stderr),
  ]);
  try {
    const [exitCode, stdout, stderr] = await output;
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      // A stream failure owns the result; cleanup must not replace it.
      await completed.catch(() => undefined);
    }
  }
}
