import { readFile } from "node:fs/promises";
import { resolveShellEnvironment, type ShellEnvironment } from "../catalog.ts";
import type { RuntimeConfig } from "../config.ts";
import { childEnvironment, localProgramPrefix } from "../shell-router.ts";
import { runShellProcess } from "../process.ts";
import { withSshTargetConnection, type SshExecutionContext } from "../ssh/ssh-execution.ts";
import { SshTargetBoundaryError } from "../ssh/errors.ts";
import { targetShells, type SshTarget } from "../ssh/source.ts";
import { TransferFault, transferFault } from "./contract.ts";

export type FileProgram = { argv: string[]; environment: Record<string, string>; preamble?: Uint8Array };
export async function fileHelperInvocation(shell: SshTarget["shell"], ssh = false): Promise<Omit<FileProgram, "environment">> {
  if (shell !== "bash") {
    const launcher = (await readFile(new URL("./launch.ps1", import.meta.url), "utf8"))
      .replace("__PROJECT_FILE_STDIO_BASE64__", (await readFile(new URL("./stdio.cs", import.meta.url))).toString("base64"));
    return {
      argv: [targetShells[shell].program, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(launcher, "utf16le").toString("base64")],
      preamble: Buffer.from((await readFile(new URL("./target.ps1", import.meta.url))).toString("base64") + "\n"),
    };
  }
  const source = (await readFile(new URL("./target.sh", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const quote = (value: string) => ssh ? `'${value.replaceAll("'", "'\\''")}'` : value;
  return { argv: ["env", "-u", "BASH_ENV", "-u", "ENV", "bash", "--noprofile", "--norc", "-c", quote(source), "project-file"] };
}

/** Reuses the shell owners' topology and SSH trust, while stdin belongs exclusively to the file protocol. */
export async function withFileRoute<T>(environment: string, signal: AbortSignal,
  operation: (program: FileProgram) => Promise<T>, context: SshExecutionContext, catalog: readonly ShellEnvironment[], config: RuntimeConfig): Promise<T> {
  const route = resolveShellEnvironment(environment, catalog);
  const childEnv = childEnvironment(process.env);
  const runner = (argv: string[], environment: Record<string, string>, stdin?: Uint8Array) =>
    runShellProcess({ argv, environment, stdin, signal });
  const transfer = async (program: FileProgram) => {
    try { return await operation(program); }
    catch (error) { throw transferFault(error); }
  };
  try {
    if (route.backend === "ssh") {
      const outcome = await withSshTargetConnection(route.targetId,
        async ({ source, argv }) => {
          const helper = await fileHelperInvocation(source.shell, true);
          return transfer({ ...helper, argv: [...argv, ...helper.argv], environment: childEnv });
        }, runner, childEnv, context);
      if (outcome.cleanupFailed) throw new TransferFault("cleanup_failed", "unknown", true);
      return outcome.result;
    }
    const prefix = await localProgramPrefix(route.backend, runner, childEnv, config, "direct");
    signal.throwIfAborted();
    const helper = await fileHelperInvocation("bash");
    return await transfer({ ...helper, argv: [...prefix, ...helper.argv], environment: childEnv });
  } catch (error) {
    if (error instanceof TransferFault) throw error;
    if (error instanceof SshTargetBoundaryError && error.reason === "ssh_session_cleanup_failed") throw new TransferFault("cleanup_failed", "unknown", true);
    if (signal.aborted) throw signal.reason;
    throw new TransferFault("target_unavailable", "unknown");
  }
}
