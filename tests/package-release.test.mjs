import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, rmSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname;
const script = join(repoRoot, "scripts/package-release.mjs");

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }

// The routes the plugin ships for eks-inference bundles that carry
// configuration only, by component, with the SHA-256 each receipt records.
const shippedRoutes = {
  "ack-controllers": "e9cbdfd14d486ab04ba676519e7a11266f26b5825a8e639e86a7f1ef3b818119",
  karpenter: "a72c44bbce5b0fbb0dfc774593b30f01d8affa32087ef5533899e558d6c1065c",
};

// The gpu-node stack resolves three Catalog bundles against receipts shipped
// with the plugin, so the release must carry the manifest and all three.
const gpuNodeFiles = [
  "stacks/gpu-node.yaml",
  "receipts/catalog/nvidia-gpu-operator-v26-3-3-default.yaml",
  "receipts/catalog/nvidia-nvsentinel-v1-25-0-default.yaml",
  "receipts/catalog/nvidia-cluster-readiness-engine-v0-6-0-default.yaml",
];

// The release is git archive of HEAD, so a file ships only when it is tracked
// and not marked export-ignore.
test("the shipped routes are tracked files the release archive keeps", (t) => {
  const paths = Object.keys(shippedRoutes).map((component) => `data/certified-bundles/routes/eks-inference/${component}/crd-ordering.yaml`);
  let tracked;
  try { tracked = git(repoRoot, "ls-files", "--", ...paths).split("\n").filter(Boolean); } catch { return t.skip("not a git checkout, so there are no tracked files to read"); }
  assert.deepEqual(tracked.sort(), paths.sort());
  for (const line of git(repoRoot, "check-attr", "export-ignore", "--", ...paths).split("\n")) assert.match(line, /: export-ignore: unspecified$/);
});

test("the gpu-node stack and its receipts are tracked files the release archive keeps", (t) => {
  let tracked;
  try { tracked = git(repoRoot, "ls-files", "--", ...gpuNodeFiles).split("\n").filter(Boolean); } catch { return t.skip("not a git checkout, so there are no tracked files to read"); }
  assert.deepEqual(tracked.sort(), [...gpuNodeFiles].sort());
  for (const line of git(repoRoot, "check-attr", "export-ignore", "--", ...gpuNodeFiles).split("\n")) assert.match(line, /: export-ignore: unspecified$/);
  // Every receipt the manifest names is one of those files.
  const named = readFileSync(join(repoRoot, gpuNodeFiles[0]), "utf8").match(/^\s+receipt: (\S+)$/gm).map((line) => line.trim().slice("receipt: ".length));
  assert.deepEqual(named.sort(), gpuNodeFiles.slice(1).sort());
});

