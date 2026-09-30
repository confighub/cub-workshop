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

// A tool that is not on PATH reaches the user as "spawnSync oras ENOENT",
// which names neither what the tool is for nor what to do next. Catching the
// ENOENT at the call costs nothing when the tool is present.
export function toolMissing(error, tool, needs) {
  return error?.code === "ENOENT" && error.path === tool ? new Error(`${tool} is not installed; ${needs}. Install it and run the command again.`) : error;
}

// needs reads "<verb> needs it to <why>", e.g. "publish needs it to push the bundle".
export function runTool(tool, args, options, needs) {
  try { return execFileSync(tool, args, options); } catch (error) { throw toolMissing(error, tool, needs); }
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

// Pull a digest-pinned bundle once into a digest-keyed cache and verify the
// configuration plus lifecycle routes which the receipt names. The normal
// resolver keeps its array API and returns Kubernetes objects only; callers
// saving a workspace can ask for the verified companion bytes as evidence.
export function resolveBundleDetails(component, options) {
  try { return pullAndResolveBundle(component, options); } catch (error) { throw toolMissing(error, "oras", "resolving an uncached bundle needs it to pull the bundle by digest"); }
}

// Name the first receipt path that is missing from a pulled directory or whose
// bytes differ, with the same candidate names the located check accepts, so a
// refusal says which file to look at instead of only that something differs.
function firstReceiptMismatch(directory, files) {
  for (const file of files) {
    const base = file.path.split("/").pop();
    const candidates = [join(directory, file.path), join(directory, base)];
    if (String(file.role ?? "").startsWith("route:")) candidates.push(join(directory, "routes", base));
    const candidate = candidates.find((entry) => existsSync(entry));
    if (!candidate) return `: ${file.path} is missing from the pulled bundle`;
    let actual;
    try { actual = sha256(readFileSync(candidate)); } catch { return `: ${file.path} could not be read from the pulled bundle`; }
    if (actual !== file.sha256) return `: ${file.path} has sha256 ${actual.slice(0, 12)}, the receipt records ${file.sha256.slice(0, 12)}`;
  }
  return "";
}

function pullAndResolveBundle(component, { includeRoutes = true } = {}) {
  const digest = (component.bundle.match(/@(sha256:[0-9a-f]{64})$/) ?? [])[1];
  if (!digest) fail(`component "${component.name}" bundle must be pinned by digest`);
  // A receipt shipped with the plugin, or the one attached to the digest in the registry.
  let receipt; let receiptBytes; let receiptSource;
  if (component.receipt) {
    const receiptPath = isAbsolute(component.receipt) ? component.receipt : join(pluginRoot, component.receipt);
    receiptSource = component.receiptSource ?? component.receipt;
    receiptBytes = readFileSync(receiptPath);
    receipt = parseYaml(receiptBytes);
  }
  else {
    const found = discoverReceipt(component.bundle);
    if (!found) fail(`component "${component.name}" has no receipt: pass receipt: or attach one to the digest`);
    receipt = found.receipt;
    receiptBytes = Buffer.from(JSON.stringify(receipt, null, 2));
    receiptSource = `oci-referrer:${found.receiptDigest}`;
  }
  // Configuration content is every role-less entry plus the rendered object
  // set. Routes stay out of the Kubernetes object stream, but are retained as
  // verified evidence when a workspace is saved. Guides are human-facing
  // companions, not route inputs, and remain available through the receipt.
  // Producer bundles keep receipt paths as-is; catalog bundles flatten to the
  // basename, so each entry is located by exact path first, then basename.
  const configurationFiles = receipt.spec?.bundle?.files?.filter((file) => !file.role || file.role === "rendered object set") ?? [];
  const companions = includeRoutes ? (receipt.spec?.bundle?.files?.filter((file) => String(file.role ?? "").startsWith("route:")) ?? []) : [];
  const files = [...configurationFiles, ...companions];
  if (configurationFiles.length === 0) fail(`component "${component.name}" receipt names no configuration files`);
  if (files.some((file) => typeof file.path !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256 ?? "") || isAbsolute(file.path) || file.path.split(/[\\/]+/).includes(".."))) {
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
      const base = file.path.split("/").pop();
      const candidates = [join(directory, file.path), join(directory, base)];
      // Certified catalog bundles package routes under routes/. This is an
      // explicit role convention, never a search by content hash, so a
      // receipt still fixes the evidence identity.
      if (String(file.role ?? "").startsWith("route:")) candidates.push(join(directory, "routes", base));
      // An existing preferred name must verify. Falling through to another
      // matching name would let a corrupted exact file hide behind an alias.
      const candidate = candidates.find((entry) => existsSync(entry));
      return candidate ? verify(candidate, file) : null;
    });
    return located.every(Boolean) ? located : null;
  };
  // Shipped plugin caches historically use a 16-hex prefix. Keep consuming
  // those bytes only after the receipt proves they belong to this digest.
  const seeded = join(pluginRoot, "cache", digest.slice(7, 23));
  let located = receiptDigest === digest && existsSync(seeded) ? locateVerified(seeded) : null;
  const cacheRoot = join(tmpdir(), "cub-stack-bundles");
  const cacheDir = join(cacheRoot, digest.slice(7));
  // An entry is published by renaming a verified, already-marked staging
  // directory into place, so a correct writer never exposes a partial one. An
  // entry that is unmarked or does not verify was left by something else: an
  // interrupted older writer, a manual copy, or the system pruning old files
  // under $TMPDIR. It is never repaired in place. The digest is pulled again,
  // and once the fresh pull verifies, the stale entry is moved aside and the
  // fresh one published. A marked entry is only discarded on that proof: when
  // the pull fails the same check, the bundle itself is at fault, not the cache.
  const verifiedEntry = () => (existsSync(join(cacheDir, ".ok")) ? locateVerified(cacheDir) : null);
  const staleReason = () => (existsSync(join(cacheDir, ".ok")) ? "is marked complete but does not match its receipt" : "is incomplete");
  // Only a discard ever removes an entry, and a discard holds this per-digest
  // lock and checks the entry again first, so an entry some process has
  // verified is never moved from under it. Publishing needs no lock: the
  // rename only lands where no entry exists.
  const lock = join(cacheRoot, `.${digest.slice(7)}.lock`);
  const discardStale = () => {
    try {
      try { mkdirSync(lock); } catch (error) {
        if (error.code !== "EEXIST") throw error;
        // Another process is replacing the entry. A lock left by a killed
        // process is taken over once it is clearly older than any discard.
        try { if (Date.now() - statSync(lock).mtimeMs < 30000) return false; } catch { return false; }
        rmSync(lock, { recursive: true, force: true });
        try { mkdirSync(lock); } catch { return false; }
      }
    } catch (error) {
      throw new Error(`component "${component.name}" cache ${cacheDir} ${staleReason()} and could not be removed (${error.message}); delete that directory and run the command again`);
    }
    let trash;
    try {
      if (!existsSync(cacheDir) || verifiedEntry()) return true;
      const why = staleReason();
      console.error(`note: component "${component.name}" cache ${cacheDir} ${why}; replacing it with a fresh pull`);
      try {
        trash = mkdtempSync(join(cacheRoot, `.discard-${digest.slice(7)}-`));
        renameSync(cacheDir, join(trash, "entry"));
      } catch (error) {
        throw new Error(`component "${component.name}" cache ${cacheDir} ${why} and could not be removed (${error.message}); delete that directory and run the command again`);
      }
      return true;
    } finally {
      if (trash) rmSync(trash, { recursive: true, force: true });
      rmSync(lock, { recursive: true, force: true });
    }
  };
  if (!located && existsSync(cacheDir)) located = verifiedEntry();
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
      if (!located) throw new Error(`component "${component.name}" pulled files do not match its receipt${firstReceiptMismatch(stage, files)}`);
      writeFileSync(join(stage, ".ok"), "complete\n", { flag: "wx" });
      mkdirSync(cacheRoot, { recursive: true });
      // A concurrent writer may win the rename; its entry then serves. A stale
      // entry in the way is discarded and the rename tried again, a bounded
      // number of times so a directory that keeps reappearing still ends.
      for (let attempt = 1; ; attempt += 1) {
        if (!existsSync(cacheDir)) {
          try { renameSync(stage, cacheDir); published = true; }
          catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
        }
        located = verifiedEntry();
        if (located) break;
        if (published) throw new Error(`component "${component.name}" cache ${cacheDir} changed while it was being published; delete that directory and run the command again`);
        if (attempt === 50) throw new Error(`component "${component.name}" cache ${cacheDir} ${staleReason()} and was not replaced; delete that directory and run the command again`);
        if (!discardStale()) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    } finally {
      if (stage && !published) rmSync(stage, { recursive: true, force: true });
      if (pullDir) rmSync(pullDir, { recursive: true, force: true });
    }
  }
  const locatedByHash = new Map(files.map((file, index) => [file.sha256, located[index]]));
  const companionEvidence = companions.map((file) => ({
    role: file.role,
    source: file.path,
    sha256: file.sha256,
    bytes: readFileSync(locatedByHash.get(file.sha256)),
  }));
  return {
    bundle: component.bundle,
    objects: configurationFiles.flatMap((file) => parseDocs(readFileSync(locatedByHash.get(file.sha256), "utf8"))),
    receipt: { source: receiptSource, sha256: sha256(receiptBytes), bytes: receiptBytes, bundleDigest: digest },
    companions: companionEvidence,
  };
}

export function resolveBundle(component) {
  return resolveBundleDetails(component, { includeRoutes: false }).objects;
}

const AUTH_PROBLEM = /authentication problem|token is expired|not logged in|no credentials/i;
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
    // cub ends some errors with a line holding only ".", which would leave a
    // caller that shows the last line with nothing to say. A missing or expired
    // login also gets the one step that fixes it.
    const lines = text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() && line.trim() !== ".");
    if (AUTH_PROBLEM.test(text)) lines.push("Failed: authentication problem: not logged in to ConfigHub, or the login expired. Run `cub auth login`, then run the command again.");
    const detail = lines.join("\n");
    const error = new Error(`Command failed: cub ${args.join(" ")}\n${detail}`);
    Object.assign(error, { status: result.status, stdout: result.stdout, stderr: detail, authProblem: AUTH_PROBLEM.test(text) });
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
