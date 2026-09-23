import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const repoRoot = new URL("..", import.meta.url).pathname;
const script = join(repoRoot, "scripts/package-release.mjs");

function git(cwd, ...args) { return execFileSync("git", args, { cwd, encoding: "utf8" }).trim(); }

test("packages committed HEAD reproducibly and refuses overwrite", () => {
  const fixture = mkdtempSync(join(tmpdir(), "cub-workshop-package-"));
  try {
    mkdirSync(join(fixture, "scripts"));
    mkdirSync(join(fixture, "bin"));
    cpSync(script, join(fixture, "scripts/package-release.mjs"));
    cpSync(join(repoRoot, "cub-plugin.yaml"), join(fixture, "cub-plugin.yaml"));
    writeFileSync(join(fixture, "cub-plugin.yaml"), readFileSync(join(fixture, "cub-plugin.yaml"), "utf8").replace(/^version:.*$/m, "version: 1.2.3"));
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
    assert.equal(new Set(hashes).size, 1, "platform archives must contain identical bytes");
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

    const extracted = join(fixture, "extracted");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", join(out, archives[0]), "-C", extracted]);
    const root = join(extracted, "cub-workshop-v1.2.3");
    assert.equal(readFileSync(join(root, "cub-plugin.yaml"), "utf8").includes("version: 1.2.3"), true);
    assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "tracked\n");
    for (const entrypoint of ["cub-config", "cub-app", "cub-stack", "cub-fleet"]) {
      assert.equal(statSync(join(root, `bin/${entrypoint}`)).mode & 0o111, 0o111);
    }
    assert.equal(readdirSync(root).includes("untracked.txt"), false);
    assert.throws(() => execFileSync(process.execPath, [script, "--out", out], { cwd: fixture }), /refusing to overwrite/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
