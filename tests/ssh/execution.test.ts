import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { projectExecutionClient, protectExecutionClientAcl, readExecutionClient } from "../../src/ssh/execution-client.ts";
import { withSshTargetConnection, targetShellInvocation } from "../../src/ssh/ssh-execution.ts";

function key(byte: number) {
  const blob = Buffer.concat([Buffer.from([0,0,0,11]), Buffer.from("ssh-ed25519"), Buffer.from([0,0,0,32]), Buffer.alloc(32, byte)]);
  return { publicKey: `ssh-ed25519 ${blob.toString("base64")}`, fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}` };
}
const agent = key(1), host = key(2);
const target = { targetId: "example", displayName: "Example", sshAlias: "example", hostname: "192.0.2.1", user: "example", port: 22,
  hostKeyAlgorithm: "ssh-ed25519" as const, hostKeyFingerprint: host.fingerprint, identity: { kind: "agent" as const, label: "fixture", fingerprint: agent.fingerprint }, shell: "bash" as const, shellVersion: "5.2" };
const registry = { schemaVersion: 1 as const, targets: [target] };

test("v1 projection binds both pins and emits exact members", () => {
  const directory = path.join(os.tmpdir(), "synthetic-unit");
  const input = { registry, targetId: "example", directory, agentPublicKeys: agent.publicKey, trustedKnownHosts: `192.0.2.1 ${host.publicKey}` };
  const projected = projectExecutionClient(input);
  assert.deepEqual(Object.keys(projected.files).sort(), ["config", "known_hosts", "targets.json", "wsl-settings-example.pub"]);
  assert.throws(() => projectExecutionClient({ ...input, trustedKnownHosts: `192.0.2.1 ${agent.publicKey}` }));
  assert.throws(() => projectExecutionClient({ ...input, agentPublicKeys: host.publicKey }));
});

test("v1 single jump binds both hosts and rejects drift or extra members", { skip: process.platform !== "win32", timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "crossenv-unit-test-"));
  try {
    const jump = { ...target, targetId: "jump", sshAlias: "jump", hostname: "192.0.2.2", hostKeyFingerprint: agent.fingerprint };
    const destination = { ...target, jumpTargetId: "jump" };
    await protectExecutionClientAcl(root);
    const unit = path.join(root, "example"); await fs.mkdir(unit);
    const input = { registry: { schemaVersion: 1, targets: [destination, jump] }, targetId: "example", directory: unit,
      agentPublicKeys: agent.publicKey, trustedKnownHosts: `192.0.2.1 ${host.publicKey}\n192.0.2.2 ${agent.publicKey}` };
    const projected = projectExecutionClient(input);
    assert.deepEqual(Object.keys(projected.files).sort(), ["config", "known_hosts", "targets.json", "wsl-settings-example.pub", "wsl-settings-jump.pub"]);
    assert.match(projected.files.config, /ProxyJump jump/);
    assert.match(projected.files.known_hosts, /192\.0\.2\.1/);
    assert.match(projected.files.known_hosts, /192\.0\.2\.2/);
    assert.throws(() => projectExecutionClient({ ...input, trustedKnownHosts: `192.0.2.1 ${host.publicKey}` }));
    for (const [name, contents] of Object.entries(projected.files)) await fs.writeFile(path.join(unit, name), contents);
    assert.equal((await readExecutionClient(root, "example")).registry.targets.length, 2);
    const aclArgs = ["-NoProfile", "-File", fileURLToPath(new URL("./execution-client-acl-fixture.ps1", import.meta.url)),
      "-File", path.join(unit, "config"), "-Reference", path.join(unit, "targets.json")];
    execFileSync("pwsh.exe", aclArgs, { windowsHide: true });
    await assert.rejects(readExecutionClient(root, "example"), { code: "invalid" });
    execFileSync("pwsh.exe", [...aclArgs, "-Restore"], { windowsHide: true });
    await fs.writeFile(path.join(unit, "extra"), "not allowed");
    await assert.rejects(readExecutionClient(root, "example"), { code: "invalid" });
    await fs.rm(path.join(unit, "extra"));
    await fs.writeFile(path.join(unit, "config"), projected.files.config.replace("ProxyJump jump", "ProxyJump other"));
    await assert.rejects(readExecutionClient(root, "example"), { code: "invalid" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("each operation rechecks published members against explicit registry", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "crossenv-registry-test-"));
  try {
    const registryPath = path.join(parent, "targets.json");
    await fs.writeFile(registryPath, JSON.stringify(registry));
    const context = { registryPath, prepared: { example: { registry, source: target, config: "config", ssh: "ssh.exe" } } };
    let called = false;
    await withSshTargetConnection("example", async () => { called = true; }, undefined, undefined, context);
    assert.equal(called, true);
    await fs.writeFile(registryPath, JSON.stringify({ schemaVersion: 1, targets: [] }));
    called = false;
    await assert.rejects(withSshTargetConnection("example", async () => { called = true; }, undefined, undefined, context));
    assert.equal(called, false);
    assert.deepEqual(targetShellInvocation("bash", "echo ok", "5.2").argv.slice(0, 3), ["env", "-u", "BASH_ENV"]);
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});
