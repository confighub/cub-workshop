#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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
for (const path of [`${prefix}bin/cub-workshop`, `${prefix}cub-plugin.yaml`]) {
  if (Buffer.byteLength(path) > 100) throw new Error(`release version makes a package path too long for deterministic ustar: ${version}`);
}

mkdirSync(out);
const sourceTar = execFileSync("git", ["archive", "--format=tar", `--prefix=${prefix}`, "HEAD"], {
  cwd: repo,
  maxBuffer: 256 * 1024 * 1024,
});
const checksums = [];
const buildDir = mkdtempSync(join(tmpdir(), "cub-workshop-release-"));
try {
  const extracted = join(buildDir, "source");
  mkdirSync(extracted);
  const unpack = spawnSync("tar", ["-xf", "-", "-C", extracted], { input: sourceTar, maxBuffer: 256 * 1024 * 1024 });
  if (unpack.error) throw unpack.error;
  if (unpack.status !== 0) throw new Error(`tar extraction failed: ${unpack.stderr?.toString() ?? "unknown error"}`);
  const sourceRoot = join(extracted, prefix.slice(0, -1));
  const sourceManifest = readFileSync(join(sourceRoot, "cub-plugin.yaml"));
  const hookDir = join(buildDir, "hook-stage");
  mkdirSync(hookDir);
  writeFileSync(join(hookDir, "cub-plugin.yaml"), sourceManifest);
  const binaries = new Map();
  for (const platform of platforms) {
    const [goos, goarch] = platform.split("-");
    const binary = join(buildDir, `cub-workshop-${platform}`);
    execFileSync("go", ["build", "-C", join(sourceRoot, "plugin-host"), "-trimpath", "-o", binary, "."], {
      cwd: repo,
      env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
      stdio: "inherit",
    });
    binaries.set(platform, binary);
  }
  const hostOS = process.platform === "darwin" ? "darwin" : process.platform;
  const hostArch = process.arch === "x64" ? "amd64" : process.arch;
  const hostPlatform = `${hostOS}-${hostArch}`;
  const hookBinary = binaries.get(hostPlatform);
  if (!hookBinary) throw new Error(`no plugin host target for packaging machine ${hostPlatform}`);
  execFileSync(hookBinary, [], {
    cwd: hookDir,
    env: { ...process.env, CUB_PLUGIN_HOOK: "install", CUB_PLUGIN_DIR: hookDir },
    stdio: "inherit",
  });
  const routedManifest = readFileSync(join(hookDir, "cub-plugin.yaml"));

  for (const platform of platforms) {
    const binary = binaries.get(platform);
    const archive = replaceTarFiles(sourceTar, [
      { name: `${prefix}bin/cub-workshop`, contents: readFileSync(binary), mode: 0o755 },
      { name: `${prefix}cub-plugin.yaml`, contents: routedManifest, mode: 0o644 },
    ]);
    const compressed = spawnSync("gzip", ["-n", "-c"], { input: archive, maxBuffer: 256 * 1024 * 1024 });
    if (compressed.error) throw compressed.error;
    if (compressed.status !== 0) throw new Error(`gzip failed: ${compressed.stderr?.toString() ?? "unknown error"}`);
    const filename = `${archiveBase}-${platform}.tar.gz`;
    writeFileSync(join(out, filename), compressed.stdout, { mode: 0o644, flag: "wx" });
    checksums.push(`${createHash("sha256").update(compressed.stdout).digest("hex")}  ${filename}`);
  }
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}

writeFileSync(join(out, "SHA256SUMS"), `${checksums.join("\n")}\n`, { mode: 0o644, flag: "wx" });
writeFileSync(join(out, "metadata.json"), `${JSON.stringify({ sourceCommit: commit, version }, null, 2)}\n`, { mode: 0o644, flag: "wx" });
console.log(`Packaged ${archiveBase} from ${commit} into ${out}`);

// Replace deterministic ustar members while preserving git archive's
// normalized source tree. This keeps each platform archive reproducible while
// giving it a native plugin host and an SDK-generated release manifest.
function replaceTarFiles(source, replacements) {
  const byName = new Map(replacements.map((member) => [member.name, member]));
  const output = [];
  const seen = new Set();
  for (let offset = 0; offset + 512 <= source.length; ) {
    const header = source.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid git archive tar member size");
    const memberEnd = offset + 512 + Math.ceil(size / 512) * 512;
    const headerName = tarString(header.subarray(0, 100));
    const headerPrefix = tarString(header.subarray(345, 500));
    const name = headerPrefix ? `${headerPrefix}/${headerName}` : headerName;
    const replacement = byName.get(name);
    if (replacement) {
      output.push(tarMember(replacement.name, replacement.contents, replacement.mode));
      seen.add(name);
    } else {
      output.push(source.subarray(offset, memberEnd));
    }
    offset = memberEnd;
  }
  for (const replacement of replacements) {
    if (!seen.has(replacement.name)) output.push(tarMember(replacement.name, replacement.contents, replacement.mode));
  }
  output.push(Buffer.alloc(1024));
  return Buffer.concat(output);
}

function tarMember(name, contents, mode) {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar path is too long: ${name}`);
  const header = Buffer.alloc(512);
  Buffer.from(name).copy(header, 0);
  octal(header, 100, 8, mode);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, contents.length);
  octal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  Buffer.from("ustar\0").copy(header, 257);
  Buffer.from("00").copy(header, 263);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  Buffer.from(checksum.toString(8).padStart(6, "0") + "\0 ").copy(header, 148);
  const body = Buffer.alloc(Math.ceil(contents.length / 512) * 512);
  contents.copy(body);
  return Buffer.concat([header, body]);
}

function octal(header, offset, length, value) {
  const encoded = Math.trunc(value).toString(8).padStart(length - 1, "0") + "\0";
  if (encoded.length > length) throw new Error(`tar value too large at ${offset}`);
  Buffer.from(encoded).copy(header, offset);
}

function tarString(field) {
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
}
