# crossenv-shell-mcp

A Windows x64 stdio MCP server for explicit WSL, running Compose container, and SSH targets. It requires Node.js 24.18 or newer and the system tools used by each route. The ZIP does not include Node; starting it requires neither npm dependencies nor network access.

## Install and run

Obtain the ZIP and its SHA-256 digest through a trusted channel, verify the digest, and extract it to a dedicated directory. A digest verifies byte consistency, not origin. Prepare a separate version 1 JSON configuration and the SSH registry and execution units; configuration and trust material are not supplied by the product. Then run:

```powershell
node <extracted-directory>\dist\cli.cjs --config <absolute-config-path>
```

The CLI is for the machine stdio protocol; diagnostics go to stderr. To embed it in the same Node process, call `require(<absolute-path-to-dist/index.cjs>).startStdio({ configPath: <absolute-config-path> })`. See `samples/config.example.json` for the configuration shape: all names and paths there are synthetic placeholders and must be replaced. Choose `host.binding` for the caller's trust boundary. The deployer creates and verifies SSH registrations and execution units.

`manifest.json` records the product version and SHA-256 of each packaged file, excluding itself. The adjacent `.sha256` verifies the complete ZIP. Keep personal configuration, keys and trust material out of release artifacts. Connection, file writes and cold starts require their own authorization; after failure or cancellation, do not assume a remote write did not occur.

## Build from source

Use Node.js 24.18 or newer, the pinned pnpm version and locked dependencies. After `pnpm install --frozen-lockfile`, run `node scripts/build.mjs` on Windows. The build does not connect to targets or apply configuration. Artifacts are written under `release/`; do not include dependency directories, artifacts, real configuration or trust material in the source snapshot. Source consumers can import the execution-unit public module from the pinned `crossenv-shell-mcp/ssh` source package. Before release, independently review licenses, source and artifacts; a checksum alone does not establish a trusted origin.

The project's own code is MIT licensed. See `THIRD-PARTY-LICENSES.txt` in the bundle for included third-party licenses.
