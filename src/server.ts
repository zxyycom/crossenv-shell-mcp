import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import path from "node:path";
import { loadSshTargets } from "./ssh/source.ts";
import { prepareSshExecution, SshPreparationError, type SshExecutionContext } from "./ssh/ssh-execution.ts";
import { buildShellCatalog, preparedShellCatalog, shellIdentifier, shellEnvironmentDescription, type ShellEnvironment } from "./catalog.ts";
import { loadConfig, type RuntimeConfig } from "./config.ts";
import { executeShell, shellResultText, type ProcessResult } from "./shell-router.ts";
import { ShellProcessError } from "./process.ts";
import { projectShellServerInfo, shellTimeoutMs, shellToolDescription, shellToolSchema,
  fileToolSchema, fileToolDescription, waitTransferSchema, cancelTransferSchema } from "./tool-contract.ts";
import { FileTransfers } from "./files/tasks.ts";
import { executeFile } from "./files/execute.ts";
import { withFileRoute } from "./files/route.ts";
import { transferFault, TransferFault, type FileEndpoint, type FileExecutor, type TransferRequest, type TransferSnapshot } from "./files/contract.ts";

function assertHost(config: RuntimeConfig, catalog: readonly ShellEnvironment[], context: SshExecutionContext): void {
  const hostTargetId = config.host.targetId;
  if (process.platform !== "win32") throw new TransferFault("invalid_input", "unpublished");
  if (config.host.binding === "trusted-local") {
    if (catalog.some((entry) => entry.backend === "ssh" && entry.targetId === hostTargetId)) throw new TransferFault("invalid_input", "unpublished");
    return;
  }
  const host = context.prepared?.[hostTargetId];
  let registered = false;
  try { registered = loadSshTargets(config.ssh.registryPath).targets.some((target) => target.targetId === hostTargetId); }
  catch { /* A missing or invalid current registry cannot establish the host binding. */ }
  if (!registered || !host || host instanceof SshPreparationError
    || host.source.targetId !== hostTargetId || !catalog.some((entry) => entry.backend === "ssh" && entry.targetId === hostTargetId)) {
    throw new TransferFault("invalid_input", "unpublished");
  }
}

function validTransferPaths(local: string, remote: string, shell: ShellEnvironment["shell"]): boolean {
  const windowsAbsolute = (value: string) => /^[A-Za-z]:[\\/]/.test(value);
  if (!windowsAbsolute(local)) return false;
  return shell === "bash" ? path.posix.isAbsolute(remote) : windowsAbsolute(remote);
}

function transferRequest(source: FileEndpoint, destination: FileEndpoint, hostTargetId: string,
  catalog: readonly ShellEnvironment[]): TransferRequest {
  if (source.targetId === destination.targetId || Number(source.targetId === hostTargetId) + Number(destination.targetId === hostTargetId) !== 1) throw new TransferFault("invalid_input", "unpublished");
  const upload = source.targetId === hostTargetId;
  const remote = upload ? destination : source;
  const route = catalog.find((entry) => entry.environment === remote.targetId);
  if (!route) throw new TransferFault("invalid_input", "unpublished");
  const local = upload ? source : destination;
  if (!validTransferPaths(local.path, remote.path, route.shell)) throw new TransferFault("invalid_input", "unpublished");
  return { environment: remote.targetId, direction: upload ? "upload" : "download", localPath: local.path, targetPath: remote.path, source, destination };
}

class ProjectShellServer extends McpServer {
  private readonly files: FileTransfers;
  constructor(files: FileTransfers, instructions: string) {
    super(projectShellServerInfo, { instructions });
    this.files = files;
    this.server.onclose = () => { void files.close().catch(() => console.error("文件任务关闭清理失败；需核对后态")); };
  }
  override async close(): Promise<void> {
    const cleanup = this.files.close();
    try { await super.close(); } finally { await cleanup; }
  }
}

async function fileResult(action: () => Promise<TransferSnapshot> | TransferSnapshot, endpoints?: { source: { targetId: string; path: string }; destination: { targetId: string; path: string } }) {
  try {
    const snapshot = await action();
    return { structuredContent: snapshot, content: [{ type: "text" as const, text: JSON.stringify(snapshot) }],
      ...(snapshot.state === "failed" || snapshot.state === "cancelled" ? { isError: true } : {}) };
  } catch (error) {
    const fault = transferFault(error);
    const failure = { ...endpoints, code: fault.code, phase: fault.phase ?? "preparing", postState: fault.postState, cleanupFailed: fault.cleanupFailed };
    return { isError: true, structuredContent: failure, content: [{ type: "text" as const, text: JSON.stringify(failure) }] };
  }
}

export type ShellExecutor = (environment: string, command: string, signal: AbortSignal) => Promise<ProcessResult>;

