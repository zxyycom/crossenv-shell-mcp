import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(root, 'release');
const out = join(release, 'crossenv-shell-mcp-win-x64');
const zip = `${out}.zip`;
const hash = data => createHash('sha256').update(data).digest('hex');
const resourcePlugin = { name: 'resource-paths', setup(context) {
  context.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
    if (!path.startsWith(join(root, 'src') + sep)) return;
    let source = await readFile(path, 'utf8');
    source = source.replace(/new URL\("(\.\/[^"\n]+)", import\.meta\.url\)/g, (_, resource) => {
      const resourcePath = relative(join(root, 'src'), resolve(dirname(path), resource)).split(sep).join('/');
      if (resourcePath.startsWith('../')) throw new Error(`resource outside src: ${resource}`);
      return `new URL("./${resourcePath}", import.meta.url)`;
    });
    return { contents: source, loader: 'ts', resolveDir: dirname(path) };
  });
} };
// Never recursively remove a redirected output directory. Check each existing
// ancestor before resolving paths; a missing release/output is allowed.
async function assertPlainPath(path, expectedType) {
  let stat;
  try { stat = await lstat(path); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink() || (expectedType === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`Refusing redirected or unexpected ${expectedType}: ${path}`);
  }
  return true;
}
async function validateOutputPaths() {
  const volume = parse(root).root;
  const parts = relative(volume, root).split(sep).filter(Boolean);
  let current = volume;
  await assertPlainPath(current, 'directory');
  for (const part of parts) {
    current = join(current, part);
    if (!await assertPlainPath(current, 'directory')) throw new Error(`Missing product ancestor: ${current}`);
  }
  const realRoot = await realpath(root);
  const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!samePath(resolve(realRoot), root) || !samePath(resolve(out), join(realRoot, 'release', 'crossenv-shell-mcp-win-x64'))) {
    throw new Error('Product root or output path resolves outside the expected location');
  }
  if (await assertPlainPath(release, 'directory')) {
    if (!samePath(await realpath(release), join(realRoot, 'release'))) throw new Error('Redirected release directory');
    if (await assertPlainPath(out, 'directory')) {
      if (!samePath(await realpath(out), join(realRoot, 'release', 'crossenv-shell-mcp-win-x64'))) throw new Error('Redirected output directory');
    }
    await assertPlainPath(zip, 'file');
    await assertPlainPath(`${zip}.sha256`, 'file');
  }
}
await validateOutputPaths();
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'dist'), { recursive: true });
const result = await build({ entryPoints: { index: join(root, 'src/index.ts'), cli: join(root, 'src/cli.ts') }, outdir: join(out, 'dist'), outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node24', legalComments: 'inline', metafile: true, plugins: [resourcePlugin], define: { 'import.meta.url': '__bundle_url' }, banner: { js: 'const __bundle_url = require("node:url").pathToFileURL(__filename).href;' } });
async function copyResources(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const source = join(dir, entry.name);
    if (entry.isDirectory()) await copyResources(source);
    else if (!entry.name.endsWith('.ts')) {
      const destination = join(out, 'dist', relative(join(root, 'src'), source));
      await mkdir(dirname(destination), { recursive: true }); await cp(source, destination);
    }
  }
}
await copyResources(join(root, 'src'));
await cp(join(root, 'README.md'), join(out, 'README.md'));
await cp(join(root, 'samples'), join(out, 'samples'), { recursive: true });
await cp(join(root, 'LICENSE'), join(out, 'LICENSE'));
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const match = resolve(input).match(/^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/);
  if (!match) continue;
  const dir = match[1];
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  packages.set(pkg.name, { dir, version: pkg.version, license: pkg.license });
}
const notices = [];
for (const [name, pkg] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const entries = await readdir(pkg.dir);
  const licenseName = entries.find(entry => /^licen[cs]e(?:\..*)?$/i.test(entry));
  if (!licenseName || !pkg.license) throw new Error(`Missing license metadata or text: ${name}`);
  const noticeNames = entries.filter(entry => /^notice(?:\..*)?$/i.test(entry)).sort();
  for (const file of [licenseName, ...noticeNames]) {
    notices.push(`===== ${name}@${pkg.version} (${pkg.license}) / ${file} =====\n${await readFile(join(pkg.dir, file), 'utf8')}\n`);
  }
}
await writeFile(join(out, 'THIRD-PARTY-LICENSES.txt'), notices.join('\n'));
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(p)); else result.push(p);
  }
  return result;
}
const digests = {};
for (const file of (await files(out)).sort()) digests[relative(out, file).split(sep).join('/')] = hash(await readFile(file));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(out, 'manifest.json'), JSON.stringify({ name: pkg.name, version: pkg.version, platform: 'win32-x64', files: digests }, null, 2) + '\n');
await rm(zip, { force: true });
const archive = spawnSync('tar.exe', ['-a', '-cf', zip, '-C', out, '.'], { encoding: 'utf8' });
if (archive.status !== 0) throw new Error(`archive failed: ${archive.stderr}`);
await writeFile(`${zip}.sha256`, `${hash(await readFile(zip))}  ${zip.split(sep).pop()}\n`);
console.log(`Built ${zip}`);
