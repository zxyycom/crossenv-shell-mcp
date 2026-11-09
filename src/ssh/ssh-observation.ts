import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { SshTargetBoundaryError, SshTargetProtocolError, blocked, rethrowUnexpected, systemErrorCode } from "./errors.ts";
import type { SshTargetPaths, SshTargetSource } from "./source.ts";
import type { SshProcessResult, SshProcessRunner } from "./process.ts";

export async function readLocalFile(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) blocked("local_file_not_regular", "目标 SSH 本地输入不是普通文件；请人工核对");
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof SshTargetBoundaryError) throw error;
    if (systemErrorCode(error) === "ENOENT") return undefined;
    rethrowUnexpected(error);
    blocked("local_file_unreadable", "无法读取目标 SSH 本地输入；请核对当前用户权限");
  }
}

type PublicIdentity = { publicKey: string; fingerprint: string; label: string; algorithm: string };

export function parsePublicIdentity(line: string): PublicIdentity {
  const match = line.trim().match(/^(\S+) ([A-Za-z0-9+/]+={0,2})(?:[ \t]+([^\r\n]*))?$/);
  if (!match || !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/.test(match[1])) {
    blocked("public_identity_invalid", "公开 SSH key 格式无效；不会读取或导出私钥");
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length < 8 || bytes.length > 16384 || bytes.toString("base64") !== match[2]) {
    blocked("public_identity_invalid", "公开 SSH key 编码无效");
  }
  const algorithmLength = bytes.readUInt32BE(0);
  if (algorithmLength > bytes.length - 4 || bytes.subarray(4, 4 + algorithmLength).toString("utf8") !== match[1]) {
    blocked("public_identity_invalid", "公开 SSH key 算法与数据不一致");
  }
  return {
    algorithm: match[1], publicKey: `${match[1]} ${match[2]}`,
    label: match[3] ?? "", fingerprint: `SHA256:${createHash("sha256").update(bytes).digest("base64").replace(/=+$/, "")}`,
  };
}

export async function observeAgentIdentity(
  source: SshTargetSource, runner: SshProcessRunner, environment: Record<string, string>,
): Promise<string> {
  let result: SshProcessResult;
  try { result = await runner(["ssh-add.exe", "-L"], environment); }
  catch (error) {
    rethrowUnexpected(error);
    blocked("ssh_agent_unavailable", "无法列出 Windows SSH agent 身份；请核对 SSH agent 是否可用及已解锁");
  }
  if (result.exitCode !== 0) {
    blocked("ssh_agent_unavailable", "Windows SSH agent 未提供可读取的身份；请核对 SSH agent 是否可用及已解锁");
  }
  const identities = result.stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    try { return parsePublicIdentity(line); }
    catch (error) {
      if (error instanceof SshTargetBoundaryError && error.reason === "public_identity_invalid") {
        throw new SshTargetProtocolError("ssh-add -L 输出协议无效；不保存原始 agent 输出");
      }
      throw error;
    }
  });
  const matches = identities.filter((identity) => identity.label === source.identity.label);
  if (matches.length === 0) blocked("agent_identity_not_configured", "agent 未提供指定标签的公开身份；请核对 SSH agent 中的密钥标签");
  if (matches.length !== 1) blocked("agent_identity_ambiguous", "agent 中指定标签不唯一；不会猜测身份");
  if (matches[0].fingerprint !== source.identity.fingerprint) {
    blocked("agent_identity_drift", "agent 中指定标签的公钥指纹不符；不会改用其他身份");
  }
  return `${matches[0].publicKey} ${source.identity.label}\n`;
}

export function assertPublicIdentity(
  content: string, source: SshTargetSource, labelPolicy: "require-match" | "allow-refresh",
): void {
  const identity = parsePublicIdentity(content);
  if (identity.fingerprint !== source.identity.fingerprint
    || (labelPolicy === "require-match" && identity.label !== source.identity.label)) {
    blocked("public_identity_drift", "目标公开身份引用与指定公钥指纹或标签不一致");
  }
}

export async function observePublicIdentity(source: SshTargetSource, paths: SshTargetPaths): Promise<void> {
  const content = await readLocalFile(paths.identity);
  if (content === undefined) blocked("public_identity_not_configured", "目标公开身份引用尚未应用");
  assertPublicIdentity(content, source, "require-match");
}

export async function observeHostTrust(
  source: SshTargetSource, paths: SshTargetPaths, runner: SshProcessRunner, environment: Record<string, string>,
): Promise<string> {
  if (await readLocalFile(paths.knownHosts) === undefined) {
    blocked("host_pin_not_configured", "未找到本机 known_hosts；请人工核对已授权主机指纹，入口不自动获取或写入 pin");
  }
  const host = source.port === 22 ? source.hostname : `[${source.hostname}]:${source.port}`;
  let result: SshProcessResult;
  try { result = await runner(["ssh-keygen.exe", "-F", host, "-f", paths.knownHosts], environment); }
  catch (error) {
    rethrowUnexpected(error);
    blocked("host_pin_probe_unavailable", "无法只读核对 known_hosts；需要 ssh-keygen.exe");
  }
  if (result.exitCode === 1 && !result.stdout.trim()) {
    blocked("host_pin_not_configured", "本机 known_hosts 尚无目标 pin；入口不自动获取或写入 pin");
  }
  if (result.exitCode !== 0) blocked("host_pin_probe_unavailable", "读取 known_hosts 中的目标条目失败");
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#"));
  if (lines.some((line) => line.startsWith("@"))) {
    blocked("host_pin_drift", "目标 known_hosts 使用特殊信任标记；不满足当前精确公钥 pin 契约");
  }
  const identities = lines.map((line) => parsePublicIdentity(line.replace(/^\S+\s+/, "")))
    .filter((identity) => identity.algorithm === source.hostKeyAlgorithm);
  if (identities.length === 0) blocked("host_pin_not_configured", "目标 known_hosts 缺少指定算法的 pin");
  if (identities.some((identity) => identity.fingerprint !== source.hostKeyFingerprint)) {
    blocked("host_pin_drift", "目标主机指纹与已批准 pin 不符；不会删除、替换或重新接受");
  }
  return identities[0].publicKey;
}
