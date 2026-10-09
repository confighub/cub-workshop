import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const CONFIG = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shipped-route-fixture\n';
const ROUTE = 'apiVersion: evidence.confighub.com/v1alpha1\nkind: BundleRoute\nmetadata:\n  name: fixture-crd-ordering\n';
const ROUTE_PATH = 'data/certified-bundles/routes/fixture/widgets/crd-ordering.yaml';
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const place = (directory, path, contents) => { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), contents); };

// A private copy of the plugin's code is the plugin root in these tests, so
// each one decides what that plugin ships. The bundle is a local directory
// which a fake oras packs into a tarball, so nothing reaches a registry. The
// receipt names one configuration file and one route, the route by a path the
// bundle may or may not carry.
function fixture({ bundle = () => {}, plugin: ship = () => {}, files } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'shipped-route-'));
  const plugin = join(dir, 'plugin'); mkdirSync(plugin);
  for (const entry of ['lib', 'bin', 'schemas', 'cub-plugin.yaml']) cpSync(join(root, entry), join(plugin, entry), { recursive: true });
  const source = join(dir, 'bundle'); mkdirSync(source);
  writeFileSync(join(source, 'config.yaml'), CONFIG);
  bundle(source, dir);
  ship(plugin, dir);
  const digest = hash(dir);
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ spec: { bundle: { manifestDigest: `sha256:${digest}`, files: files ?? [
    { path: 'config.yaml', sha256: hash(CONFIG), role: 'rendered object set' },
    { path: ROUTE_PATH, sha256: hash(ROUTE), role: 'route: crd-ordering' },
  ] } } }));
  const manifest = join(dir, 'stack.yaml');
  writeFileSync(manifest, `apiVersion: helm-expt.confighub.com/v1alpha1\nkind: Stack\nmetadata:\n  name: shipped-route\nspec:\n  components:\n    - name: widgets\n      bundle: oci://registry.test/widgets@sha256:${digest}\n      receipt: receipt.json\n`);
  const fakeBin = join(dir, 'bin'); mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'oras'), '#!/bin/sh\nset -eu\n[ "$1" = pull ]\nout=""\nfor arg in "$@"; do if [ "${previous-}" = -o ]; then out="$arg"; fi; previous="$arg"; done\necho pull >> "$FAKE_ORAS_LOG"\nmkdir -p "$out"\ntar -cf "$out/bundle.tar" -C "$FAKE_BUNDLE_SOURCE" .\n');
  chmodSync(join(fakeBin, 'oras'), 0o755);
  const log = join(dir, 'pulls.log');
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, FAKE_BUNDLE_SOURCE: source, FAKE_ORAS_LOG: log, TMPDIR: dir };
  const run = (...args) => spawnSync(process.execPath, [join(plugin, 'bin/cub-stack'), ...args], { encoding: 'utf8', timeout: 30000, env });
  return { dir, plugin, manifest, digest, run,
    pulls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0),
    cacheEntry: () => readdirSync(join(dir, 'cub-stack-bundles', digest)).sort(),
    save: (name) => { const workspace = join(dir, name); return { workspace, result: run('sandbox', manifest, '--workspace', workspace) }; },
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const companionsOf = (workspace) => JSON.parse(readFileSync(join(workspace, 'result.json'))).lifecycleCompanions.entries.find((entry) => entry.component === 'widgets');

// Every refusal below must leave no workspace and must name the route.
function refused(f, reason) {
  const { workspace, result } = f.save('refused');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`component "widgets" pulled files do not match its receipt: ${escaped(ROUTE_PATH)} ${reason}$`, 'm'));
  assert.equal(existsSync(workspace), false);
  return result;
}

