import { targetShells, type SshTarget } from "./ssh/source.ts";
import { SshPreparationError, type SshExecutionContext } from "./ssh/ssh-execution.ts";
import type { RuntimeConfig } from "./config.ts";

export type ShellEnvironment = { environment: string; displayName: string; shell: SshTarget["shell"]; shellVersion: string } &
  ({ backend: "wsl" | "ai-dev" } | { backend: "ssh"; targetId: string });
export function buildShellCatalog(targets: readonly Pick<SshTarget, "targetId" | "displayName" | "shell" | "shellVersion">[], config: RuntimeConfig): ShellEnvironment[] {
  const catalog: ShellEnvironment[] = [
    { environment: config.wsl.targetId, displayName: "WSL", backend: "wsl", shell: "bash", shellVersion: config.wsl.shellVersion },
    { environment: config.compose.targetId, displayName: "Compose", backend: "ai-dev", shell: "bash", shellVersion: config.compose.shellVersion },
  ];
  for (const target of targets) {
    if (catalog.some(({ environment }) => environment === target.targetId)) throw new Error("duplicate target ID");
    catalog.push({ environment: target.targetId, displayName: target.displayName, backend: "ssh", targetId: target.targetId, shell: target.shell, shellVersion: target.shellVersion });
  }
  return catalog;
}
export function preparedShellCatalog(catalog: readonly ShellEnvironment[], context: SshExecutionContext): ShellEnvironment[] {
  return catalog.map((route) => {
    if (route.backend !== "ssh") return route;
    const unit = context.prepared?.[route.targetId];
    return !unit || unit instanceof SshPreparationError ? { ...route, displayName: `${route.displayName} (unprepared)` } : { ...route, shell: unit.source.shell, shellVersion: unit.source.shellVersion };
  });
}
export function resolveShellEnvironment(environment: string, catalog: readonly ShellEnvironment[]): ShellEnvironment {
  const route = catalog.find((entry) => entry.environment === environment);
  if (!route) throw new Error(`unknown target ${environment}`);
  return route;
}
export function shellIdentifier(route: ShellEnvironment): string { return `${route.shell === "powershell-7" ? "powershell" : route.shell}-${route.shellVersion}`; }
export function shellEnvironmentDescription(catalog: readonly ShellEnvironment[]): string {
  return catalog.map((route) => `${route.environment}: ${route.displayName} (${shellIdentifier(route)}; ${targetShells[route.shell].description})`).join("; ");
}
