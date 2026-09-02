// The certified bundle as an OCI artifact: build it reproducibly, push it,
// attach its receipt as a referrer, find and pull it back, and verify it.
//
// This is the plugin's design center. Every verb reads and writes this one
// shape: a tar.gz layer of rendered configuration under the artifact type the
// catalog already publishes, with the receipt attached to the same digest so
// any consumer can pull the verdict with the objects. Registries on localhost
// are spoken to over plain HTTP so a throwaway registry works for tests.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BUNDLE_TYPE = "application/vnd.confighub.config.bundle.v1";
export const RECORD_TYPE = "application/vnd.confighub.record.v1+json";
// Uncompressed: gzip output differs between zlib builds, and a digest that
// changes with the machine that produced it is not a digest anyone can name.
export const LAYER_TYPE = "application/vnd.oci.image.layer.v1.tar";

export const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function ociFail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

// oci://host/repo[:tag][@sha256:...] -> { repo, tag, digest, plain }
export function parseReference(reference) {
  const bare = String(reference).replace(/^oci:\/\//, "");
  const digest = (bare.match(/@(sha256:[0-9a-f]{64})$/) ?? [])[1] ?? null;
  const withoutDigest = digest ? bare.slice(0, -(digest.length + 1)) : bare;
  const tagMatch = withoutDigest.match(/^(.+?):([A-Za-z0-9_][A-Za-z0-9._-]{0,127})$/);
  const repo = tagMatch && !tagMatch[1].includes("/") === false && !/^\d+$/.test(tagMatch[2]) ? tagMatch[1] : withoutDigest;
  const tag = repo === withoutDigest ? null : tagMatch[2];
  const host = repo.split("/")[0];
  const plain = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.)/.test(host) || /^[^/]+:\d+$/.test(host) && !host.includes(".");
  return { repo, tag, digest, plain };
}

export function oras(args, { plain = false, cwd = undefined } = {}) {
  const full = plain ? [...args, "--plain-http"] : args;
  return execFileSync("oras", full, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], cwd });
}

// oras prints the subject digest before the "Digest:" line of what it just
// wrote, so take the Digest line, and the last digest as a fallback.
const digestFrom = (output) => {
  const line = output.match(/Digest:\s*(sha256:[0-9a-f]{64})/);
  if (line) return line[1];
  const all = output.match(/sha256:[0-9a-f]{64}/g);
  return all ? all[all.length - 1] : ociFail(`registry returned no digest:\n${output}`);
};

