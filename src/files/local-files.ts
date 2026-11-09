import { constants } from "node:fs";
import { open, lstat, realpath, link, unlink, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileLimits, assertTransferPath, TransferFault } from "./contract.ts";

type Identity = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
function sameFile(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertLocalSyntax(input: string): void {
  assertTransferPath(input);
  if (!path.isAbsolute(input) || (process.platform === "win32" && !/^[A-Za-z]:[\\/]/.test(input))) throw new TransferFault("invalid_input", "unpublished");
  if (process.platform === "win32" && (/[<>:"|?*]/.test(input.slice(2))
    || input.slice(3).split(/[\\/]/).some((part) => /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))) {
    throw new TransferFault("invalid_input", "unpublished");
  }
}

async function assertAncestors(parent: string): Promise<void> {
  let cursor = parent;
  while (true) {
    let entry;
    try { entry = await lstat(cursor); }
    catch (error) { if (missing(error)) throw new TransferFault("parent_missing", "unpublished"); throw error; }
    if (entry.isSymbolicLink()) throw new TransferFault("path_link", "unpublished");
    if (!entry.isDirectory()) throw new TransferFault("not_regular", "unpublished");
    const next = path.dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
}

export async function inspectLocalPath(input: string): Promise<{ file: string; parent: string; parentIdentity: { dev: number; ino: number } }> {
  assertLocalSyntax(input);
  const file = path.resolve(input);
  const parent = path.dirname(file);
  await assertAncestors(parent);
  const resolved = await realpath(parent);
  if (path.relative(resolved, parent) !== "") throw new TransferFault("path_link", "unpublished");
  try { if ((await lstat(file)).isSymbolicLink()) throw new TransferFault("path_link", "unpublished"); }
  catch (error) { if (!missing(error)) throw error; }
  return { file, parent: resolved, parentIdentity: await lstat(resolved) };
}

async function assertParent(location: Awaited<ReturnType<typeof inspectLocalPath>>): Promise<void> {
  const current = await inspectLocalPath(location.file);
  if (current.parentIdentity.dev !== location.parentIdentity.dev || current.parentIdentity.ino !== location.parentIdentity.ino) {
    throw new TransferFault("source_changed", "unpublished");
  }
}

export async function hashFile(handle: FileHandle, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(fileLimits.chunkBytes);
  let position = 0;
  while (true) {
    signal.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
    if (position > fileLimits.bytes) throw new TransferFault("source_changed", "unpublished");
  }
  return hash.digest("hex");
}

export async function openSource(input: string) {
  const location = await inspectLocalPath(input);
  let initial;
  try { initial = await lstat(location.file); }
  catch (error) { if (missing(error)) throw new TransferFault("source_missing", "unpublished"); throw error; }
  if (!initial.isFile()) throw new TransferFault("not_regular", "unpublished");
  if (initial.size > fileLimits.bytes) throw new TransferFault("too_large", "unpublished");
  const handle = await open(location.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(initial, await handle.stat())) throw new TransferFault("source_changed", "unpublished");
    await assertParent(location);
  } catch (error) { await handle.close(); throw error; }
  return {
    handle, size: initial.size,
    async assertUnchanged() {
      await assertParent(location);
      if (!sameFile(initial, await handle.stat()) || !sameFile(initial, await lstat(location.file))) throw new TransferFault("source_changed", "unpublished");
    },
  };
}

export async function prepareDestination(input: string) {
  const location = await inspectLocalPath(input);
  try {
    await lstat(location.file);
    throw new TransferFault("conflict", "unpublished");
  } catch (error) { if (!missing(error)) throw error; }
  return {
    async create() {
      await assertParent(location);
      const temporary = path.join(location.parent, `.project-file-${randomUUID()}.part`);
      const handle = await open(temporary, "wx+", 0o600);
      const identity = await handle.stat();
      let published = false;
      let closed = false;
      const close = async () => { if (!closed) { closed = true; await handle.close(); } };
      const ownsTemporary = async () => {
        const entry = await lstat(temporary);
        return !entry.isSymbolicLink() && entry.isFile() && entry.dev === identity.dev && entry.ino === identity.ino;
      };
      return {
        handle,
        get published() { return published; },
        async publish() {
          await handle.sync();
          await assertParent(location);
          if (!await ownsTemporary()) throw new TransferFault("source_changed", "unpublished");
          await close();
          try { await link(temporary, location.file); published = true; }
          catch (error) {
            if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new TransferFault("conflict", "unpublished");
            throw error;
          }
          await unlink(temporary);
        },
        async cleanup() {
          try {
            await close();
            await assertParent(location);
            if (!await ownsTemporary()) throw new TransferFault("cleanup_failed", published ? "published" : "unknown", true, "cleanup");
            await unlink(temporary);
          } catch (error) {
            if (!missing(error)) throw new TransferFault("cleanup_failed", published ? "published" : "unknown", true, "cleanup");
          }
        },
      };
    },
  };
}
