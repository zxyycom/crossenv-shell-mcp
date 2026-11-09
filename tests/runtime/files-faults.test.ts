import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeFile } from "../../src/files/execute.ts";
import { fileHelperInvocation, type withFileRoute } from "../../src/files/route.ts";
import { childEnvironment } from "../../src/shell-router.ts";

const windows = process.platform === "win32";
const native: typeof withFileRoute = async (_environment, signal, operation) => {
  signal.throwIfAborted();
  return operation({ ...await fileHelperInvocation(windows ? "windows-powershell" : "bash"), environment: childEnvironment(process.env) });
};
const payload = Buffer.from([0, 255, 13, 10, 128, 65, 0, 1]);

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "project-file-fault-"));
  try { await run(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

function transfer(direction: "upload" | "download", localPath: string, targetPath: string) {
  return executeFile({ request: { environment: "fixture", direction, localPath, targetPath },
    signal: AbortSignal.timeout(5000), observe() {} }, native);
}

function acl(action: "Deny" | "Restore", root: string, backup?: string): string {
  const result = spawnSync("pwsh.exe", ["-NoProfile", "-File", fileURLToPath(new URL("./fixtures/file-deny-write.ps1", import.meta.url)),
    "-Action", action, "-FixtureRoot", root, ...(backup ? ["-SddlBase64", backup] : [])], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.equal(result.error, undefined, `ACL fixture ${action} could not run`);
  assert.equal(result.status, 0, `ACL fixture ${action} failed`);
  return result.stdout.trim();
}

test("native receiver rejects denied creation, preserves the healthy baseline and succeeds after ACL restoration", { skip: !windows, timeout: 12_000 }, async () => {
  await fixture(async (root) => {
    const source = path.join(root, "source");
    const directory = path.join(root, "denied");
    const healthy = path.join(directory, "healthy");
    const denied = path.join(directory, "new-file");
    await fs.mkdir(directory);
    await fs.writeFile(source, payload);
    assert.equal((await transfer("upload", source, healthy)).published, true);
    assert.deepEqual(await fs.readFile(healthy), payload);
    const before = await fs.readdir(directory);
    const backup = acl("Deny", root);
    assert.match(backup, /^[A-Za-z0-9+/=]+$/);
    try {
      await assert.rejects(transfer("upload", source, denied), { code: "io_failed", postState: "unpublished", cleanupFailed: false });
      assert.deepEqual(await fs.readdir(directory), before);
      assert.deepEqual(await fs.readFile(healthy), payload);
      assert.deepEqual(await fs.readFile(source), payload);
    } finally { assert.equal(acl("Restore", root, backup), "RESTORED"); }
    assert.equal((await transfer("upload", source, denied)).published, true);
    assert.deepEqual(await fs.readFile(denied), payload);
  });
});

test("injected ENOSPC after a real partial write prevents publication and cleans only its staging file", { timeout: 8000 }, async (context) => {
  await fixture(async (root) => {
    const source = path.join(root, "source");
    const healthy = path.join(root, "healthy");
    const failed = path.join(root, "failed");
    await fs.writeFile(source, payload);
    assert.equal((await transfer("download", healthy, source)).published, true);
    assert.deepEqual(await fs.readFile(healthy), payload);
    const before = (await fs.readdir(root)).sort();
    const realOpen = fs.open;
    let partialWritten = false;
    const replacement = context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (typeof args[0] !== "string" || path.dirname(args[0]) !== root) return handle;
      return new Proxy<FileHandle>(handle, {
        get(target, property) {
          if (property === "write") return async (buffer: Buffer, offset: number, length: number, position: number) => {
            const written = await target.write(buffer, offset, Math.min(3, length), position);
            partialWritten = written.bytesWritten > 0;
            throw Object.assign(new Error("injected file-system write failure"), { code: "ENOSPC" });
          };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(transfer("download", failed, source), { code: "io_failed", postState: "unpublished", cleanupFailed: false, phase: "transferring" });
      assert.equal(partialWritten, true);
      assert.deepEqual((await fs.readdir(root)).sort(), before);
      assert.deepEqual(await fs.readFile(source), payload);
      assert.deepEqual(await fs.readFile(healthy), payload);
    } finally { replacement.mock.restore(); syncBuiltinESMExports(); }
    assert.equal((await transfer("download", failed, source)).published, true);
    assert.deepEqual(await fs.readFile(failed), payload);
  });
});
