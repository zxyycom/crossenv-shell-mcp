import path from "node:path";
import { readFile } from "node:fs/promises";
import { executeSshTargetShell, type SshExecutionContext } from "./ssh/ssh-execution.ts";
import { resolveShellEnvironment, type ShellEnvironment } from "./catalog.ts";
import type { RuntimeConfig } from "./config.ts";
import { runShellProcess } from "./process.ts";

export type ProcessResult = { exitCode: number; stdout: string; stderr: string };
export type ProcessRunner = (argv: string[], environment: Record<string, string>, stdin?: Uint8Array) => Promise<ProcessResult>;
export function childEnvironment(parent: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(parent).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
export function shellResultText(result: ProcessResult): string {
  if (!result.stdout) return result.stderr;
  if (!result.stderr) return result.stdout;
  return result.stdout + (result.stdout.endsWith("\n") ? "" : "\n") + result.stderr;
}
export async function localProgramPrefix(backend: "wsl" | "ai-dev", run: ProcessRunner, childEnv: Record<string, string>, config: RuntimeConfig, launch: "shell" | "direct" = "shell"): Promise<string[]> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error("Windows SystemRoot is unavailable");
  const wsl = [path.win32.join(systemRoot, "System32", "wsl.exe"), "--distribution", config.wsl.distribution, "--user", config.wsl.user, "--cd", "~", launch === "direct" ? "--exec" : "--"];
  if (backend === "wsl") return wsl;
  const lookup = await run([...wsl, "docker", "ps", "--filter", `label=com.docker.compose.project=${config.compose.project}`, "--filter", `label=com.docker.compose.service=${config.compose.service}`, "--format", "{{.ID}}"], childEnv);
  if (lookup.exitCode !== 0) throw new Error("failed to locate running Compose container");
  const ids = lookup.stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length !== 1) throw new Error(`expected exactly one running Compose container, found ${ids.length}`);
  return [...wsl, "docker", "exec", "--interactive", "--user", config.compose.user, "--workdir", config.compose.workingDirectory, ids[0]];
}
export async function executeShell(environment: string, command: string, options: { config: RuntimeConfig; catalog: readonly ShellEnvironment[]; context: SshExecutionContext; signal?: AbortSignal; runner?: ProcessRunner; parentEnvironment?: Record<string, string | undefined> }): Promise<ProcessResult> {
  const { config, context, signal } = options;
  signal?.throwIfAborted();
  const run: ProcessRunner = options.runner ?? ((argv, environment, stdin) => runShellProcess({ argv, environment, stdin, signal }));
  const route = resolveShellEnvironment(environment, options.catalog);
  const childEnv = childEnvironment(options.parentEnvironment ?? process.env);
  if (route.backend === "ssh") return executeSshTargetShell(route.targetId, command, run, childEnv, context);
  const guard = await readFile(new URL("./ssh/bash-version-guard.sh", import.meta.url), "utf8");
  const stdin = new TextEncoder().encode(guard + command.replaceAll("\r\n", "\n").replaceAll("\r", "\n"));
  return run([...await localProgramPrefix(route.backend, run, childEnv, config), "bash", "--login", "-s", "--", route.shellVersion], childEnv, stdin);
}
