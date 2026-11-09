import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { renderSshTargetBlock } from "./client-config.ts";
import { parsePublicIdentity } from "./ssh-observation.ts";
import { parseSshTargets, requireSshTarget, resolveSshTarget, type SshTargetRegistry, type SshTargetSource } from "./source.ts";

/** Pure materialization; callers must separately enforce the publication and ACL boundary. */
export function projectExecutionClient(input: {
  registry: unknown; targetId: string; directory: string; agentPublicKeys: string; trustedKnownHosts: string;
}): { registry: SshTargetRegistry; files: Record<string, string> } {
  if (!path.isAbsolute(input.directory) || /[\x00-\x1f\x7f"%$]/.test(input.directory)) throw new Error("执行客户端目录必须是安全的绝对路径");
  const source = parseSshTargets(input.registry);
  const target = requireSshTarget(source, input.targetId);
  const members = [target, ...(target.jumpTargetId ? [requireSshTarget(source, target.jumpTargetId)] : [])];
  const registry: SshTargetRegistry = { schemaVersion: 1, targets: members };
  const identities = input.agentPublicKeys.split(/\r?\n/).filter((line) => line.trim()).map(parsePublicIdentity);
  const hosts = input.trustedKnownHosts.split(/\r?\n/).flatMap((line) => {
    const parts = line.trim().split(/\s+/);
    if (!line.trim() || line.trimStart().startsWith("#")) return [];
    const marked = parts[0].startsWith("@");
    const offset = marked ? 2 : 1;
    if (parts.length < offset + 2) throw new Error("known_hosts 条目无效");
    if (parts[offset] !== "ssh-ed25519") return [];
    const key = parsePublicIdentity(`${parts[offset]} ${parts[offset + 1]}`);
    return [{ marked, key }];
  });
  const files: Record<string, string> = { "targets.json": `${JSON.stringify(registry, null, 2)}\n` };
  const knownHosts: string[] = [];
  for (const member of members) {
    const matches = identities.filter((key) => key.fingerprint === member.identity.fingerprint);
    if (!matches.length) throw new Error(`目标 ${member.targetId} 的 agent 公钥未匹配指纹`);
    const hostMatches = hosts.filter(({ key }) => key.algorithm === member.hostKeyAlgorithm && key.fingerprint === member.hostKeyFingerprint);
    if (!hostMatches.length || hostMatches.some(({ marked }) => marked)) throw new Error(`目标 ${member.targetId} 的批准主机公钥缺失或带特殊标记`);
    files[`wsl-settings-${member.targetId}.pub`] = `${matches[0].publicKey}\n`;
    const host = member.port === 22 ? member.hostname : `[${member.hostname}]:${member.port}`;
    knownHosts.push(`${host} ${hostMatches[0].key.publicKey}`);
  }
  files.known_hosts = `${[...new Set(knownHosts)].join("\n")}\n`;
  files.config = members.map((member) => renderSshTargetBlock(resolveSshTarget(registry, member.targetId), {
    directory: input.directory, config: path.join(input.directory, "config"), knownHosts: path.join(input.directory, "known_hosts"),
    identity: path.join(input.directory, `wsl-settings-${member.targetId}.pub`),
  })).join("");
  return { registry, files };
}

export class ExecutionClientError extends Error {
  readonly code: "missing" | "invalid";
  constructor(code: "missing" | "invalid", message: string) { super(message); this.code = code; }
}
const execFileAsync = promisify(execFile);
const aclScript = fileURLToPath(new URL("./private/execution-client-acl.ps1", import.meta.url));
async function acl(action: "Check" | "Protect", target: string | string[]): Promise<void> {
  const paths = Array.isArray(target) ? target : [target];
  if (!paths.length) return;
  const windows = process.env.SystemRoot ?? process.env.WINDIR;
  if (!windows || !path.isAbsolute(windows)) throw new ExecutionClientError("invalid", "Windows 系统目录不可用");
  const powershell = path.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
  const modules = path.join(windows, "System32", "WindowsPowerShell", "v1.0", "Modules");
  try { await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", aclScript, "-Action", action, "-PathsBase64", encoded], { windowsHide: true, env: { ...process.env, PSModulePath: modules } }); }
  catch { throw new ExecutionClientError("invalid", "执行客户端权限检查或设置失败"); }
}
export function executionClientUnitPath(root: string, targetId: string): string {
  if (!path.isAbsolute(root) || /[\x00-\x1f\x7f"%$]/.test(root) || !/^[a-z][a-z0-9-]*$/.test(targetId)) throw new ExecutionClientError("invalid", "执行客户端路径或目标无效");
  return path.join(root, targetId);
}
export async function assertExecutionClientDirectory(target: string, checkAcl = true): Promise<void> {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ExecutionClientError("invalid", "执行客户端目录不是普通目录");
  if (checkAcl) await acl("Check", target);
}
export async function readExecutionClientFile(target: string, checkAcl = true): Promise<string> {
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ExecutionClientError("invalid", "执行客户端文件不是普通文件");
  if (checkAcl) await acl("Check", target);
  return fs.readFile(target, "utf8");
}
export function isExecutionClientBackupName(name: string): boolean { return /^\.before-[0-9a-f-]{36}-(?:targets\.json|config|known_hosts|wsl-settings-[a-z][a-z0-9-]*\.pub)$/.test(name); }
export async function inspectExecutionClient(root: string, targetId: string): Promise<{ registry: SshTargetRegistry; source: SshTargetSource; config: string; files: Record<string, string> }> {
  const unit = executionClientUnitPath(root, targetId);
  await assertExecutionClientDirectory(root, false);
  await assertExecutionClientDirectory(unit, false);
  const names = await fs.readdir(unit);
  const registry = parseSshTargets(JSON.parse(await readExecutionClientFile(path.join(unit, "targets.json"), false)) as unknown);
  const target = requireSshTarget(registry, targetId);
  if (registry.targets.length !== (target.jumpTargetId ? 2 : 1)) throw new ExecutionClientError("invalid", "执行客户端包含无关目标");
  const runtimeNames = ["targets.json", "config", "known_hosts", ...registry.targets.map((member) => `wsl-settings-${member.targetId}.pub`)];
  if (names.some((name) => !runtimeNames.includes(name) && !isExecutionClientBackupName(name)) || runtimeNames.some((name) => !names.includes(name))) throw new ExecutionClientError("invalid", "执行客户端包含未知成员或缺少文件");
  const files: Record<string, string> = {};
  await acl("Check", [root, unit, ...names.map((name) => path.join(unit, name))]);
  for (const name of names) {
    const content = await readExecutionClientFile(path.join(unit, name), false);
    if (runtimeNames.includes(name)) files[name] = content;
  }
  const projected = projectExecutionClient({ registry, targetId, directory: unit, agentPublicKeys: registry.targets.map((entry) => files[`wsl-settings-${entry.targetId}.pub`]).join(""), trustedKnownHosts: files.known_hosts });
  if (runtimeNames.some((name) => files[name] !== projected.files[name])) throw new ExecutionClientError("invalid", "执行客户端内容或声明不一致");
  return { registry, source: resolveSshTarget(registry, targetId), config: path.join(unit, "config"), files };
}
export async function readExecutionClient(root: string, targetId: string): Promise<{ registry: SshTargetRegistry; source: SshTargetSource; config: string }> {
  const unit = executionClientUnitPath(root, targetId);
  try { await fs.lstat(unit); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ExecutionClientError("missing", "执行客户端尚未发布");
    throw new ExecutionClientError("invalid", "执行客户端不可读取");
  }
  try {
    const { registry, source, config } = await inspectExecutionClient(root, targetId);
    return { registry, source, config };
  } catch (error) {
    if (error instanceof ExecutionClientError) throw error;
    throw new ExecutionClientError("invalid", "执行客户端无效或不可读取");
  }
}


export async function checkExecutionClientAcl(paths: string | string[]): Promise<void> { await acl("Check", paths); }
export async function protectExecutionClientAcl(paths: string | string[]): Promise<void> { await acl("Protect", paths); }
