// A fake cub on PATH for the from-kubara tests, in the manner of
// tests/fleet-fake-cub.mjs: every call is logged as a JSON array of its argv.
// `cub kubara version` prints FAKE_KUBARA_VERSION (default 0.2.3), or answers
// as cub does without the plugin when it is "missing". `cub kubara render`
// writes the golden render in FAKE_KUBARA_RENDER into --out, narrowed by each
// --cluster, as `cub kubara render` from confighub/kubara-confighub does. Any
// `get` answers not found, as a fresh organization would; any other call
// succeeds with no output. Nothing here reaches a server.
//
// tests/fixtures/kubara-render is examples/cub-kubara/render-two-clusters and
// tests/fixtures/kubara-platform is internal/render/testdata/platform, the work
// directory it was rendered from, both from confighub/kubara-confighub at
// 96ba393.
//
// Run it to put the fake on a PATH for a shell: node tests/kubara-fake-cub.mjs <bin-dir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const goldenRender = join(root, 'tests', 'fixtures', 'kubara-render');
export const goldenPlatform = join(root, 'tests', 'fixtures', 'kubara-platform');

const FAKE_CUB = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.FAKE_CUB_LOG) fs.appendFileSync(process.env.FAKE_CUB_LOG, JSON.stringify(args) + '\\n');
const version = process.env.FAKE_KUBARA_VERSION || '0.2.3';
if (args[0] === 'kubara') {
  if (version === 'missing') { process.stderr.write('Failed: unknown command "kubara" for "cub"\\n'); process.exit(1); }
  if (args[1] === 'version') { console.log('cub kubara ' + version + ' (commit fake, built -)'); process.exit(0); }
  if (args[1] !== 'render' || version === 'no-render') { process.stderr.write('error: unknown command "' + args[1] + '" for "kubara"\\n'); process.exit(1); }
  if (process.env.FAKE_KUBARA_RENDER_ERROR) { process.stderr.write(process.env.FAKE_KUBARA_RENDER_ERROR + '\\n'); process.exit(1); }
  const golden = process.env.FAKE_KUBARA_RENDER || ${JSON.stringify(goldenRender)};
  const out = args[args.indexOf('--out') + 1];
  const wanted = args.flatMap((arg, index) => arg === '--cluster' ? [args[index + 1]] : []);
  const render = JSON.parse(fs.readFileSync(path.join(golden, 'render.json'), 'utf8'));
  render.source.workDir = args[2];
  render.clusters = render.clusters.filter((cluster) => !wanted.length || wanted.includes(cluster.name));
  fs.rmSync(out, { recursive: true, force: true });
  for (const cluster of render.clusters) for (const service of cluster.services) {
    fs.mkdirSync(path.dirname(path.join(out, service.file)), { recursive: true });
    fs.copyFileSync(path.join(golden, service.file), path.join(out, service.file));
  }
  const text = JSON.stringify(render, null, 2) + '\\n';
  fs.writeFileSync(path.join(out, 'render.json'), text);
  if (args.includes('--json')) process.stdout.write(text);
  process.exit(0);
}
if (args[1] === 'get') { process.stderr.write('Failed: ' + args[0] + ' ' + args[2] + ' not found\\n'); process.exit(1); }
`;

export function installFakeCub(bin) {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'cub'), FAKE_CUB, { mode: 0o755 });
  return bin;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) { console.error('usage: node tests/kubara-fake-cub.mjs <bin-dir>'); process.exit(2); }
  console.log(installFakeCub(resolve(process.argv[2])));
}
