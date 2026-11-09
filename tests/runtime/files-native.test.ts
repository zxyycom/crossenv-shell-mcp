import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fileHeader, parseFileEvent } from "../../src/files/protocol.ts";
import { executeFile } from "../../src/files/execute.ts";
import { fileHelperInvocation, type withFileRoute } from "../../src/files/route.ts";
import { childEnvironment } from "../../src/shell-router.ts";
import { openSource, prepareDestination } from "../../src/files/local-files.ts";
import { TransferFault, type TransferProgress } from "../../src/files/contract.ts";
import { FileChannel, writeBytes } from "../../src/files/channel.ts";

const windows = process.platform === "win32";
const native: typeof withFileRoute = async (_environment, signal, operation) => {
  signal.throwIfAborted();
  return operation({ ...await fileHelperInvocation(windows ? "windows-powershell" : "bash"), environment: childEnvironment(process.env) });
};
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "project-file-test-"));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const bytes = Buffer.from(Array.from({ length: 512 * 1024 }, (_, i) => i % 256));
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

test("fixed native helper transfers binary and empty files both ways with independent hashes", { timeout: 15_000 }, async () => {
  await fixture(async (root) => {
    for (const data of [bytes, Buffer.alloc(0)]) {
      const source = path.join(root, `源 ${data.length}.bin`);
      const target = path.join(root, `目标 ${data.length}.bin`);
      const returned = path.join(root, `取回 ${data.length}.bin`);
      await writeFile(source, data);
      const events: TransferProgress[] = [];
      for (const direction of ["upload", "download"] as const) {
        const result = await executeFile({ request: { environment: "fixture", direction, localPath: direction === "upload" ? source : returned, targetPath: target },
          signal: AbortSignal.timeout(10_000), observe: (event) => events.push(event) }, native);
        assert.deepEqual(result, { bytes: data.length, sha256: digest(data), published: true });
      }
      assert.deepEqual(await readFile(target), data);
      assert.deepEqual(await readFile(returned), data);
      assert.ok(events.some((event) => event.phase === "verifying"));
      assert.ok(events.some((event) => event.bytes === data.length));
    }
    assert.equal((await readdir(root)).filter((name) => name.endsWith(".part")).length, 0);
  });
});

test("existing destinations, missing parents, directories and oversized sources preserve protected state", { timeout: 10_000 }, async () => {
  await fixture(async (root) => {
    const source = path.join(root, "source.bin");
    const target = path.join(root, "protected.bin");
    await writeFile(source, bytes);
    await writeFile(target, "keep-me");
    await assert.rejects(executeFile({ request: { environment: "fixture", direction: "upload", localPath: source, targetPath: target },
      signal: AbortSignal.timeout(5_000), observe() {} }, native), { code: "conflict", postState: "unpublished" });
    assert.equal(await readFile(target, "utf8"), "keep-me");
    await assert.rejects(prepareDestination(target), { code: "conflict" });
    await assert.rejects(prepareDestination(path.join(root, "missing", "file")), { code: "parent_missing" });
    await assert.rejects(openSource(root), { code: "not_regular" });
    await truncate(source, 104857601);
    await assert.rejects(openSource(source), { code: "too_large" });
    assert.deepEqual((await readdir(root)).sort(), ["protected.bin", "source.bin"]);
  });
});

test("local held source detects mutation; destination publication never replaces a late competitor", async () => {
  await fixture(async (root) => {
    const source = path.join(root, "source");
    await writeFile(source, "before");
    const opened = await openSource(source);
    try {
      await writeFile(source, "after-change");
      await assert.rejects(opened.assertUnchanged(), { code: "source_changed" });
    } finally { await opened.handle.close(); }
    const target = path.join(root, "target");
    const staging = await (await prepareDestination(target)).create();
    try {
      await staging.handle.writeFile("new");
      await writeFile(target, "competitor");
      await assert.rejects(staging.publish(), { code: "conflict" });
    } finally { await staging.cleanup(); }
    assert.equal(await readFile(target, "utf8"), "competitor");
    assert.equal((await readdir(root)).some((name) => name.endsWith(".part")), false);
  });
});

test("link ancestors are rejected without writing through them", async () => {
  await fixture(async (root) => {
    const directory = path.join(root, "directory");
    const alias = path.join(root, "alias");
    await mkdir(directory);
    await symlink(directory, alias, windows ? "junction" : "dir");
    await assert.rejects(prepareDestination(path.join(alias, "new")), { code: "path_link" });
    assert.deepEqual(await readdir(directory), []);
  });
});