test("packages committed HEAD reproducibly and refuses overwrite", () => {
  const fixture = mkdtempSync(join(tmpdir(), "cub-workshop-package-"));
  try {
    mkdirSync(join(fixture, "scripts"));
    mkdirSync(join(fixture, "bin"));
    mkdirSync(join(fixture, "catalog"));
    mkdirSync(join(fixture, "plugin-host"));
    cpSync(script, join(fixture, "scripts/package-release.mjs"));
    for (const source of ["go.mod", "go.sum", "main.go"]) {
      cpSync(join(repoRoot, "plugin-host", source), join(fixture, "plugin-host", source));
    }
    cpSync(join(repoRoot, "scripts/find-example.mjs"), join(fixture, "scripts/find-example.mjs"));
    cpSync(join(repoRoot, "catalog/examples.json"), join(fixture, "catalog/examples.json"));
    cpSync(join(repoRoot, "catalog/source.json"), join(fixture, "catalog/source.json"));
    cpSync(join(repoRoot, "cub-plugin.yaml"), join(fixture, "cub-plugin.yaml"));
    // Two receipts name a lifecycle route their bundles do not carry, so the
    // release must carry those routes at the receipts' own paths.
    for (const evidence of ["data", "receipts/eks-inference"]) cpSync(join(repoRoot, evidence), join(fixture, evidence), { recursive: true });
    for (const file of gpuNodeFiles) {
      mkdirSync(join(fixture, file, ".."), { recursive: true });
      cpSync(join(repoRoot, file), join(fixture, file));
    }
    writeFileSync(join(fixture, "cub-plugin.yaml"), readFileSync(join(fixture, "cub-plugin.yaml"), "utf8").replace(/^version:.*$/m, "version: 1.2.3"));
    const sourceInstallManifest = readFileSync(join(fixture, "cub-plugin.yaml"), "utf8");
    for (const [command, entrypoint] of Object.entries({ config: "cub-config", app: "cub-app", stack: "cub-stack", fleet: "cub-fleet" })) {
      assert.match(sourceInstallManifest, new RegExp(`name: ${command}[\\s\\S]*?entrypoint: bin/${entrypoint}`));
    }
    for (const entrypoint of ["cub-config", "cub-app", "cub-stack", "cub-fleet"]) {
      cpSync(join(repoRoot, `bin/${entrypoint}`), join(fixture, `bin/${entrypoint}`));
    }
    writeFileSync(join(fixture, "tracked.txt"), "tracked\n");
    git(fixture, "init", "-q");
    git(fixture, "config", "user.email", "ci@example.invalid");
    git(fixture, "config", "user.name", "CI");
    git(fixture, "add", ".");
    git(fixture, "commit", "-qm", "fixture");
    const commit = git(fixture, "rev-parse", "HEAD");

    writeFileSync(join(fixture, "plugin-host/main.go"), `${readFileSync(join(fixture, "plugin-host/main.go"), "utf8")}\n// dirty worktree edit must not ship\n`);
    writeFileSync(join(fixture, "cub-plugin.yaml"), readFileSync(join(fixture, "cub-plugin.yaml"), "utf8").replace("1.2.3", "9.9.9"));
    writeFileSync(join(fixture, "untracked.txt"), "must not ship\n");
    const out = join(fixture, "release");
    execFileSync(process.execPath, [join(fixture, "scripts/package-release.mjs"), "--out", out], { cwd: fixture });

    const archives = readdirSync(out).filter((name) => name.endsWith(".tar.gz"));
    assert.deepEqual(archives.sort(), [
      "cub-workshop-v1.2.3-darwin-amd64.tar.gz",
      "cub-workshop-v1.2.3-darwin-arm64.tar.gz",
      "cub-workshop-v1.2.3-linux-amd64.tar.gz",
      "cub-workshop-v1.2.3-linux-arm64.tar.gz",
    ]);
    const hashes = archives.map((name) => readFileSync(join(out, name)).toString("base64"));
    assert.equal(new Set(hashes).size, 4, "platform archives must contain different native hosts");
    assert.deepEqual(JSON.parse(readFileSync(join(out, "metadata.json"))), { sourceCommit: commit, version: "1.2.3" });
    const sums = readFileSync(join(out, "SHA256SUMS"), "utf8").trim().split("\n");
    assert.equal(sums.length, 4);
    for (const line of sums) {
      const [expected, filename] = line.split(/\s{2}/);
      assert.equal(createHash("sha256").update(readFileSync(join(out, filename))).digest("hex"), expected);
    }

    const outAgain = join(fixture, "release-again");
    execFileSync(process.execPath, [join(fixture, "scripts/package-release.mjs"), "--out", outAgain], { cwd: fixture });
    for (const filename of [...archives, "SHA256SUMS", "metadata.json"]) {
      assert.deepEqual(readFileSync(join(out, filename)), readFileSync(join(outAgain, filename)), `repeat differs: ${filename}`);
    }

    const osName = platform() === "darwin" ? "darwin" : platform();
    const cpuName = arch() === "x64" ? "amd64" : arch();
    const nativeArchive = `cub-workshop-v1.2.3-${osName}-${cpuName}.tar.gz`;
    assert.ok(archives.includes(nativeArchive), `no archive for ${osName}/${cpuName}`);
    const extracted = join(fixture, "extracted");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", join(out, nativeArchive), "-C", extracted]);
    const root = join(extracted, "cub-workshop-v1.2.3");
    const releaseManifest = readFileSync(join(root, "cub-plugin.yaml"), "utf8");
    assert.match(releaseManifest, /version: 1\.2\.3/);
    assert.doesNotMatch(readFileSync(join(root, "plugin-host/main.go"), "utf8"), /dirty worktree edit must not ship/);
    for (const command of ["config", "app", "stack", "fleet"]) {
      assert.match(releaseManifest, new RegExp(`name: ${command}[\\s\\S]*?entrypoint: bin/cub-workshop[\\s\\S]*?--workshop-command=${command}`));
    }
    assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "tracked\n");
    for (const [component, sha256] of Object.entries(shippedRoutes)) {
      const path = `data/certified-bundles/routes/eks-inference/${component}/crd-ordering.yaml`;
      assert.match(readFileSync(join(root, `receipts/eks-inference/${component}.yaml`), "utf8"), new RegExp(`path: "${path}"\\s+sha256: "${sha256}"`));
      assert.equal(createHash("sha256").update(readFileSync(join(root, path))).digest("hex"), sha256, `${path} is not in the release with its receipt's bytes`);
    }
    for (const file of gpuNodeFiles) assert.deepEqual(readFileSync(join(root, file)), readFileSync(join(repoRoot, file)), `${file} is not in the release as committed`);
    for (const entrypoint of ["cub-config", "cub-app", "cub-stack", "cub-fleet"]) {
      assert.equal(statSync(join(root, `bin/${entrypoint}`)).mode & 0o111, 0o111);
    }
    assert.equal(statSync(join(root, "bin/cub-workshop")).mode & 0o111, 0o111);
    const hookStage = join(fixture, "hook-stage");
    mkdirSync(hookStage);
    cpSync(join(fixture, "cub-plugin.yaml"), join(hookStage, "cub-plugin.yaml"));
    execFileSync(join(root, "bin/cub-workshop"), [], {
      cwd: hookStage,
      env: { ...process.env, CUB_PLUGIN_HOOK: "upgrade", CUB_PLUGIN_DIR: hookStage, CUB_PLUGIN_PREVIOUS_VERSION: "1.2.2" },
    });
    assert.match(readFileSync(join(hookStage, "cub-plugin.yaml"), "utf8"), /--workshop-command=fleet/);
    const exampleResult = JSON.parse(execFileSync(process.execPath, [join(root, "bin/cub-config"), "examples", "what an app looks like", "--json"], { encoding: "utf8" }));
    assert.ok(exampleResult.entries.some((entry) => entry.id === "first-app-realistic"));
    const hostResult = JSON.parse(execFileSync(join(root, "bin/cub-workshop"), ["--workshop-command=config", "examples", "what an app looks like", "--json"], { encoding: "utf8" }));
    assert.ok(hostResult.entries.some((entry) => entry.id === "first-app-realistic"));
    assert.equal(readdirSync(root).includes("untracked.txt"), false);
    assert.throws(() => execFileSync(process.execPath, [script, "--out", out], { cwd: fixture }), /refusing to overwrite/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
