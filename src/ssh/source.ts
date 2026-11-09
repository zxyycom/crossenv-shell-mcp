import { readFileSync } from "node:fs";
import path from "node:path";
import { isIP } from "node:net";

export const targetShells = {
  bash: { program: "bash", description: "Bash / bash" },
  "windows-powershell": { program: "powershell.exe", description: "Windows PowerShell 5.1 / powershell.exe" },
  "powershell-7": { program: "pwsh.exe", description: "PowerShell 7 / pwsh.exe" },
} as const;

export type SshTarget = {
  targetId: string;
  displayName: string;
  sshAlias: string;
  hostname: string;
  user: string;
  port: number;
  hostKeyAlgorithm: "ssh-ed25519";
  hostKeyFingerprint: string;
  identity: { kind: "agent"; label: string; fingerprint: string };
  shell: keyof typeof targetShells;
  shellVersion: string;
  jumpTargetId?: string;
};
/** Resolved connection input; jumpAlias is derived, never stored in targets.json. */
export type SshTargetSource = SshTarget & { jumpAlias?: string };
export type SshTargetRegistry = { schemaVersion: 1; targets: SshTarget[] };
export type SshTargetPaths = { directory: string; config: string; identity: string; knownHosts: string };
export class SshTargetSourceError extends Error {}

export type SshProbeEndpoint = { address: string; port: number };

/** A one-call route for the fixed identity probe, never a registry or MCP override. */
export function parseSshProbeEndpoint(value: unknown): SshProbeEndpoint {
  if (!object(value)) throw new SshTargetSourceError("SSH 临时端点必须是 object");
  fields(value, ["address", "port"]);
  const address = text(value, "address");
  if (isIP(address) !== 4) throw new SshTargetSourceError("SSH 临时端点只接受明确的 IPv4 地址");
  return { address, port: parsePort(value) };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value: Record<string, unknown>, allowed: string[], required = allowed): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !(key in value))) {
    throw new SshTargetSourceError("SSH 声明字段缺失或包含未知字段");
  }
}

function text(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result || result.trim() !== result || /[\x00-\x1f\x7f]/.test(result)) {
    throw new SshTargetSourceError(`SSH 声明 ${key} 必须是非空、无控制字符的单行字符串`);
  }
  return result;
}

function fingerprint(value: Record<string, unknown>, key: string): string {
  const result = text(value, key);
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(result)
    || Buffer.from(result.slice(7), "base64").toString("base64").replace(/=+$/, "") !== result.slice(7)) {
    throw new SshTargetSourceError(`SSH 声明 ${key} 必须是规范 SHA256 指纹`);
  }
  return result;
}

export function parseSshTarget(value: unknown): SshTarget {
  if (!object(value)) {
    throw new SshTargetSourceError("SSH target 必须是 object");
  }
  const required = ["targetId", "displayName", "sshAlias", "hostname", "user", "port", "hostKeyAlgorithm", "hostKeyFingerprint", "identity", "shell", "shellVersion"];
  fields(value, [...required, "jumpTargetId"], required);
  const targetId = identifier(value, "targetId");
  if (["wsl", "ai-dev"].includes(targetId)) {
    throw new SshTargetSourceError("SSH targetId 不得占用 wsl / ai-dev 内建拓扑");
  }
  if (value.hostKeyAlgorithm !== "ssh-ed25519") {
    throw new SshTargetSourceError("SSH hostKeyAlgorithm 当前只支持 ssh-ed25519");
  }
  const jumpTargetId = value.jumpTargetId === undefined ? undefined : identifier(value, "jumpTargetId");
  const shell = parseShell(value);
  const shellVersion = parseShellVersion(value);
  if ((shell === "windows-powershell" && shellVersion !== "5.1") || (shell === "powershell-7" && !shellVersion.startsWith("7."))) {
    throw new SshTargetSourceError("SSH shell 与 shellVersion 产品不匹配");
  }
  return {
    targetId, displayName: text(value, "displayName"), sshAlias: identifier(value, "sshAlias"),
    hostname: parseHostname(value), user: parseUser(value), port: parsePort(value),
    hostKeyAlgorithm: value.hostKeyAlgorithm, hostKeyFingerprint: fingerprint(value, "hostKeyFingerprint"),
    identity: parseAgentIdentity(value.identity), shell, shellVersion, ...(jumpTargetId ? { jumpTargetId } : {}),
  };
}

