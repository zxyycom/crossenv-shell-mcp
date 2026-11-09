import { readFileSync } from "node:fs";
import type { SshTargetPaths, SshTargetSource } from "./source.ts";
import { blocked } from "./errors.ts";

const template = readFileSync(new URL("./ssh.config.template", import.meta.url), "utf8").replace(/\r\n?/g, "\n");

type TargetMarker = Pick<SshTargetSource, "targetId">;

function blockRange(content: string, source: TargetMarker): { start: number; end: number } | undefined {
  const begin = `# BEGIN wsl-settings ${source.targetId}`;
  const end = `# END wsl-settings ${source.targetId}`;
  const lines = [...content.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)].filter((match) => match[0]);
  const starts = lines.filter((match) => match[0].trim() === begin);
  const ends = lines.filter((match) => match[0].trim() === end);
  if (starts.length === 0 && ends.length === 0) return undefined;
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) {
    blocked("managed_block_invalid", "目标 SSH 受管标记不完整或重复；请先人工核对 config");
  }
  return { start: starts[0].index, end: ends[0].index + ends[0][0].length };
}

export function currentSshTargetBlock(content: string, source: TargetMarker): string | undefined {
  const range = blockRange(content, source);
  return range ? content.slice(range.start, range.end) : undefined;
}

export function removeSshTargetBlock(content: string, source: TargetMarker): string {
  const range = blockRange(content, source);
  return range ? content.slice(0, range.start) + content.slice(range.end) : content;
}

/** Deliberately not a general OpenSSH parser: dynamic configuration is blocked before ssh -G. */
export function assertAuditableConfig(content: string, source: SshTargetSource): void {
  for (const raw of removeSshTargetBlock(content, source).split(/\r\n|\r|\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const directive = raw.match(/^\s*([a-z][a-z0-9]*)[\s=]+(.*)$/i);
    if (!directive) blocked("ssh_config_invalid", "SSH config 含无法安全预检的指令");
    const key = directive[1].toLowerCase();
    if (key === "include" || key === "match") {
      blocked("dynamic_ssh_config_unsupported", "目标边界暂不支持 SSH config 的 Include/Match；未执行 ssh -G 或连接");
    }
    if (key !== "host") continue;
    const tokens = directive[2].match(/"[^"\r\n]*"|[^\s#]+/g) ?? [];
    if (tokens.some((token) => token.replace(/^"|"$/g, "").toLowerCase() === source.sshAlias.toLowerCase())) {
      blocked("ssh_alias_conflict", "用户 SSH config 已有非受管同名 alias；不会覆盖");
    }
  }
}

export function renderSshTargetBlock(source: SshTargetSource, paths: SshTargetPaths): string {
  if (source.jumpTargetId && !source.jumpAlias) throw new Error("SSH 跳板 alias 必须从已校验 registry 解析");
  const values: Record<string, string> = {
    TARGET_ID: source.targetId, SSH_ALIAS: source.sshAlias, HOSTNAME: source.hostname, USER: source.user,
    PORT: String(source.port), IDENTITY_FILE: paths.identity.replaceAll("\\", "/"),
    KNOWN_HOSTS_FILE: paths.knownHosts.replaceAll("\\", "/"), HOST_KEY_ALGORITHM: source.hostKeyAlgorithm, PROXY_JUMP: source.jumpAlias ?? "none",
  };
  const resolved = template.replace(/\{\{([A-Z_]+)\}\}/g, (_token, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error("目标 SSH 模板包含未知占位符");
    return value;
  });
  // ProxyCommand and ProxyJump compete: even "ProxyCommand none" would suppress a later jump.
  return source.jumpTargetId ? resolved.replace("    ProxyCommand none\n", "") : resolved;
}

export function mergeSshTargetBlock(content: string, source: SshTargetSource, paths: SshTargetPaths): string {
  assertAuditableConfig(content, source);
  return renderSshTargetBlock(source, paths) + removeSshTargetBlock(content, source);
}

export function assertManagedConfig(content: string, source: SshTargetSource, paths: SshTargetPaths): void {
  assertAuditableConfig(content, source);
  const range = blockRange(content, source);
  if (!range) blocked("ssh_alias_not_configured", "目标 SSH alias 尚未应用；不会把 alias 当作 DNS 目标连接");
  const prefix = content.slice(0, range.start).replace(/\r\n?/g, "\n");
  const unmanagedPrefix = prefix.replace(/^# BEGIN wsl-settings ([a-z][a-z0-9-]*)\n[\s\S]*?^# END wsl-settings \1\n/gm, "");
  if (unmanagedPrefix.trim() || content.slice(range.start, range.end).replace(/\r\n?/g, "\n") !== renderSshTargetBlock(source, paths)) {
    blocked("managed_block_drift", "目标 SSH 受管区块与配置源不一致；请先核对或重新应用");
  }
}
