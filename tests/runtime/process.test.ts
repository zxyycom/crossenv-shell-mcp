import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runShellProcess, ShellProcessError } from "../../src/process.ts";

test("process boundary distinguishes pre-start cancellation and missing executable", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = { argv: ["node.exe"], environment: {}, cwd: process.cwd() };
  await assert.rejects(runShellProcess({ ...request, signal: controller.signal }),
    { code: "cancelled", stage: "execute", execution: "not_started" });
  await assert.rejects(runShellProcess({ ...request, argv: ["missing-project-shell-executable-8675309.exe"] }),
    { code: "spawn_failed", stage: "execute", execution: "not_started" });
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function fixturePids(file: string): Promise<number[]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await access(`${file}.ready`).then(() => true, (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    })) {
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      if (!Array.isArray(value) || value.length !== 2 || !value.every((pid) => Number.isSafeInteger(pid) && pid > 0)) {
        throw new Error("Invalid process fixture PID receipt");
      }
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Process fixture did not publish its PID receipt");
}

describe("project Shell process cleanup integration", () => {
  for (const parentExits of [false, true]) {
    test(parentExits ? "cancellation closes inherited streams after the root has exited" : "cancellation terminates the owned running process tree", async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "mcp-process-tree-"));
      const pidFile = path.join(directory, "pids.json");
      const controller = new AbortController();
      const argv = ["node.exe", fileURLToPath(new URL("./fixtures/process-tree.mjs", import.meta.url)), pidFile];
      if (parentExits) argv.push("--parent-exits");
      const outcome = runShellProcess({
        argv,
        environment: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        cwd: process.cwd(),
        signal: controller.signal,
      }).then(() => undefined, (error: unknown) => error);
      let pids: number[] = [];
      try {
        pids = await fixturePids(pidFile);
        if (parentExits) {
          for (let attempt = 0; attempt < 100 && isRunning(pids[0]!); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.equal(isRunning(pids[0]!), false);
          assert.equal(isRunning(pids[1]!), true);
        }
        controller.abort();
        const failure = await outcome;
        assert.ok(failure instanceof ShellProcessError);
        assert.equal(failure.code, "cancelled");
        assert.equal(failure.execution, "unknown");
        if (parentExits) {
          await assert.rejects(access(`${pidFile}.child-exited`), { code: "ENOENT" });
        } else {
          assert.deepEqual(pids.map(isRunning), [false, false]);
        }
      } finally {
        controller.abort();
        await outcome;
        // Only this fixture's still-live child; the root-exited case cannot prove tree termination.
        if (parentExits && pids[1] && isRunning(pids[1])) {
          process.kill(pids[1]);
          for (let attempt = 0; attempt < 100 && isRunning(pids[1]); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.equal(isRunning(pids[1]), false);
        }
        await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
      }
    });
  }
});