function identifier(value: Record<string, unknown>, key: string): string {
  const result = text(value, key);
  if (!/^[a-z][a-z0-9-]*$/.test(result)) {
    throw new SshTargetSourceError(`SSH ${key} 格式无效`);
  }
  return result;
}

function parseHostname(value: Record<string, unknown>): string {
  const hostname = text(value, "hostname");
  if (isIP(hostname) === 0 && !/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(hostname)) {
    throw new SshTargetSourceError("SSH hostname 必须是 IP 或主机名，不能是命令或配置表达式");
  }
  return hostname;
}

function parseUser(value: Record<string, unknown>): string {
  const user = text(value, "user");
  if (!/^[A-Za-z0-9_.\\@-]+$/.test(user)) {
    throw new SshTargetSourceError("SSH user 格式无效");
  }
  return user;
}

function parsePort(value: Record<string, unknown>): number {
  if (typeof value.port !== "number" || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new SshTargetSourceError("SSH port 必须在 1 到 65535 之间");
  }
  return value.port;
}

export function parseShellVersion(value: Record<string, unknown>, key = "shellVersion"): string {
  const version = text(value, key);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new SshTargetSourceError(`${key} 必须为 major.minor`);
  return version;
}

function parseShell(value: Record<string, unknown>): SshTarget["shell"] {
  const shell = value.shell;
  if (typeof shell !== "string" || !Object.hasOwn(targetShells, shell)) {
    throw new SshTargetSourceError(`SSH shell 必须是 ${Object.keys(targetShells).join("、")}`);
  }
  // The external key was checked against the finite registry above.
  return shell as SshTarget["shell"];
}

function parseAgentIdentity(value: unknown): SshTarget["identity"] {
  if (!object(value)) {
    throw new SshTargetSourceError("SSH identity 必须是 object");
  }
  fields(value, ["kind", "label", "fingerprint"]);
  if (value.kind !== "agent") {
    throw new SshTargetSourceError("SSH identity 当前只支持 agent，不读取或采集私钥");
  }
  return { kind: "agent", label: text(value, "label"), fingerprint: fingerprint(value, "fingerprint") };
}

export function parseSshTargets(value: unknown): SshTargetRegistry {
  if (!object(value)) throw new SshTargetSourceError("SSH registry 必须是 object");
  fields(value, ["$schema", "schemaVersion", "targets"], ["schemaVersion", "targets"]);
  if (value.$schema !== undefined && value.$schema !== "./targets.schema.json") throw new SshTargetSourceError("SSH $schema 不匹配");
  if (value.schemaVersion !== 1 || !Array.isArray(value.targets)) throw new SshTargetSourceError("SSH registry schemaVersion / targets 无效");
  const targets = value.targets.map(parseSshTarget);
  for (const key of ["targetId", "sshAlias"] as const) {
    if (new Set(targets.map((target) => target[key])).size !== targets.length) throw new SshTargetSourceError(`SSH ${key} 重复`);
  }
  assertJumpGraph(targets);
  return { schemaVersion: 1, targets };
}

function assertJumpGraph(targets: SshTarget[]): void {
  for (const target of targets) {
    if (!target.jumpTargetId) continue;
    const jump = targets.find((entry) => entry.targetId === target.jumpTargetId);
    if (!jump || jump === target || jump.jumpTargetId) throw new SshTargetSourceError("SSH jumpTargetId 必须引用另一已登记的直连目标；不支持自引用、循环或嵌套跳板");
  }
}

export function loadSshTargets(registryPath: string): SshTargetRegistry {
  if (!path.isAbsolute(registryPath)) throw new SshTargetSourceError("SSH registry 路径必须为绝对路径");
  let value: unknown;
  try { value = JSON.parse(readFileSync(registryPath, "utf8")); }
  catch { throw new SshTargetSourceError("SSH targets.json 不可读或 JSON 无效"); }
  return parseSshTargets(value);
}

export function requireSshTarget(registry: SshTargetRegistry, targetId: string): SshTarget {
  const target = registry.targets.find((entry) => entry.targetId === targetId);
  if (!target) throw new SshTargetSourceError("SSH 目标未登记；需先独立批准身份与 host pin，不尝试 DNS 或其他身份");
  return target;
}

export function resolveSshTarget(registry: SshTargetRegistry, targetId: string): SshTargetSource {
  const target = requireSshTarget(registry, targetId);
  return target.jumpTargetId
    ? { ...target, jumpAlias: requireSshTarget(registry, target.jumpTargetId).sshAlias }
    : target;
}
