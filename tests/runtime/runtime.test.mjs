import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.ts";
import { localProgramPrefix } from "../../src/shell-router.ts";
import { buildShellCatalog, shellIdentifier } from "../../src/catalog.ts";

const fixture = (dir) => ({ version: 1, host: {targetId:"host", binding:"trusted-local"},
  wsl: {targetId:"local_wsl", distribution:"Example", user:"alice", shellVersion:"5.2"},
  compose: {targetId:"dev", wslTargetId:"local_wsl", project:"sample", service:"app", user:"worker", workingDirectory:"/work", shellVersion:"5.2"},
  ssh: {registryPath:path.join(dir,"registry.json"), executionRoot:path.join(dir,"units")} });

test("explicit config validates identity, path, and version boundaries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crossenv-test-"));
  try {
    const file = path.join(dir,"config.json"); const config = fixture(dir);
    await writeFile(file, JSON.stringify(config));
    assert.deepEqual(loadConfig(file), config);
    assert.throws(() => loadConfig("relative.json"), /absolute/);
    config.compose.wslTargetId = "other"; await writeFile(file, JSON.stringify(config));
    assert.throws(() => loadConfig(file), /route/);
    config.compose.wslTargetId = config.wsl.targetId; config.ssh.registryPath = "relative";
    await writeFile(file, JSON.stringify(config)); assert.throws(() => loadConfig(file), /absolute/);
  } finally { await rm(dir, {recursive:true, force:true}); }
});

test("catalog fixes shell pairs and refuses collisions", () => {
  const config = fixture(os.tmpdir());
  const catalog = buildShellCatalog([], config);
  assert.deepEqual(catalog.map(shellIdentifier), ["bash-5.2", "bash-5.2"]);
  assert.throws(() => buildShellCatalog([{targetId:"dev", displayName:"collision", shell:"bash", shellVersion:"5.2"}], config), /duplicate/);
});

test("Compose routes only to one already running container", async () => {
  const config = fixture(os.tmpdir()); const calls = [];
  const run = async (argv) => { calls.push(argv); return {exitCode:0, stdout:"abc123\n", stderr:""}; };
  const argv = await localProgramPrefix("ai-dev", run, {}, config, "direct");
  assert.equal(calls.length, 1); assert.ok(calls[0].includes("ps"));
  assert.ok(calls[0].includes("label=com.docker.compose.project=sample"));
  assert.deepEqual(argv.slice(-7), ["exec", "--interactive", "--user", "worker", "--workdir", "/work", "abc123"]);
  for (const stdout of ["", "one\ntwo\n"]) await assert.rejects(localProgramPrefix("ai-dev", async () => ({exitCode:0,stdout,stderr:""}), {}, config), /exactly one/);
});


test("stdio declares four tools and rejects mismatched pair without execution", async () => {
  const { Client } = await import("@modelcontextprotocol/client");
  const { StdioServerTransport, serveStdio } = await import("@modelcontextprotocol/server/stdio");
  const { PassThrough } = await import("node:stream");
  const { createProjectShellServer } = await import("../../src/server.ts");
  const dir = await mkdtemp(path.join(os.tmpdir(), "crossenv-protocol-"));
  const config = fixture(dir); const file = path.join(dir, "config.json");
  await writeFile(config.ssh.registryPath, JSON.stringify({schemaVersion:1,targets:[]}));
  await writeFile(file, JSON.stringify(config));
  const input = new PassThrough(), output = new PassThrough(); let calls = 0;
  const catalog = [...buildShellCatalog([], config), { environment:"windows", displayName:"Windows fixture", backend:"ssh", targetId:"windows", shell:"windows-powershell", shellVersion:"5.1" }];
  const server = await createProjectShellServer({configPath:file, catalog, executionContext:{prepared:{}}, execute:async () => { calls++; return {exitCode:7,stdout:"out",stderr:"err"}; }});
  const handle = serveStdio(() => server, {transport:new StdioServerTransport(input,output)});
  const client = new Client({name:"test",version:"1"});
  try {
    await client.connect(new StdioServerTransport(output,input));
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name), ["shell","transfer_file","wait_transfer","cancel_transfer"]);
    const schema = tools.find(tool => tool.name === "shell").inputSchema;
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required ?? [], []);
    for (const [target, shell] of [["local_wsl", "bash-5.2"], ["windows", "windows-powershell-5.1"]]) {
      const branches = schema.oneOf.filter(branch => branch.properties?.targetId?.const === target);
      assert.equal(branches.length, 1);
      assert.equal(branches[0].properties.shell.const, shell);
      assert.deepEqual([...branches[0].required].sort(), ["command", "shell", "targetId"]);
    }
    const fileTool = tools.find(tool => tool.name === "transfer_file");
    assert.match(fileTool.description, /bytes stay out of model context/);
    assert.match(fileTool.description, /Requires authorization for exact paths/);
    for (const args of [
      {targetId:"local_wsl",shell:"bash-9.9",command:"ignored"},
      {targetId:"local_wsl",shell:"powershell-7.6",command:"ignored"},
      {targetId:"local_wsl",command:"ignored"},
      {shell:"bash-5.2",command:"ignored"},
      {targetId:"local_wsl",shell:"bash-5.2"},
    ]) {
      const bad = await client.callTool({name:"shell",arguments:args});
      assert.equal(bad.isError, true);
    }
    assert.equal(calls, 0);
    const result = await client.callTool({name:"shell",arguments:{targetId:"local_wsl",shell:"bash-5.2",command:"example"}});
    assert.deepEqual(result.structuredContent, {kind:"process",exitCode:7,stdout:"out",stderr:"err"});
    assert.equal(result.isError,true); assert.equal(calls,1);
    const transfer = await client.callTool({name:"transfer_file",arguments:{source:{targetId:"host",path:"C:\\source"},destination:{targetId:"host",path:"C:\\destination"},wait_seconds:0}});
    assert.equal(transfer.isError,true); assert.equal(transfer.structuredContent.postState,"unpublished");
  } finally { await client.close(); await handle.close(); await rm(dir,{recursive:true,force:true}); }
});