test("native receiver cleans only its own partial on truncation/hash failure and preserves a foreign temporary", { timeout: 10_000 }, async () => {
  await fixture(async (root) => {
    const helper = await fileHelperInvocation(windows ? "windows-powershell" : "bash");
    for (const mode of ["truncated", "hash_mismatch", "foreign"] as const) {
      const id = randomUUID();
      const target = path.join(root, `${mode}.bin`);
      const temporary = path.join(root, `.project-file-${id}.part`);
      if (mode === "foreign") await writeFile(temporary, "foreign-content");
      const result = spawnSync(helper.argv[0], helper.argv.slice(1), { windowsHide: true, timeout: 5000,
        input: Buffer.concat([helper.preamble ?? Buffer.alloc(0), fileHeader({ operation: "put", targetPath: target, size: bytes.length,
          sha256: mode === "hash_mismatch" ? "0".repeat(64) : digest(bytes), id }), mode === "truncated" ? bytes.subarray(0, 100) : mode === "foreign" ? Buffer.alloc(0) : bytes]) });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      const events = result.stderr.toString("utf8").trim().split(/\r?\n/).map(parseFileEvent);
      assert.deepEqual(events.at(-1), { event: "error", code: mode === "foreign" ? "conflict" : mode, published: false, cleanupFailed: false });
      assert.equal((await readdir(root)).includes(`${mode}.bin`), false);
      if (mode === "foreign") assert.equal(await readFile(temporary, "utf8"), "foreign-content");
      else assert.equal((await readdir(root)).includes(path.basename(temporary)), false);
    }
  });
});

test("host Git Bash exercises the production Bash receiver without entering WSL or a container", { skip: !windows, timeout: 10_000 }, async () => {
  await fixture(async (root) => {
    const helper = await fileHelperInvocation("bash");
    const bash = path.join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe");
    const id = randomUUID();
    const target = path.join(root, "bash destination.bin");
    const unixPath = target.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
    const result = spawnSync(bash, helper.argv.slice(helper.argv.indexOf("bash") + 1), { windowsHide: true, timeout: 5000,
      input: Buffer.concat([fileHeader({ operation: "put", targetPath: unixPath, size: bytes.length, sha256: digest(bytes), id }), bytes, Buffer.from("COMMIT\n")]) });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr.toString("utf8"));
    const events = result.stderr.toString("utf8").trim().split(/\r?\n/).map(parseFileEvent);
    assert.deepEqual(events.at(-1), { event: "complete", bytes: bytes.length, sha256: digest(bytes) });
    assert.deepEqual(await readFile(target), bytes);
    assert.deepEqual(await readdir(root), ["bash destination.bin"]);
  });
});

test("upload source mutation before COMMIT prevents publication and removes the owned target partial", { timeout: 5000 }, async () => {
  await fixture(async (root) => {
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    await writeFile(source, bytes);
    let changed = false;
    await assert.rejects(executeFile({ request: { environment: "fixture", direction: "upload", localPath: source, targetPath: target },
      signal: AbortSignal.timeout(4000), observe(event) {
        if (event.phase === "verifying" && !changed) { changed = true; writeFileSync(source, "changed-after-send"); }
      } }, native), { code: "source_changed", postState: "unpublished" });
    assert.equal(changed, true);
    assert.deepEqual(await readdir(root), ["source"]);
  });
});

