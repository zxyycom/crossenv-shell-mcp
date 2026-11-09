import { z } from "zod/v4";
import { shellEnvironmentDescription, shellIdentifier, type ShellEnvironment } from "./catalog.ts";
import { fileLimits } from "./files/contract.ts";

export const shellTimeoutMs = 600_000;
export const shellCommandLimit = 8192;
export const projectShellServerInfo = { name: "project-shell", version: "3.0.0" };
export const projectShellToolNames = ["shell", "transfer_file", "wait_transfer", "cancel_transfer"] as const;
const waitSeconds = z.number().int().min(0).max(120).optional().describe("Wait budget in seconds, 0–120; default 5. Zero returns immediately; positive waits until terminal or budget expires.");
export const transferIdSchema = z.string().uuid();
export const waitTransferSchema = z.object({ transfer_id: transferIdSchema, wait_seconds: waitSeconds });
export const cancelTransferSchema = z.object({ transfer_id: transferIdSchema });
export function fileToolSchema(catalog: readonly ShellEnvironment[], hostTargetId?: string) {
  const filePath = z.string().min(1).refine((value) => Buffer.byteLength(value, "utf8") <= fileLimits.pathBytes && !/[\x00-\x1f\x7f]/.test(value), "路径须为不含控制字符的绝对路径，最多 4096 UTF-8 字节");
  const styles = catalog.map((route) => `${route.environment}: ${route.shell === "bash" ? "POSIX" : "Windows"}`).join("; ");
  const endpoint = z.object({ targetId: z.enum([...new Set([...(hostTargetId ? [hostTargetId] : []), ...catalog.map(({ environment }) => environment)])]).describe(`Canonical target ID. Host is ${hostTargetId ?? "unavailable"} (Windows); exactly one endpoint must be host. Target path styles: ${styles}.`), path: filePath.describe("Literal absolute path on this endpoint; parent must exist; no links or overwrite.") });
  return z.object({ source: endpoint, destination: endpoint, wait_seconds: waitSeconds });
}
export const fileToolDescription = "Transfer one ordinary file (up to 100 MiB) between the host and a different registered target, exactly one host endpoint. Requires authorization for exact paths. SHA-256 and no-overwrite publication; bytes stay out of model context. Wait budget 0–120 seconds, default 5. If running, wait_transfer using the ID, never restart. ETAs estimate bytes only; terminal receipt confirms publication and cleanup.";

export function shellToolSchema(catalog: readonly ShellEnvironment[]) {
  if (!catalog.length) throw new Error("Shell catalog 不能为空");
  const command = z.string().refine((value) => {
    const length = Array.from(value).length;
    return length > 0 && length <= shellCommandLimit && !value.includes("\0");
  }, "command 必须包含 1 至 8192 个 Unicode 字符且不含 NUL").describe("Non-secret UTF-8 source, 1–8192 Unicode characters without NUL; no TTY or additional stdin.").meta({ minLength: 1, maxLength: shellCommandLimit });
  const branches = catalog.map((route) => z.object({
    targetId: z.literal(route.environment).describe(`${route.displayName}; shell ${shellIdentifier(route)}`),
    shell: z.literal(shellIdentifier(route)).describe("Required fixed interpreter product and major.minor for this target."), command,
  }));
  return z.discriminatedUnion("targetId", branches as [typeof branches[number], ...typeof branches]);
}
export function shellToolDescription(catalog: readonly ShellEnvironment[]): string {
  return "Run non-secret source once on the selected target with its fixed shell product and major.minor. No TTY or additional stdin. Commands can change target state. Supported pairs: " + shellEnvironmentDescription(catalog);
}
export function shellToolsConfiguration(catalog: readonly ShellEnvironment[]) {
  return { transport: "stdio", runtime: "node", tools: [
    { name: "shell", parameters: ["targetId", "shell", "command"], environments: catalog.map((route) => ({ targetId: route.environment, shell: shellIdentifier(route) })), commandLimit: shellCommandLimit, timeoutMs: shellTimeoutMs },
    { name: "transfer_file", parameters: ["source", "destination", "wait_seconds"], byteLimit: fileLimits.bytes, timeoutMs: fileLimits.totalMs },
    { name: "wait_transfer", parameters: ["transfer_id", "wait_seconds"], waitSeconds: 120 },
    { name: "cancel_transfer", parameters: ["transfer_id"] },
  ] };
}
