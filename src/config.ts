import { readFileSync } from "node:fs";
import path from "node:path";

export type RuntimeConfig = {
  version: 1;
  host: { targetId: string; binding: "ssh" | "trusted-local" };
  wsl: { targetId: string; distribution: string; user: string; shellVersion: string };
  compose: { targetId: string; wslTargetId: string; project: string; service: string; user: string; workingDirectory: string; shellVersion: string };
  ssh: { registryPath: string; executionRoot: string };
};

export function loadConfig(configPath: string): RuntimeConfig {
  if (!path.isAbsolute(configPath)) throw new Error("--config must be an absolute path");
  const data: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  const object = (value: unknown, name: string): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
    return value as Record<string, unknown>;
  };
  const string = (value: unknown, name: string): string => {
    if (typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} must be a nonempty string`);
    return value;
  };
  const id = (value: unknown, name: string) => {
    const result = string(value, name);
    if (!/^[a-z][a-z0-9_-]*$/.test(result)) throw new Error(`${name} is invalid`);
    return result;
  };
  const version = (value: unknown, name: string) => {
    const result = string(value, name);
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(result)) throw new Error(`${name} must be major.minor`);
    return result;
  };
  const root = object(data, "config"), host = object(root.host, "host"), wsl = object(root.wsl, "wsl"), compose = object(root.compose, "compose"), ssh = object(root.ssh, "ssh");
  if (root.version !== 1) throw new Error("unsupported config version");
  if (host.binding !== "ssh" && host.binding !== "trusted-local") throw new Error("invalid host binding");
  const result: RuntimeConfig = { version: 1,
    host: { targetId: id(host.targetId, "host.targetId"), binding: host.binding },
    wsl: { targetId: id(wsl.targetId, "wsl.targetId"), distribution: string(wsl.distribution, "wsl.distribution"), user: string(wsl.user, "wsl.user"), shellVersion: version(wsl.shellVersion, "wsl.shellVersion") },
    compose: { targetId: id(compose.targetId, "compose.targetId"), wslTargetId: id(compose.wslTargetId, "compose.wslTargetId"), project: string(compose.project, "compose.project"), service: string(compose.service, "compose.service"), user: string(compose.user, "compose.user"), workingDirectory: string(compose.workingDirectory, "compose.workingDirectory"), shellVersion: version(compose.shellVersion, "compose.shellVersion") },
    ssh: { registryPath: string(ssh.registryPath, "ssh.registryPath"), executionRoot: string(ssh.executionRoot, "ssh.executionRoot") } };
  if (result.compose.wslTargetId !== result.wsl.targetId || result.wsl.targetId === result.compose.targetId || result.host.targetId === result.wsl.targetId || result.host.targetId === result.compose.targetId) throw new Error("conflicting target IDs or invalid Compose WSL route");
  if (!path.isAbsolute(result.ssh.registryPath) || !path.isAbsolute(result.ssh.executionRoot) || !path.posix.isAbsolute(result.compose.workingDirectory)) throw new Error("configured paths must be absolute");
  return result;
}