test("Bash receiver accumulates fragmented pipe reads without consuming the publication handshake", { timeout: 8000 }, async () => {
  await fixture(async (root) => {
    const data = bytes.subarray(0, 65536 + 37);
    const helper = await fileHelperInvocation("bash");
    const argv = windows
      ? [path.join(process.env.ProgramFiles ?? "C:/Program Files", "Git/bin/bash.exe"), ...helper.argv.slice(helper.argv.indexOf("bash") + 1)]
      : helper.argv;
    const target = path.join(root, "fragmented.bin");
    const targetPath = windows ? target.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`) : target;
    const channel = new FileChannel(argv, childEnvironment(process.env), "upload", () => {});
    const signal = AbortSignal.any([channel.signal, AbortSignal.timeout(5000)]);
    try {
      await writeBytes(channel.input, fileHeader({ operation: "put", targetPath, size: data.length, sha256: digest(data), id: randomUUID() }), signal);
      await channel.reply("ready", signal);
      for (let offset = 0; offset < data.length; offset += 1024) {
        await writeBytes(channel.input, data.subarray(offset, offset + 1024), signal);
        await delay(1, undefined, { signal });
      }
      assert.deepEqual(await channel.reply("verified", signal), { event: "verified", bytes: data.length, sha256: digest(data) });
      await writeBytes(channel.input, Buffer.from("COMMIT\n"), signal);
      channel.input.end();
      await channel.reply("complete", signal);
      await channel.finish(signal);
      assert.deepEqual(await readFile(target), data);
      assert.deepEqual(await readdir(root), ["fragmented.bin"]);
    } finally { await channel.close(); }
  });
});

test("PowerShell 7 file route uses pwsh and preserves binary content both ways", { skip: !windows, timeout: 8000 }, async () => {
  await fixture(async (root) => {
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const returned = path.join(root, "returned");
    const data = bytes.subarray(0, 65536 + 37);
    await writeFile(source, data);
    const route: typeof withFileRoute = async (_environment, _signal, operation) => {
      const helper = await fileHelperInvocation("powershell-7");
      assert.equal(helper.argv[0], "pwsh.exe");
      assert.ok(helper.argv.join(" ").length < 8191, "fixed command must fit a Windows CMD SSH parent");
      return operation({ ...helper, environment: childEnvironment(process.env) });
    };
    for (const direction of ["upload", "download"] as const) {
      const receipt = await executeFile({ request: { environment: "fixture", direction, localPath: direction === "upload" ? source : returned, targetPath: target },
        signal: AbortSignal.timeout(5000), observe() {} }, route);
      assert.deepEqual(receipt, { bytes: data.length, sha256: digest(data), published: true });
    }
    assert.deepEqual(await readFile(target), data);
    assert.deepEqual(await readFile(returned), data);
  });
});

for (const shell of ["windows-powershell", "powershell-7"] as const) test(`${shell} receives bytes and COMMIT through an overlapped Windows stdin handle`, { skip: !windows, timeout: 8000 }, async () => {
  await fixture(async (root) => {
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const data = bytes.subarray(0, 13);
    await writeFile(source, data);
    const route: typeof withFileRoute = async (_environment, _signal, operation) => {
      const helper = await fileHelperInvocation(shell);
      return operation({ ...helper, argv: [helper.argv[0], "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
        fileURLToPath(new URL("./fixtures/overlapped-stdin.ps1", import.meta.url)), "-EncodedPayload", helper.argv.at(-1)!],
      environment: childEnvironment(process.env) });
    };
    const receipt = await executeFile({ request: { environment: "fixture", direction: "upload", localPath: source, targetPath: target },
      signal: AbortSignal.timeout(5000), observe() {} }, route);
    assert.deepEqual(receipt, { bytes: data.length, sha256: digest(data), published: true });
    assert.deepEqual(await readFile(target), data);
    assert.deepEqual((await readdir(root)).sort(), ["source", "target"]);
  });
});

test("short Windows pipe reads keep control progress bounded and preserve the complete file", { skip: !windows, timeout: 8000 }, async () => {
  await fixture(async (root) => {
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const data = bytes.subarray(0, 65536 + 37);
    await writeFile(source, data);
    const reports: number[] = [];
    let phase: TransferProgress["phase"];
    const route: typeof withFileRoute = async (_environment, _signal, operation) => operation({
      argv: ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
        fileURLToPath(new URL("./fixtures/small-reads.ps1", import.meta.url)), "-TargetProgram",
        fileURLToPath(new URL("../../src/files/target.ps1", import.meta.url))], environment: childEnvironment(process.env),
    });
    const receipt = await executeFile({ request: { environment: "fixture", direction: "upload", localPath: source, targetPath: target },
      signal: AbortSignal.timeout(5000), observe(event) {
        phase = event.phase ?? phase;
        if (event.bytes !== undefined && phase === "transferring") reports.push(event.bytes);
      } }, route);
    assert.deepEqual(receipt, { bytes: data.length, sha256: digest(data), published: true });
    assert.ok(reports.length > 0 && reports.length < 64, `expected bounded wire progress, got ${reports.length}`);
    assert.equal(reports.at(-1), data.length, "receiver progress must confirm all bytes before verification");
    assert.deepEqual(reports, [...reports].sort((a, b) => a - b));
    assert.deepEqual(await readFile(target), data);
  });
});

test("download protocol/exit failures never publish or expose diagnostics; cancellation cleans its partial", { timeout: 8000 }, async () => {
  await fixture(async (root) => {
    const expected = { hash_mismatch: "hash_mismatch", truncated: "truncated", oversized: "protocol_error",
      diagnostic: "protocol_error", nonzero: "process_failed", empty_exit: "truncated", hang: "cancelled", cancel_cleanup: "io_failed" };
    for (const [mode, code] of Object.entries(expected)) {
      const controller = new AbortController();
      let received = false;
      const peer: typeof withFileRoute = async (_environment, _signal, operation) => operation({
        argv: [process.execPath, fileURLToPath(new URL("./fixtures/file-peer.mjs", import.meta.url)), mode], environment: childEnvironment(process.env),
      });
      let failure: unknown;
      try {
        await executeFile({ request: { environment: "fixture", direction: "download", localPath: path.join(root, mode), targetPath: "/fixture" },
          signal: controller.signal, observe(event) {
            if ((mode === "hang" || mode === "cancel_cleanup") && event.bytes) { received = true; controller.abort(new TransferFault("cancelled")); }
          } }, peer);
        assert.fail("expected producer failure");
      } catch (error) { failure = error; }
      assert.ok(failure instanceof TransferFault);
      assert.equal(failure.code, code, mode);
      if (mode === "hang" || mode === "cancel_cleanup") assert.equal(failure.postState, "unpublished");
      if (mode === "cancel_cleanup") assert.equal(failure.cleanupFailed, true);
      assert.equal(failure.message.includes("sensitive-fixture"), false);
      assert.deepEqual(await readdir(root), [], mode);
      if (mode === "hang" || mode === "cancel_cleanup") assert.equal(received, true);
    }
  });
});
