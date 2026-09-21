// Self-contained helpers for the stack and fleet commands. No repository
// checkout is assumed: YAML parsing is the vendored js-yaml, object identity
// is a stable canonical form, and bundles are pulled by digest into a cache
// and hash-verified against the receipts shipped with the plugin.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverReceipt, parseReference } from "./oci.mjs";

const require = createRequire(import.meta.url);
const yaml = require("./yaml.cjs");

export const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

export function parseYaml(bytes) {
  return yaml.load(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes);
}

export function readYamlFile(path) {
  return parseYaml(readFileSync(path));
}

export function parseDocs(text) {
  return yaml.loadAll(text).filter((doc) => doc && typeof doc === "object");
}

export function toYaml(value) {
  return yaml.dump(value, { lineWidth: 120, noRefs: true });
}

// Canonical form: drop null and undefined values, sort keys, stable JSON.
function prune(value) {
  if (Array.isArray(value)) return value.map(prune);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      if (value[key] !== null && value[key] !== undefined) out[key] = prune(value[key]);
    }
    return out;
  }
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function identity(doc) {
  return [doc.apiVersion ?? "", doc.kind ?? "", doc.metadata?.namespace ?? "", doc.metadata?.name ?? ""].join("|");
}

export function canonicalMap(docs) {
  const map = {};
  for (const doc of docs) {
    if (!doc?.kind || !doc.metadata?.name) continue;
    const pruned = prune(doc);
    if (pruned.metadata?.annotations && Object.keys(pruned.metadata.annotations).length === 0) delete pruned.metadata.annotations;
    if (pruned.metadata?.labels && Object.keys(pruned.metadata.labels).length === 0) delete pruned.metadata.labels;
    map[identity(doc)] = stableStringify(pruned);
  }
  return map;
}

export const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

