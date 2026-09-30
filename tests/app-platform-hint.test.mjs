import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const check = (app) => spawnSync(process.execPath, [join(root, 'bin', 'cub-app'), 'check', app], { encoding: 'utf8' });

// app check points at a shipped stack that already places the app and checks out,
// never at a demonstration built to be refused.
test('app check suggests a shipped platform that places the app', () => {
  const shop = check('shop-web');
  assert.equal(shop.status, 0, shop.stderr);
  assert.match(shop.stdout, /cub stack sandbox shop-platform\n/);
  assert.doesNotMatch(shop.stdout, /kubara-shop-first-try/);
  const kubara = check('shop-web-kubara');
  assert.match(kubara.stdout, /cub stack sandbox kubara-shop-platform/);
  assert.doesNotMatch(kubara.stdout, /web-platform/);
});
