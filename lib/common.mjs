// Self-contained helpers for the stack and fleet commands. No repository
// checkout is assumed: YAML parsing is the vendored js-yaml, object identity
// is a stable canonical form, and bundles are pulled by digest into a cache
// and hash-verified against the receipts shipped with the plugin.

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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

export function readYamlFile(path) {
  return yaml.load(readFileSync(path, "utf8"));
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
  // A seeded cache ships with the plugin so a bundle named by digest certifies
  // offline; the receipt is still what every file is verified against.
  const seeded = join(pluginRoot, "cache", digest.slice(7, 23));
  const cacheDir = existsSync(seeded) ? seeded : join(tmpdir(), "cub-stack-bundles", digest.slice(7, 23));
  if (cacheDir !== seeded && !existsSync(join(cacheDir, ".ok"))) {
    mkdirSync(cacheDir, { recursive: true });
    const pullArgs = ["pull", component.bundle.replace(/^oci:\/\//, ""), "-o", `${cacheDir}-pull`];
    if (parseReference(component.bundle).plain) pullArgs.push("--plain-http");
    execFileSync("oras", pullArgs, { encoding: "utf8" });
    const tarball = readdirSync(`${cacheDir}-pull`).find((name) => /\.(tar|tar\.gz|tgz)$/.test(name));
    if (!tarball) fail(`component "${component.name}" bundle has no tarball layer`);
    execFileSync("tar", ["-xf", join(`${cacheDir}-pull`, tarball), "-C", cacheDir], { encoding: "utf8" });
    execFileSync("touch", [join(cacheDir, ".ok")], { encoding: "utf8" });
  }
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
  const located = files.map((file) => {
    const exact = join(cacheDir, file.path);
    const flat = join(cacheDir, file.path.split("/").pop());
    const path = existsSync(exact) ? exact : flat;
    if (!existsSync(path) || sha256(readFileSync(path)) !== file.sha256) {
      fail(`component "${component.name}" file ${file.path} does not match its receipt`);
    }
    return path;
  });
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
