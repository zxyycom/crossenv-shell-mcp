import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '../..');
const zip = join(root, 'release/crossenv-shell-mcp-win-x64.zip');
const sha256 = data => createHash('sha256').update(data).digest('hex');

test('ZIP is self-contained, checksummed and supports CLI and same-process entry', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'crossenv-package-'));
  try {
    const checksum = (await readFile(`${zip}.sha256`, 'utf8')).split(/\s+/)[0];
    assert.equal(sha256(await readFile(zip)), checksum);
    const extract = spawnSync('tar.exe', ['-xf', zip, '-C', temp], { encoding: 'utf8' });
    assert.equal(extract.status, 0, extract.stderr);
    const manifest = JSON.parse(await readFile(join(temp, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, '0.1.0');
    for (const [path, digest] of Object.entries(manifest.files)) assert.equal(sha256(await readFile(join(temp, path))), digest, path);
    assert.equal(typeof createRequire(import.meta.url)(join(temp, 'dist/index.cjs')).startStdio, 'function');
    const invalid = spawnSync(process.execPath, [join(temp, 'dist/cli.cjs')], { encoding: 'utf8' });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout, '');
    const config = JSON.parse(await readFile(join(temp, 'samples/config.example.json'), 'utf8'));
    config.ssh.registryPath = join(temp, 'targets.json'); config.ssh.executionRoot = join(temp, 'units');
    await writeFile(config.ssh.registryPath, JSON.stringify({ schemaVersion: 1, targets: [] }));
    const configPath = join(temp, 'config.json'); await writeFile(configPath, JSON.stringify(config));
    const child = spawn(process.execPath, [join(temp, 'dist/cli.cjs'), '--config', configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { errors += chunk; });
    try {
      const reply = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`stdio timeout: ${errors}`)), 10000);
        child.on('error', reject); child.on('exit', code => reject(new Error(`stdio exited ${code}: ${errors}`)));
        child.stdout.on('data', chunk => { output += chunk; const line = output.split('\n').find(line => line.trim()); if (line) { clearTimeout(timeout); resolve(JSON.parse(line)); } });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'package-test', version: '1' } } }) + '\n');
      const response = await reply;
      assert.equal(response.id, 1); assert.ok(response.result?.serverInfo);
    } finally { child.kill(); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
