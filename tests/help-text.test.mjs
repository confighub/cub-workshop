import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");

// One row per noun: the files whose dispatch names its verbs, and any verb the
// dispatch reaches without a literal `verb === "x"` (a Set lookup).
const NOUNS = [
  { noun: "config", files: ["bin/cub-config", "lib/config.mjs"], extra: [] },
  { noun: "app", files: ["bin/cub-app", "lib/app.mjs"], extra: [] },
  { noun: "stack", files: ["bin/cub-stack", "lib/stack.mjs"], extra: ["check"] },
  { noun: "fleet", files: ["bin/cub-fleet", "lib/fleet.mjs"], extra: [] },
];

const dispatchVerbs = ({ files, extra }) => {
  const verbs = new Set(extra);
  for (const file of files) {
    for (const match of read(file).matchAll(/(?:\bverb|\bargv\[2\]|\brequestedVerb) === "([a-z][a-z-]*)"/g)) verbs.add(match[1]);
  }
  return [...verbs].sort();
};

const run = (noun, ...args) => spawnSync(process.execPath, [join(root, "bin", `cub-${noun}`), ...args], { encoding: "utf8" });

const summaries = new Map();
for (const block of read("cub-plugin.yaml").split(/^\s*- name: /m).slice(1)) {
  summaries.set(block.split("\n")[0].trim(), /summary: '?([^\n]*?)'?\s*$/m.exec(block)?.[1] ?? "");
}

for (const row of NOUNS) {
  test(`cub ${row.noun}: --help and the bare command print one usage that names every verb`, () => {
    const verbs = dispatchVerbs(row);
    assert.ok(verbs.length >= 4, `expected the dispatch of cub ${row.noun} to name its verbs, found ${verbs.join(", ") || "none"}`);
    const help = run(row.noun, "--help");
    const bare = run(row.noun);
    // Asking for help is not an error, bare or with a verb.
    assert.equal(bare.status, 0, bare.stderr);
    assert.equal(help.status, 0, `cub ${row.noun} --help exits ${help.status}`);
    assert.equal(run(row.noun, "check", "--help").status, 0, `cub ${row.noun} check --help`);
    assert.equal(help.stdout, bare.stdout, `cub ${row.noun} --help and the bare command diverge`);
    for (const verb of verbs) {
      assert.match(help.stdout, new RegExp(`cub ${row.noun} ${verb}\\b`), `usage of cub ${row.noun} omits ${verb}`);
    }
    assert.ok(!help.stdout.includes("key.pem"), "the --sign placeholder is cosign.key everywhere");
  });

  test(`cub ${row.noun}: the plugin summary names every verb`, () => {
    const summary = summaries.get(row.noun);
    assert.ok(summary, `cub-plugin.yaml lists no command ${row.noun}`);
    for (const verb of dispatchVerbs(row).filter((verb) => verb !== "certify")) {
      assert.match(summary, new RegExp(`\\b${verb}\\b`), `cub-plugin.yaml summary of ${row.noun} omits ${verb}: ${summary}`);
    }
  });
}