test('a route the bundle lacks is taken from the plugin, verified, and saved as evidence', () => {
  const f = fixture({ plugin: (plugin) => place(plugin, ROUTE_PATH, ROUTE) });
  try {
    const { workspace, result } = f.save('saved');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Saved 1 receipt-bound lifecycle route file\(s\) as declared-unexecuted evidence/);
    const evidence = companionsOf(workspace);
    assert.equal(evidence.state, 'declared-unexecuted');
    assert.deepEqual(evidence.companions, [{ path: 'evidence/01-widgets/companions/01-crd-ordering.yaml', source: ROUTE_PATH,
      role: 'route: crd-ordering', sha256: hash(ROUTE), suppliedBy: 'plugin', state: 'declared-unexecuted' }]);
    assert.equal(readFileSync(join(workspace, evidence.companions[0].path), 'utf8'), ROUTE);
    assert.deepEqual(JSON.parse(readFileSync(join(workspace, evidence.metadataPath))).companions, evidence.companions);
    // The route is evidence, never a Kubernetes object in the render.
    assert.doesNotMatch(readFileSync(join(workspace, 'rendered.yaml'), 'utf8'), /BundleRoute/);

    // The cached bundle has no route and never will. It still verifies, so it
    // is neither pulled again nor replaced as stale.
    assert.deepEqual(f.cacheEntry(), ['.ok', 'config.yaml']);
    const again = f.save('saved-again');
    assert.equal(again.result.status, 0, again.result.stderr);
    assert.doesNotMatch(again.result.stderr, /replacing it with a fresh pull/);
    assert.equal(f.pulls(), 1);
    assert.deepEqual(f.cacheEntry(), ['.ok', 'config.yaml']);

    // The saved workspace checks on its own and carries the route, with where
    // it came from, into a workspace saved from it.
    assert.equal(f.run('check', join(workspace, 'stack.yaml')).status, 0);
    const resaved = join(f.dir, 'resaved');
    const resave = f.run('sandbox', join(workspace, 'stack.yaml'), '--workspace', resaved);
    assert.equal(resave.status, 0, resave.stderr);
    assert.deepEqual(companionsOf(resaved).companions, evidence.companions);
    assert.equal(f.pulls(), 1);

    // A saved supplier this plugin does not know is malformed evidence.
    const saved = JSON.parse(readFileSync(join(workspace, 'result.json')));
    saved.lifecycleCompanions.entries[0].companions[0].suppliedBy = 'somewhere else';
    writeFileSync(join(workspace, 'result.json'), JSON.stringify(saved, null, 2));
    const malformed = f.run('sandbox', join(workspace, 'stack.yaml'), '--workspace', join(f.dir, 'malformed'));
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /workspace lifecycle evidence is malformed for widgets companion 1/);
  } finally { f.cleanup(); }
});

test('a bundle cached without its route serves a later workspace once the plugin ships the route', () => {
  const f = fixture({ plugin: (plugin) => place(plugin, ROUTE_PATH, ROUTE) });
  try {
    const plain = f.run('sandbox', f.manifest, '--out', join(f.dir, 'plain.yaml'));
    assert.equal(plain.status, 0, plain.stderr);
    assert.deepEqual(f.cacheEntry(), ['.ok', 'config.yaml']);
    const { workspace, result } = f.save('saved');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(companionsOf(workspace).companions[0].suppliedBy, 'plugin');
    assert.equal(f.pulls(), 1);
  } finally { f.cleanup(); }
});

test('a route the bundle carries is taken from the bundle, whatever the plugin ships', () => {
  for (const ship of [() => {}, (plugin) => place(plugin, ROUTE_PATH, ROUTE), (plugin) => place(plugin, ROUTE_PATH, 'a different shipped copy\n')]) {
    const f = fixture({ bundle: (source) => place(source, 'routes/crd-ordering.yaml', ROUTE), plugin: ship });
    try {
      const { workspace, result } = f.save('saved');
      assert.equal(result.status, 0, result.stderr);
      const [companion] = companionsOf(workspace).companions;
      assert.equal(companion.suppliedBy, 'bundle');
      assert.equal(hash(readFileSync(join(workspace, companion.path))), hash(ROUTE));
    } finally { f.cleanup(); }
  }
});

test('a shipped route whose bytes differ from the receipt is refused', () => {
  const changed = 'a changed shipped copy\n';
  const f = fixture({ plugin: (plugin) => place(plugin, ROUTE_PATH, changed) });
  try {
    assert.equal(f.run('sandbox', f.manifest, '--out', join(f.dir, 'plain.yaml')).status, 0);
    const result = refused(f, `is missing from the pulled bundle, and the plugin's copy has sha256 ${hash(changed).slice(0, 12)}, the receipt records ${hash(ROUTE).slice(0, 12)}`);
    // The bundle's cache entry is sound; the plugin's copy is at fault, so
    // the entry is kept.
    assert.doesNotMatch(result.stderr, /replacing it with a fresh pull/);
    assert.deepEqual(f.cacheEntry(), ['.ok', 'config.yaml']);
  } finally { f.cleanup(); }
});