// A minimal ustar writer: regular files only, sorted by path, root ownership,
// epoch mtimes, so the same content always yields the same bytes.
function tarHeader(name, size) {
  if (Buffer.byteLength(name) > 100) ociFail(`tar entry name too long: ${name}`);
  const header = Buffer.alloc(512, 0);
  const put = (offset, length, value) => header.write(value, offset, length, "utf8");
  put(0, 100, name);
  put(100, 8, "0000644\0");
  put(108, 8, "0000000\0");
  put(116, 8, "0000000\0");
  put(124, 12, size.toString(8).padStart(11, "0") + "\0");
  put(136, 12, "00000000000\0");
  put(148, 8, "        ");
  put(156, 1, "0");
  put(257, 6, "ustar\0");
  put(263, 2, "00");
  let sum = 0;
  for (const byte of header) sum += byte;
  put(148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return header;
}

export function reproducibleTar(files) {
  const chunks = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
    chunks.push(tarHeader(file.path, content.length), content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

// Push a bundle and attach its receipt to the bundle's own digest. Returns the
// bundle digest; the receipt records that digest before it is attached.
export function publishBundle({ reference, files, receipt, title }) {
  const { repo, tag, plain } = parseReference(reference);
  const work = mkdtempSync(join(tmpdir(), "cub-workshop-oci-"));
  const tarGz = reproducibleTar(files);
  const bundlePath = join(work, "bundle.tar");
  writeFileSync(bundlePath, tarGz);
  const target = tag ? `${repo}:${tag}` : `${repo}:latest`;
  // A fixed created annotation keeps the manifest digest reproducible across
  // pushes and registries; the receipt carries the real time.
  const pushed = oras(["push", target, "--artifact-type", BUNDLE_TYPE, "--annotation", `org.opencontainers.image.title=${title}`, "--annotation", "org.opencontainers.image.created=1970-01-01T00:00:00Z", `bundle.tar:${LAYER_TYPE}`], { plain, cwd: work });
  const digest = digestFrom(pushed);
  receipt.spec.bundle.artifactType = BUNDLE_TYPE;
  receipt.spec.bundle.reference = `oci://${repo}@${digest}`;
  receipt.spec.bundle.digest = digest;
  receipt.spec.bundle.layerSHA256 = sha256(tarGz);
  const receiptPath = join(work, "receipt.json");
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  const attached = oras(["attach", `${repo}@${digest}`, "--artifact-type", RECORD_TYPE, `receipt.json:${RECORD_TYPE}`], { plain, cwd: work });
  return { digest, receiptDigest: digestFrom(attached), repo, work, tarGz };
}

// Attach any JSON record to a digest as a referrer.
export function attachRecord({ reference, digest, record, fileName = "record.json" }) {
  const { repo, plain } = parseReference(reference);
  const work = mkdtempSync(join(tmpdir(), "cub-workshop-attach-"));
  writeFileSync(join(work, fileName), JSON.stringify(record, null, 2));
  const attached = oras(["attach", `${repo}@${digest}`, "--artifact-type", RECORD_TYPE, `${fileName}:${RECORD_TYPE}`], { plain, cwd: work });
  return digestFrom(attached);
}

// Find records attached to a digest, pull each, and return those of a kind.
export function discoverRecords(reference, kind = null) {
  const { repo, digest, plain } = parseReference(reference);
  if (!digest) ociFail(`discovery needs a digest: ${reference}`);
  const listing = JSON.parse(oras(["discover", `${repo}@${digest}`, "--artifact-type", RECORD_TYPE, "--format", "json"], { plain }));
  const found = [];
  for (const entry of listing.manifests ?? listing.referrers ?? []) {
    const work = mkdtempSync(join(tmpdir(), "cub-workshop-record-"));
    oras(["pull", `${repo}@${entry.digest}`, "-o", work], { plain });
    for (const file of readdirSync(work)) {
      if (!/\.(json|yaml|yml)$/.test(file)) continue;
      try {
        const record = JSON.parse(readFileSync(join(work, file), "utf8"));
        if (!kind || record.kind === kind) found.push({ record, recordDigest: entry.digest });
      } catch { /* not a JSON record */ }
    }
  }
  return found;
}

// Find the receipt attached to a digest, pull it, and return it parsed.
export function discoverReceipt(reference) {
  const found = discoverRecords(reference, "CertifiedBundleReceipt")[0];
  return found ? { receipt: found.record, receiptDigest: found.recordDigest } : null;
}

// Signing with a cosign key pair; keyless signing needs an interactive
// identity and stays an open item. Verification says plainly when no key was
// offered, so an unchecked signature never reads as a checked one.
export function signDigest({ reference, digest, key }) {
  const { repo, plain } = parseReference(reference);
  const args = ["sign", "--key", key, "--yes", `${repo}@${digest}`];
  if (plain) args.push("--allow-http-registry", "--allow-insecure-registry");
  execFileSync("cosign", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, COSIGN_PASSWORD: process.env.COSIGN_PASSWORD ?? "" } });
}

export function verifySignature({ reference, digest, key }) {
  const { repo, plain } = parseReference(reference);
  const args = ["verify", "--key", key, `${repo}@${digest}`];
  if (plain) args.push("--allow-http-registry", "--allow-insecure-registry");
  try {
    execFileSync("cosign", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

// Pull a bundle by digest into a fresh directory and return the extracted files.
export function pullBundle(reference) {
  const { repo, digest, plain } = parseReference(reference);
  if (!digest) ociFail(`pull needs a digest: ${reference}`);
  const work = mkdtempSync(join(tmpdir(), "cub-workshop-pull-"));
  oras(["pull", `${repo}@${digest}`, "-o", work], { plain });
  const tarball = readdirSync(work).find((name) => /\.(tar|tar\.gz|tgz)$/.test(name));
  if (!tarball) ociFail(`${reference} has no tarball layer`);
  const out = join(work, "files");
  execFileSync("mkdir", ["-p", out]);
  execFileSync("tar", ["-xf", join(work, tarball), "-C", out]);
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, `${prefix}${entry}/`);
      else files.push({ path: `${prefix}${entry}`, content: readFileSync(full) });
    }
  };
  walk(out, "");
  return { files, dir: out, layerSHA256: sha256(readFileSync(join(work, tarball))) };
}

// Verify: every file the receipt lists is present with the recorded hash, and
// the layer is the one the receipt recorded. Returns findings, never throws.
export function verifyBundle(reference, { key = null } = {}) {
  const found = discoverReceipt(reference);
  if (!found) return { verified: false, findings: [["FAIL", "no receipt is attached to this digest"]] };
  const { receipt, receiptDigest } = found;
  const pulled = pullBundle(reference);
  const findings = [];
  let ok = true;
  const byPath = new Map(pulled.files.map((file) => [file.path, file.content]));
  for (const file of receipt.spec?.bundle?.files ?? []) {
    const content = byPath.get(file.path) ?? byPath.get(file.path.split("/").pop());
    if (!content) { ok = false; findings.push(["FAIL", `${file.path} is listed in the receipt but missing from the bundle`]); continue; }
    if (sha256(content) !== file.sha256) { ok = false; findings.push(["FAIL", `${file.path} does not match its recorded hash`]); }
  }
  if (receipt.spec?.bundle?.layerSHA256 && receipt.spec.bundle.layerSHA256 !== pulled.layerSHA256) {
    ok = false; findings.push(["FAIL", "the layer bytes differ from what the receipt recorded"]);
  }
  if (ok) findings.push(["PASS", `${(receipt.spec?.bundle?.files ?? []).length} file(s) match the attached receipt (${receiptDigest.slice(0, 19)})`]);
  if (key) {
    const { digest } = parseReference(reference);
    const signed = verifySignature({ reference, digest, key });
    if (!signed) ok = false;
    findings.push([signed ? "PASS" : "FAIL", signed ? "signature verifies against the offered key" : "no signature verifies against the offered key"]);
  } else {
    findings.push(["NOTE", "signature not checked: no key was offered (--key <public key>)"]);
  }
  return { verified: ok, findings, receipt, files: pulled.files };
}

// Copy a manifest by digest into a repository so an index there can reference it.
export function copyIntoRepo(sourceReference, repo, { plain = false } = {}) {
  const source = parseReference(sourceReference);
  if (!source.digest) ociFail(`index entries need digests: ${sourceReference}`);
  const args = ["cp", `${source.repo}@${source.digest}`, `${repo}@${source.digest}`];
  if (source.plain) args.push("--from-plain-http");
  if (plain) args.push("--to-plain-http");
  execFileSync("oras", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return source.digest;
}

// An image index over component digests in one repository, with the stack's
// manifest and verdict attached to the index digest.
export function publishIndex({ reference, digests, record, annotations = {} }) {
  const { repo, tag, plain } = parseReference(reference);
  const target = tag ? `${repo}:${tag}` : `${repo}:latest`;
  const args = ["manifest", "index", "create", target, ...digests];
  for (const [key, value] of Object.entries(annotations)) args.push("--annotation", `${key}=${value}`);
  const created = oras(args, { plain });
  const digest = digestFrom(created);
  const work = mkdtempSync(join(tmpdir(), "cub-workshop-index-"));
  const recordPath = join(work, "stack-record.json");
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  const attached = oras(["attach", `${repo}@${digest}`, "--artifact-type", RECORD_TYPE, `stack-record.json:${RECORD_TYPE}`], { plain, cwd: work });
  return { digest, recordDigest: digestFrom(attached), repo };
}
