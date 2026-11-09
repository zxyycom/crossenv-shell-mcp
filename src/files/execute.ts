import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { FileChannel, writeBytes } from "./channel.ts";
import { fileLimits, TransferFault, transferFault, type FileExecution, type FileReceipt, type TransferPhase } from "./contract.ts";
import { hashFile, openSource, prepareDestination } from "./local-files.ts";
import { fileHeader } from "./protocol.ts";
import type { FileProgram } from "./route.ts";

type Source = Awaited<ReturnType<typeof openSource>>;
type Destination = Awaited<ReturnType<typeof prepareDestination>>;

async function sendBytes(channel: FileChannel, source: Source, signal: AbortSignal): Promise<void> {
  const buffer = Buffer.alloc(fileLimits.chunkBytes);
  let position = 0;
  while (position < source.size) {
    signal.throwIfAborted();
    const { bytesRead } = await source.handle.read(buffer, 0, Math.min(buffer.length, source.size - position), position);
    if (!bytesRead) throw new TransferFault("source_changed", "unpublished");
    await writeBytes(channel.input, buffer.subarray(0, bytesRead), signal);
    position += bytesRead;
  }
}

async function upload(channel: FileChannel, source: Source, digest: string, execution: FileExecution): Promise<FileReceipt> {
  const ready = await channel.reply("ready", execution.signal);
  if (ready.size !== source.size) throw new TransferFault("protocol_error");
  await sendBytes(channel, source, execution.signal);
  const verified = await channel.reply("verified", execution.signal);
  if (verified.bytes !== source.size || verified.sha256 !== digest) throw new TransferFault("hash_mismatch", "unpublished");
  await source.assertUnchanged();
  execution.signal.throwIfAborted();
  await writeBytes(channel.input, Buffer.from("COMMIT\n"), execution.signal);
  channel.input.end();
  const receipt = await channel.reply("complete", execution.signal);
  await channel.finish(execution.signal);
  if (receipt.bytes !== source.size || receipt.sha256 !== digest) throw new TransferFault("hash_mismatch", "unknown");
  execution.observe({ bytes: receipt.bytes, phase: "cleanup" });
  return { bytes: receipt.bytes, sha256: receipt.sha256, published: true };
}

async function receiveBytes(channel: FileChannel, handle: FileHandle, size: number, execution: FileExecution) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of channel.output) {
    execution.signal.throwIfAborted();
    if (bytes + chunk.length > size) throw new TransferFault("protocol_error", "unpublished");
    // Short fs writes are legal: maintain backpressure until the complete chunk is accepted.
    for (let offset = 0; offset < chunk.length;) {
      const result = await handle.write(chunk, offset, chunk.length - offset, bytes + offset);
      if (!result.bytesWritten) throw new TransferFault("io_failed", "unpublished");
      offset += result.bytesWritten;
    }
    bytes += chunk.length;
    hash.update(chunk);
    execution.observe({ bytes });
  }
  return { bytes, digest: hash.digest("hex") };
}

async function download(channel: FileChannel, destination: Destination, execution: FileExecution): Promise<FileReceipt> {
  const ready = await channel.reply("ready", execution.signal);
  const staging = await destination.create();
  let phase: TransferPhase = "transferring";
  try {
    const { bytes, digest } = await receiveBytes(channel, staging.handle, ready.size, execution);
    execution.signal.throwIfAborted();
    const receipt = await channel.reply("complete", execution.signal);
    await channel.finish(execution.signal);
    if (bytes !== ready.size || receipt.bytes !== bytes) throw new TransferFault("truncated", "unpublished");
    phase = "verifying";
    execution.observe({ phase });
    if (digest !== ready.sha256 || digest !== receipt.sha256 || await hashFile(staging.handle, execution.signal) !== digest) throw new TransferFault("hash_mismatch", "unpublished");
    execution.signal.throwIfAborted();
    phase = "publishing";
    execution.observe({ phase });
    await staging.publish();
    return { bytes, sha256: digest, published: true };
  } catch (error) {
    const fault = transferFault(execution.signal.aborted ? execution.signal.reason : error);
    throw new TransferFault(fault.code, staging.published ? "published" : "unpublished", fault.cleanupFailed, phase);
  } finally { execution.observe({ phase: "cleanup" }); await staging.cleanup(); }
}

async function withChannel(execution: FileExecution, program: FileProgram,
  operation: (channel: FileChannel, execution: FileExecution) => Promise<FileReceipt>): Promise<FileReceipt> {
  execution.signal.throwIfAborted();
  const channel = new FileChannel(program.argv, program.environment, execution.request.direction, execution.observe);
  const signal = AbortSignal.any([execution.signal, channel.signal]);
  const interrupted = Promise.withResolvers<never>();
  const abort = () => {
    channel.output.destroy();
    channel.input.destroy();
    interrupted.reject(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const pending = operation(channel, { ...execution, signal }).then(
    (receipt) => ({ ok: true as const, receipt }), (error: unknown) => ({ ok: false as const, error }));
  await Promise.race([pending, interrupted.promise.catch(() => undefined)]);
  signal.removeEventListener("abort", abort);
  // Stop the child to release pending reads, then retain the operation's precise publication state.
  await channel.close();
  const result = await pending;
  if (!result.ok) throw result.error;
  return result.receipt;
}

/** The route is the only replaceable boundary; tests use native children, never registered targets. */
export async function executeFile(execution: FileExecution, route: <T>(environment: string, signal: AbortSignal, operation: (program: FileProgram) => Promise<T>) => Promise<T>): Promise<FileReceipt> {
  const { request, observe, signal } = execution;
  const source = request.direction === "upload" ? await openSource(request.localPath) : undefined;
  const destination = request.direction === "download" ? await prepareDestination(request.localPath) : undefined;
  try {
    const digest = source ? await hashFile(source.handle, signal) : undefined;
    if (source) { await source.assertUnchanged(); observe({ total: source.size }); }
    observe({ phase: "connecting" });
    return await route(request.environment, signal, (program) => withChannel(execution, program, async (channel, active) => {
      if (program.preamble) await writeBytes(channel.input, program.preamble, active.signal);
      await writeBytes(channel.input, fileHeader({ operation: source ? "put" : "get", targetPath: request.targetPath,
        size: source?.size, sha256: digest, id: randomUUID() }), active.signal);
      if (source) return upload(channel, source, digest!, active);
      channel.input.end();
      return download(channel, destination!, active);
    }));
  } finally { if (source) await source.handle.close(); }
}
