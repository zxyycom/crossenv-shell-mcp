import { createHash } from "node:crypto";
// Deliberately independent peer: exercises malformed/exiting producers, never real targets.
for await (const _chunk of process.stdin) { /* consume only the bounded get header */ }
const mode = process.argv[2];
const emit = (value) => process.stderr.write(`PFT1 ${JSON.stringify(value)}\n`);
const body = Buffer.from([0, 255, 13, 10, 128, 65, 0, 1]);
const digest = createHash("sha256").update(body).digest("hex");
if (mode === "empty_exit") process.exit(0);
if (mode === "diagnostic") { process.stderr.write("untrusted-sensitive-fixture-diagnostic\n"); process.exit(1); }
emit({ event: "ready", size: mode === "oversized" ? 104857601 : 8, sha256: mode === "hash_mismatch" ? "0".repeat(64) : digest });
emit({ event: "phase", phase: "transferring" });
process.stdout.write(mode === "truncated" ? body.subarray(0, 3) : body);
if (mode === "cancel_cleanup") setTimeout(() => {
  emit({ event: "error", code: "io_failed", published: false, cleanupFailed: true });
  process.exitCode = 1;
}, 50);
else if (mode === "hang") setInterval(() => {}, 1000);
else {
  emit({ event: "complete", bytes: 8, sha256: mode === "hash_mismatch" ? "0".repeat(64) : digest });
  process.exitCode = mode === "nonzero" ? 7 : 0;
}