export async function createProjectShellServer(options: {
  configPath: string;
  catalog?: readonly ShellEnvironment[];
  execute?: ShellExecutor;
  timeoutMs?: number;
  executeFile?: FileExecutor;
  executionContext?: SshExecutionContext;
}) {
  const config = loadConfig(options.configPath);
  const registry = loadSshTargets(config.ssh.registryPath);
  const executionContext = options.executionContext ?? await prepareSshExecution(registry, config.ssh.executionRoot, config.ssh.registryPath);
  const catalog = preparedShellCatalog(options.catalog ?? buildShellCatalog(registry.targets, config), executionContext);
  const hostTargetId = config.host.targetId;
  const execute = options.execute ?? ((environment, command, signal) =>
    executeShell(environment, command, { signal, context: executionContext, catalog, config }));
  const timeoutMs = options.timeoutMs ?? shellTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > shellTimeoutMs) {
    throw new Error(`Shell deadline 必须为 1 至 ${shellTimeoutMs} 的整数毫秒`);
  }
  const fileExecutor: FileExecutor = options.executeFile ?? ((execution) => executeFile(execution,
    (environment, signal, operation) => withFileRoute(environment, signal, operation, executionContext, catalog, config)));
  const files = new FileTransfers(fileExecutor, catalog.map(({ environment }) => environment));
  const server = new ProjectShellServer(files, `MCP host targetId: ${hostTargetId ?? "unavailable"}; OS: ${process.platform}; host paths: ${process.platform === "win32" ? "Windows absolute" : "POSIX absolute"}. Command targets and fixed shell pairs: ${shellEnvironmentDescription(catalog)}. File transfers require distinct endpoints with exactly one host; paths are literal absolute paths on their respective endpoints. Wait budget 0–120 seconds, default 5; terminal receipt confirms publication.`);
  server.registerTool("shell", {
    description: shellToolDescription(catalog),
    inputSchema: shellToolSchema(catalog),
  }, async ({ targetId, shell, command }, context) => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    timer.unref();
    const signal = AbortSignal.any([context.mcpReq.signal, deadline.signal]);
    try {
      if (signal.aborted) throw new ShellProcessError("cancelled", "execute", "not_started", "Shell 调用已取消");
      const route = catalog.find((entry) => entry.environment === targetId);
      if (!route || shellIdentifier(route) !== shell) throw new ShellProcessError("invalid_input", "execute", "not_started", "Shell 目标与版本不匹配");
      const result = await execute(targetId, command, signal);
      if (signal.aborted) throw new ShellProcessError("cancelled", "execute", "unknown", "Shell 调用已取消");
      return {
        content: [{ type: "text", text: shellResultText(result) }],
        structuredContent: { kind: "process", ...result },
        ...(result.exitCode === 0 ? {} : { isError: true }),
      };
    } catch (error) {
      const failure = error instanceof SshPreparationError || error instanceof ShellProcessError
        ? { code: error.code === "cancelled" && deadline.signal.aborted ? "deadline" : error.code, stage: error.stage, execution: error.execution }
        : { code: signal.aborted ? (deadline.signal.aborted ? "deadline" : "cancelled") : "internal_error", stage: "execute", execution: "unknown" };
      return { isError: true, structuredContent: { kind: "failure", ...failure }, content: [{ type: "text", text: "Shell 调用失败；请核对结构化结果，未知后态不会自动重试" }] };
    } finally {
      clearTimeout(timer);
    }
  });
  server.registerTool("transfer_file", {
    description: fileToolDescription,
    inputSchema: fileToolSchema(catalog, hostTargetId),
  }, ({ source, destination, wait_seconds }, context) => fileResult(() => {
    assertHost(config, catalog, executionContext);
    return files.start(transferRequest(source, destination, hostTargetId, catalog), context.mcpReq.signal, wait_seconds);
  }, { source, destination }));
  server.registerTool("wait_transfer", {
    description: "Wait 0–120 seconds (default 5) for terminal state or return a running snapshot with two ETAs. Cancelling this wait does not cancel the transfer; do not restart it.",
    inputSchema: waitTransferSchema, annotations: { readOnlyHint: true },
  }, ({ transfer_id, wait_seconds }, context) => fileResult(() => files.wait(transfer_id, wait_seconds, context.mcpReq.signal)));
  server.registerTool("cancel_transfer", {
    description: "Cancel this process's existing transfer without starting another one. Wait for terminal state to check publication/cleanup; disconnection may leave unknown target state. Never automatically retry a write.",
    inputSchema: cancelTransferSchema,
  }, ({ transfer_id }) => fileResult(() => files.cancel(transfer_id)));
  return server;
}

export function startStdio(options: { configPath: string }) {
  return serveStdio(() => createProjectShellServer(options));
}
