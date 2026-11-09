import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

if (process.argv[2] === "--child") {
  setTimeout(async () => {
    await writeFile(`${process.argv[3]}.child-exited`, "done");
    process.exit();
  }, 3000);
} else {
  const parentExits = process.argv[3] === "--parent-exits";
  const child = spawn(process.execPath, [import.meta.filename, "--child", process.argv[2]], {
    stdio: parentExits ? "inherit" : "ignore",
    detached: parentExits,
    cwd: path.dirname(import.meta.filename),
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await writeFile(process.argv[2], JSON.stringify([process.pid, child.pid]));
  await writeFile(`${process.argv[2]}.ready`, "ready");
  if (parentExits) process.exit();
  setTimeout(() => process.exit(), 10_000);
}