// Pull a digest-pinned bundle once into a digest-keyed cache, verify every
// role-less file against the shipped receipt, and return its parsed objects.
export function resolveBundle(component) {
  const digest = (component.bundle.match(/@(sha256:[0-9a-f]{64})$/) ?? [])[1];
  if (!digest) fail(`component "${component.name}" bundle must be pinned by digest`);
  // A receipt shipped with the plugin, or the one attached to the digest in the registry.
  let receipt;
  if (component.receipt) receipt = readYamlFile(isAbsolute(component.receipt) ? component.receipt : join(pluginRoot, component.receipt));
  else {
    const found = discoverReceipt(component.bundle);
    if (!found) fail(`component "${component.name}" has no receipt: pass receipt: or attach one to the digest`);
    receipt = found.receipt;
  }
  // Configuration content is every role-less entry plus the rendered object
  // set; route and guide entries are companion evidence and stay behind.
  // Producer bundles keep receipt paths as-is; catalog bundles flatten to the
  // basename, so each entry is located by exact path first, then basename.
  const files = receipt.spec.bundle.files.filter((file) => !file.role || file.role === "rendered object set");
  if (files.length === 0) fail(`component "${component.name}" receipt names no configuration files`);
  if (files.some((file) => typeof file.path !== "string" || isAbsolute(file.path) || file.path.split(/[\\/]+/).includes(".."))) {
    fail(`component "${component.name}" receipt contains an unsafe file path`);
  }
  const receiptDigest = receipt.spec.bundle.digest ?? receipt.spec.bundle.manifestDigest
    ?? (String(receipt.spec.bundle.reference ?? "").match(/@(sha256:[0-9a-f]{64})$/) ?? [])[1];
  if (receiptDigest && receiptDigest !== digest) fail(`component "${component.name}" receipt is for ${receiptDigest}, not ${digest}`);
  const locateVerified = (directory) => {
    let root;
    try { root = realpathSync(directory); } catch { return null; }
    const verify = (candidate, file) => {
      if (!existsSync(candidate)) return null;
      try {
        const resolved = realpathSync(candidate);
        if (resolved !== root && !resolved.startsWith(`${root}/`)) return null;
        if (!statSync(resolved).isFile() || sha256(readFileSync(resolved)) !== file.sha256) return null;
        return resolved;
      } catch { return null; }
    };
    const located = files.map((file) => {
      const exact = join(directory, file.path);
      const flat = join(directory, file.path.split("/").pop());
      return existsSync(exact) ? verify(exact, file) : verify(flat, file);
    });
    return located.every(Boolean) ? located : null;
  };
  // Shipped plugin caches historically use a 16-hex prefix. Keep consuming
  // those bytes only after the receipt proves they belong to this digest.
  const seeded = join(pluginRoot, "cache", digest.slice(7, 23));
  let located = receiptDigest === digest && existsSync(seeded) ? locateVerified(seeded) : null;
  const cacheRoot = join(tmpdir(), "cub-stack-bundles");
  const cacheDir = join(cacheRoot, digest.slice(7));
  if (!located && existsSync(cacheDir) && existsSync(join(cacheDir, ".ok"))) {
    located = locateVerified(cacheDir);
    if (!located) fail(`component "${component.name}" cache is marked complete but does not match its receipt`);
  }
  if (!located) {
    let stage; let pullDir; let published = false;
    try {
      stage = mkdtempSync(join(tmpdir(), `cub-stack-bundle-${digest.slice(7)}-`));
      pullDir = mkdtempSync(join(tmpdir(), `cub-stack-pull-${digest.slice(7)}-`));
      const pullArgs = ["pull", component.bundle.replace(/^oci:\/\//, ""), "-o", pullDir];
      if (parseReference(component.bundle).plain) pullArgs.push("--plain-http");
      execFileSync("oras", pullArgs, { encoding: "utf8" });
      const tarball = readdirSync(pullDir).find((name) => /\.(tar|tar\.gz|tgz)$/.test(name));
      if (!tarball) throw new Error(`component "${component.name}" bundle has no tarball layer`);
      execFileSync("tar", ["-xf", join(pullDir, tarball), "-C", stage], { encoding: "utf8" });
      located = locateVerified(stage);
      if (!located) throw new Error(`component "${component.name}" pulled files do not match its receipt`);
      writeFileSync(join(stage, ".ok"), "complete\n", { flag: "wx" });
      mkdirSync(cacheRoot, { recursive: true });
      if (!existsSync(cacheDir)) {
        try { renameSync(stage, cacheDir); published = true; located = locateVerified(cacheDir); }
        catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
      }
      if (!published) {
        if (!existsSync(join(cacheDir, ".ok"))) throw new Error(`component "${component.name}" cache publication was incomplete`);
        located = locateVerified(cacheDir);
        if (!located) throw new Error(`component "${component.name}" winning cache does not match its receipt`);
      }
    } finally {
      if (stage && !published) rmSync(stage, { recursive: true, force: true });
      if (pullDir) rmSync(pullDir, { recursive: true, force: true });
    }
  }
  return located.flatMap((path) => parseDocs(readFileSync(path, "utf8")));
}

const TRANSIENT = /connection reset by peer|connection refused|unexpected EOF|i\/o timeout|502 Bad Gateway|503 Service Unavailable/i;

// A server that is restarting or dropping a connection should not end a
// fleet operation. A transient network failure is retried three times with a
// growing pause; every other failure surfaces at once, with cub's own stderr.
export function cub(args, options = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync("cub", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["inherit", "pipe", "pipe"], ...options });
    if (result.status === 0) {
      if (result.stderr) process.stderr.write(result.stderr);
      return result.stdout;
    }
    const text = String(result.stderr || result.stdout || result.error?.message || "");
    const transient = text.match(TRANSIENT);
    if (attempt < 4 && transient) {
      console.log(`  (${transient[0].toLowerCase()}; retrying ${attempt}/3)`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000 * attempt);
      continue;
    }
    const error = new Error(`Command failed: cub ${args.join(" ")}\n${text}`);
    Object.assign(error, { status: result.status, stdout: result.stdout, stderr: text });
    throw error;
  }
}

// docker.io names an official image as library/<name>, and a bare name means Docker Hub.
export function pullReference(image) {
  const first = image.split("/")[0];
  const hasRegistry = image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  const registry = hasRegistry ? first : "docker.io";
  const path = hasRegistry ? image.slice(first.length + 1) : image;
  const official = /^docker\.io$|^registry-1\.docker\.io$|^index\.docker\.io$/.test(registry) && !path.includes("/");
  return `${registry}/${official ? `library/${path}` : path}`;
}
