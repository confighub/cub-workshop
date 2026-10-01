import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The first names this repository keeps out of committed files, a home
// directory path included. Write "the team", "a colleague" or the issue number.
const PATTERN = 'alexis|jesper|brian|charlie';
const SELF = 'tests/no-personal-names.test.mjs';

// -w matches a whole word, so a longer identifier that merely contains a name
// (a GitHub handle, say) is not a hit. This file holds the pattern, so it is
// the one file left out.
test('no tracked file names a person', (t) => {
  const result = spawnSync('git', ['grep', '-nwiE', PATTERN, '--', '.', `:(exclude)${SELF}`], { cwd: root, encoding: 'utf8' });
  if (result.error || result.status > 1) return t.skip('not a git checkout, so there are no tracked files to read');
  assert.equal(result.stdout.trim(), '', `these lines name a person; replace each name with neutral wording:\n${result.stdout}`);
});