test('a wrong route in the bundle is refused even when the plugin ships a good copy', () => {
  const wrong = 'a corrupted bundle route\n';
  const reason = `has sha256 ${hash(wrong).slice(0, 12)}, the receipt records ${hash(ROUTE).slice(0, 12)}`;
  // Each name the bundle may give the route: the receipt path, the basename,
  // and routes/<basename>.
  for (const name of [ROUTE_PATH, 'crd-ordering.yaml', 'routes/crd-ordering.yaml']) {
    const f = fixture({ bundle: (source) => place(source, name, wrong), plugin: (plugin) => place(plugin, ROUTE_PATH, ROUTE) });
    try { refused(f, reason); } finally { f.cleanup(); }
  }
  // A link to nothing at one of those names is still the bundle's answer.
  const f = fixture({ bundle: (source) => symlinkSync('nowhere', join(source, 'crd-ordering.yaml')), plugin: (plugin) => place(plugin, ROUTE_PATH, ROUTE) });
  try { refused(f, 'could not be read from the pulled bundle'); } finally { f.cleanup(); }
});

test('a route absent from both the bundle and the plugin is refused by name', () => {
  const f = fixture();
  try { refused(f, 'is missing from the pulled bundle, and the plugin ships no copy of it'); } finally { f.cleanup(); }
});

test('a shipped route that is not a regular file inside the plugin is refused', () => {
  const cases = [
    // A link out of the plugin to a file with exactly the receipt's bytes.
    [(plugin, dir) => { writeFileSync(join(dir, 'outside.yaml'), ROUTE); mkdirSync(dirname(join(plugin, ROUTE_PATH)), { recursive: true }); symlinkSync(join(dir, 'outside.yaml'), join(plugin, ROUTE_PATH)); },
      "is missing from the pulled bundle, and the plugin's copy resolves outside the plugin"],
    // The same escape through a linked parent directory.
    [(plugin, dir) => { place(join(dir, 'elsewhere'), ROUTE_PATH.replace(/^data\//, ''), ROUTE); symlinkSync(join(dir, 'elsewhere'), join(plugin, 'data')); },
      "is missing from the pulled bundle, and the plugin's copy resolves outside the plugin"],
    [(plugin) => mkdirSync(join(plugin, ROUTE_PATH), { recursive: true }),
      "is missing from the pulled bundle, and the plugin's copy is not a regular file"],
    [(plugin) => { mkdirSync(dirname(join(plugin, ROUTE_PATH)), { recursive: true }); symlinkSync('nowhere', join(plugin, ROUTE_PATH)); },
      "is missing from the pulled bundle, and the plugin's copy could not be read"],
  ];
  for (const [ship, reason] of cases) {
    const f = fixture({ plugin: ship });
    try { refused(f, reason); } finally { f.cleanup(); }
  }
});

test('configuration is never taken from the plugin', () => {
  const extra = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: only-in-the-plugin\n';
  const f = fixture({
    plugin: (plugin) => { place(plugin, 'extra.yaml', extra); place(plugin, ROUTE_PATH, ROUTE); },
    files: [
      { path: 'config.yaml', sha256: hash(CONFIG), role: 'rendered object set' },
      { path: 'extra.yaml', sha256: hash(extra) },
      { path: ROUTE_PATH, sha256: hash(ROUTE), role: 'route: crd-ordering' },
    ],
  });
  try {
    for (const args of [['--out', join(f.dir, 'plain.yaml')], ['--workspace', join(f.dir, 'saved')]]) {
      const result = f.run('sandbox', f.manifest, ...args);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /pulled files do not match its receipt: extra\.yaml is missing from the pulled bundle$/m);
      assert.equal(existsSync(args[1]), false);
    }
  } finally { f.cleanup(); }
});

// The two eks-inference receipts name a route their published bundles do not
// carry. The plugin must ship exactly those bytes at exactly those paths, and
// ship nothing under data/ that no receipt names.
test('the plugin ships each route its eks-inference receipts name by repository path', async () => {
  const { readYamlFile } = await import('../lib/common.mjs');
  const walk = (directory) => readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]));
  const routes = (receipt) => (readYamlFile(join(root, receipt)).spec?.bundle?.files ?? []).filter((entry) => String(entry.role ?? '').startsWith('route:'));
  const needed = walk('receipts/eks-inference').flatMap(routes);
  assert.deepEqual(needed.map((file) => file.path).sort(), ['data/certified-bundles/routes/eks-inference/ack-controllers/crd-ordering.yaml', 'data/certified-bundles/routes/eks-inference/karpenter/crd-ordering.yaml']);
  for (const file of needed) {
    const bytes = readFileSync(join(root, file.path));
    assert.equal(hash(bytes), file.sha256, `${file.path} does not match its receipt`);
    assert.equal(bytes.length, file.bytes);
  }
  const named = new Map(walk('receipts').flatMap(routes).map((file) => [file.path, file.sha256]));
  for (const path of walk('data')) assert.equal(hash(readFileSync(join(root, path))), named.get(path), `${path} is not a route a shipped receipt names with these bytes`);
});
