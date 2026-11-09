import path from "node:path";
import { readFileSync } from "node:fs";
import { blocked } from "./errors.ts";
import { resolveSystemOpenSshPrograms, runSshProcess, type SshProcessRunner, type SshProcessResult } from "./process.ts";
import { ExecutionClientError, readExecutionClient } from "./execution-client.ts";
import { loadSshTargets, targetShells, type SshTargetRegistry, type SshTargetSource } from "./source.ts";

export type SshExecutionContext = {
  registry?: SshTargetRegistry;
  registryPath?: string;
  prepared?: Record<string, PreparedTarget | SshPreparationError>;
};

type PreparedTarget = Awaited<ReturnType<typeof readExecutionClient>> & { ssh: string };
export class SshPreparationError extends Error {
  readonly stage = "prepare" as const;
  readonly execution = "not_started" as const;
  readonly code: "unknown_target" | "execution_client_missing" | "execution_client_invalid" | "program_unavailable";
  constructor(code: SshPreparationError["code"], message: string) { super(message); this.code = code; }
}

/** Snapshot each unit once; an unavailable unit does not prevent independent routes. */
export async function prepareSshExecution(registry: SshTargetRegistry, executionRoot: string, registryPath: string): Promise<SshExecutionContext> {
  if (!path.isAbsolute(executionRoot) || /[\x00-\x1f\x7f"%$]/.test(executionRoot) || !path.isAbsolute(registryPath)) throw new Error("SSH 路径必须是安全的绝对路径");
  let root: string;
  let ssh: string;
  try {
    root = executionRoot;
    ssh = (await resolveSystemOpenSshPrograms()).ssh;
  } catch {
    return { registry, registryPath, prepared: Object.fromEntries(registry.targets.map(({ targetId }) =>
      [targetId, new SshPreparationError("program_unavailable", "SSH 执行客户端位置或程序不可用")])) };
  }
  const entries = await Promise.all(registry.targets.map(async ({ targetId }) => {
    try { return [targetId, { ...await readExecutionClient(root, targetId), ssh }] as const; }
    catch (error) {
      return [targetId, new SshPreparationError(error instanceof ExecutionClientError && error.code === "missing"
        ? "execution_client_missing" : "execution_client_invalid", "SSH 执行客户端未准备或无效；请重新发布并重载")] as const;
    }
  }));
  return { registry, registryPath, prepared: Object.fromEntries(entries) };
}

/** Both dialects receive UTF-8 source on stdin; encoded PowerShell carries only a fixed bootstrap. */
export function targetShellInvocation(shell: SshTargetSource["shell"], command: string, shellVersion?: string): { argv: string[]; stdin?: Uint8Array } {
  const normalized = command.replace(/\r\n?/g, "\n");
  if (normalized.includes("\0")) throw new Error("SSH shell source 不得含 NUL");
  if (shellVersion !== undefined && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(shellVersion)) throw new Error("Shell version 必须为 major.minor");
  if (shell === "bash") {
    const guard = shellVersion === undefined ? "" : readFileSync(new URL("./bash-version-guard.sh", import.meta.url), "utf8");
    return {
      argv: ["env", "-u", "BASH_ENV", "-u", "ENV", "bash", "--noprofile", "--norc", "-s", "--", ...(shellVersion === undefined ? [] : [shellVersion])],
      stdin: new TextEncoder().encode(guard + normalized),
    };
  }
  const powershellBootstrap = readFileSync(new URL("./windows-powershell-stdin.ps1", import.meta.url), "utf8");
  const header = shellVersion === undefined ? "-\n" : `${shellVersion}:${shell === "windows-powershell" ? "Desktop" : "Core"}\n`;
  return {
    argv: [targetShells[shell].program, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(powershellBootstrap, "utf16le").toString("base64")],
    stdin: new TextEncoder().encode(header + normalized),
  };
}

function sshProgramPrefix(config: string, ssh = "ssh.exe"): string[] {
  return [ssh, "-F", config, "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", "UpdateHostKeys=no", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ConnectionAttempts=1"];
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** Target ID is the only routing selector; all SSH policy is owned here, not in MCP. */
export async function executeSshTargetShell(
  targetId: string, command: string, runner: SshProcessRunner = runSshProcess,
  environment: Record<string, string> = inheritedEnvironment(), context: SshExecutionContext = {},
): Promise<SshProcessResult> {
  if (command.includes("\0")) throw new Error("SSH shell source 不得含 NUL");
  const outcome = await withSshTargetConnection(targetId, ({ source, config, argv }) => {
    const invocation = targetShellInvocation(source.shell, command, source.shellVersion);
    return runner([...argv, ...invocation.argv], environment, invocation.stdin);
  }, runner, environment, context);
  if (outcome.cleanupFailed) blocked("ssh_session_cleanup_failed", `SSH 命令已返回退出码 ${outcome.result.exitCode}；本次临时 SSH 配置清理失败，需核对会话残留；不会自动重试命令`);
  return outcome.result;
}

/** Keeps trust checks and temporary jump configuration alive for the complete operation. */
export async function withSshTargetConnection<T>(
  targetId: string,
  operation: (connection: { source: SshTargetSource; config: string; argv: string[] }) => Promise<T>,
  runner: SshProcessRunner = runSshProcess,
  environment: Record<string, string> = inheritedEnvironment(), context: SshExecutionContext = {},
): Promise<{ result: T; cleanupFailed: boolean }> {
  if (context.prepared) {
    const prepared = context.prepared[targetId];
    if (!prepared) throw new SshPreparationError("unknown_target", "SSH 目标未在启动声明中登记");
    if (prepared instanceof SshPreparationError) throw prepared;
    if (!context.registryPath) throw new SshPreparationError("execution_client_invalid", "SSH registry 路径缺失");
    const current = loadSshTargets(context.registryPath);
    if (prepared.registry.targets.some((member) => !current.targets.some((entry) => entry.targetId === member.targetId))) {
      throw new SshPreparationError("unknown_target", "SSH 发布单元成员已不在当前登记中");
    }
    return { result: await operation({ source: prepared.source, config: prepared.config,
      argv: [...sshProgramPrefix(prepared.config, prepared.ssh), prepared.source.sshAlias] }), cleanupFailed: false };
  }
  throw new SshPreparationError("execution_client_missing", "SSH 执行客户端未准备");
}
