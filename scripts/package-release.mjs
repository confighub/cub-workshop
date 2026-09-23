#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: scriptDir, encoding: "utf8" }).trim();
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
if (outIndex === -1 || !args[outIndex + 1] || args.length !== 2) {
  throw new Error("usage: node scripts/package-release.mjs --out DIRECTORY");
}

const out = resolve(repo, args[outIndex + 1]);
if (existsSync(out)) throw new Error(`refusing to overwrite existing output directory: ${out}`);

const manifest = execFileSync("git", ["show", "HEAD:cub-plugin.yaml"], { cwd: repo, encoding: "utf8" });
const versionMatch = manifest.match(/^version:\s*["']?([^"'\s#]+)["']?(?:\s+#.*)?$/m);
if (!versionMatch) throw new Error("cub-plugin.yaml at HEAD has no version");
const version = versionMatch[1];
if (!/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(version)) throw new Error(`invalid plugin version: ${version}`);
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const prefix = `cub-workshop-v${version}/`;
const archiveBase = `cub-workshop-v${version}`;
const platforms = ["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"];

mkdirSync(out);
const tar = execFileSync("git", ["archive", "--format=tar", `--prefix=${prefix}`, "HEAD"], {
  cwd: repo,
  maxBuffer: 256 * 1024 * 1024,
});
const compressed = spawnSync("gzip", ["-n", "-c"], { input: tar, maxBuffer: 256 * 1024 * 1024 });
if (compressed.error) throw compressed.error;
if (compressed.status !== 0) throw new Error(`gzip failed: ${compressed.stderr?.toString() ?? "unknown error"}`);
const checksums = [];
for (const platform of platforms) {
  const filename = `${archiveBase}-${platform}.tar.gz`;
  writeFileSync(join(out, filename), compressed.stdout, { mode: 0o644, flag: "wx" });
  checksums.push(`${createHash("sha256").update(compressed.stdout).digest("hex")}  ${filename}`);
}

writeFileSync(join(out, "SHA256SUMS"), `${checksums.join("\n")}\n`, { mode: 0o644, flag: "wx" });
writeFileSync(join(out, "metadata.json"), `${JSON.stringify({ sourceCommit: commit, version }, null, 2)}\n`, { mode: 0o644, flag: "wx" });
console.log(`Packaged ${archiveBase} from ${commit} into ${out}`);
