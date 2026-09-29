import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFleet, noSpaces, root } from './fleet-fake-cub.mjs';

// A published stack: the index digest, the record attached to it, and the
// component digests the record pins, all in one repository.
const repo = 'registry.example.test/stacks/shop';
const indexDigest = `sha256:${'1'.repeat(64)}`;
const recordDigest = `sha256:${'2'.repeat(64)}`;
const names = ['cert-manager', 'traefik', 'metrics-server', 'external-secrets', 'shop-web'];
const componentDigest = (index) => `sha256:${String(index + 3).repeat(64)}`;
const record = {
  apiVersion: 'evidence.confighub.com/v1alpha1',
  kind: 'StackIndexRecord',
  metadata: { name: 'kubara-shop-platform' },
  spec: {
    manifest: readFileSync(join(root, 'stacks/kubara-shop-platform.yaml'), 'utf8'),
    verdict: 'CHECKED',
    components: names.map((name, index) => ({ name, form: name === 'shop-web' ? 'authored' : 'bundle', digest: componentDigest(index) })),
  },
};

// A fake oras that answers the two calls reading a stack record makes:
// discover lists the record attached to the index digest, and pull writes it
// into the directory it is given. Anything else is refused, so a test notices
// a pull of a bundle the fleet should have left to the server.
const FAKE_ORAS = `
const fs=require('node:fs'); const path=require('node:path'); const args=process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_TOOL_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='discover' && args[1]===${JSON.stringify(`${repo}@${indexDigest}`)}) { console.log(JSON.stringify({manifests:[{digest:${JSON.stringify(recordDigest)}}]})); process.exit(0); }
if(args[0]==='pull' && args[1]===${JSON.stringify(`${repo}@${recordDigest}`)}) { fs.writeFileSync(path.join(args[args.indexOf('-o')+1],'stack-record.json'),process.env.FAKE_RECORD); process.exit(0); }
console.error('Error: unexpected oras call '+args.join(' ')); process.exit(1);
`;

const fleet = (stack) => JSON.stringify({
  metadata: { name: 'indexed' },
  spec: {
    clusters: [{ name: 'east' }, { name: 'west' }],
    placements: [{ stack, team: 'platform-team', clusters: ['*'] }],
  },
});
const run = (verb, stack = `oci://${repo}@${indexDigest}`) => runFleet([verb, '{dir}/fleet.yaml'], {
  files: { 'fleet.yaml': fleet(stack) },
  tools: { oras: FAKE_ORAS },
  env: { FAKE_RECORD: JSON.stringify(record) },
  rules: [noSpaces],
});

test('fleet plan expands a stack placed by its index digest into its pinned components', () => {
  const { result, calls } = run('plan');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 clusters, 5 placements after expanding stacks/);
  names.forEach((name, index) => {
    assert.match(result.stdout, new RegExp(`${name}\\s+2 cluster\\(s\\)\\s+image @${componentDigest(index).slice(0, 19)}`));
  });
  assert.equal(calls.length, 0, 'plan never reaches ConfigHub');
});

test('fleet up uploads each component of an indexed stack from its bundle digest', () => {
  const { result, calls } = run('up');
  assert.equal(result.status, 0, result.stderr);
  const uploads = calls.filter((args) => args[0] === 'variant' && args[1] === 'upload');
  assert.deepEqual(uploads, names.map((name, index) => [
    'variant', 'upload', '--component', name, '--variant', 'base', '--owner', 'platform-team', `oci://${repo}@${componentDigest(index)}`,
  ]));
  const creates = calls.filter((args) => args[0] === 'variant' && args[1] === 'create');
  assert.equal(creates.length, 10);
  assert.deepEqual(creates[0], ['variant', 'create', 'east', 'cert-manager-base', '--target', 'east/target']);
  assert.deepEqual(calls.filter((args) => args[0] === 'release').length, 10);
});

test('the index is read through its attached record, and no bundle is pulled locally', () => {
  const { result, toolCalls } = run('up');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(toolCalls.map((args) => args.slice(0, 2)), [['discover', `${repo}@${indexDigest}`], ['pull', `${repo}@${recordDigest}`]]);
  assert.deepEqual(toolCalls[0].slice(2), ['--artifact-type', 'application/vnd.confighub.record.v1+json', '--format', 'json']);
});

test('a tag-only or unpinned stack reference is refused before anything is read', () => {
  for (const stack of [`oci://${repo}:v1`, `oci://${repo}`, `oci://${repo}@sha256:abc`]) {
    const { result, calls } = run('plan', stack);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /is not pinned by digest; a fleet places a published stack by its index digest only, oci:\/\/<repo>@sha256:<digest>/);
    assert.equal(calls.length, 0);
  }
});

test('a record that lacks a component digest is refused', () => {
  const partial = structuredClone(record); partial.spec.components.pop();
  const { result } = runFleet(['plan', '{dir}/fleet.yaml'], {
    files: { 'fleet.yaml': fleet(`oci://${repo}@${indexDigest}`) },
    tools: { oras: FAKE_ORAS },
    env: { FAKE_RECORD: JSON.stringify(partial) },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /index record has no digest for component "shop-web"/);
});
