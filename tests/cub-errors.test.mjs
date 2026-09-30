import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));

// cub, logged out, answers every call the way a real logged-out cub does:
// the reason, a detail line, and a final line holding only ".".
function loggedOut() {
  const dir = mkdtempSync(join(tmpdir(), 'cub-errors-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'cub'), '#!/bin/sh\necho "Failed: authentication problem. Try logging in (again)." >&2\necho "Detailed message: failed to parse token: token has invalid claims: token is expired" >&2\necho "." >&2\nexit 1\n', { mode: 0o755 });
  const run = (noun, ...args) => spawnSync(process.execPath, [join(root, 'bin', `cub-${noun}`), ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  return { run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a logged-out cub is reported with its reason and the login step, never as "."', () => {
  const cub = loggedOut();
  try {
    for (const [noun, args] of [['fleet', ['age', 'meridian']], ['fleet', ['down', 'meridian']], ['app', ['upload', 'hello-standalone', '--run']], ['stack', ['upload', 'web-tiny', '--run']]]) {
      const result = cub.run(noun, ...args);
      const said = `${result.stdout}\n${result.stderr}`;
      assert.notEqual(result.status, 0, `${noun} ${args.join(' ')} must not succeed`);
      assert.match(said, /cub auth login/, `${noun} ${args.join(' ')} names the login step`);
      assert.doesNotMatch(said, /(Failed|skipped [^\n]*|could not delete [^\n]*): \.\s*$/m, `${noun} ${args.join(' ')} gives a reason`);
    }
  } finally { cub.cleanup(); }
});

test('fleet age does not say Aged when nothing aged', () => {
  const cub = loggedOut();
  try {
    const result = cub.run('fleet', 'age', 'meridian');
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /^Aged/m);
  } finally { cub.cleanup(); }
});
