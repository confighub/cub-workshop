import test from 'node:test';
import assert from 'node:assert/strict';
import { runFleet, missing, noSpaces } from './fleet-fake-cub.mjs';

// Two clusters, one authored app on both, and one of each aging operation.
const manifest = JSON.stringify({
  metadata: { name: 'tiny' },
  spec: {
    owner: 'Tiny Team',
    clusters: [{ name: 'c1' }, { name: 'c2' }],
    placements: [{ app: 'cart', team: 'retail', authored: 'apps/cart.yaml', clusters: ['*'] }],
    demoAging: [
      { kind: 'pending', space: 'cart-c1', where: "Slug LIKE '%deployment%'", annotation: 'tiny.example/reviewed=pending' },
      { kind: 'advance-base', component: 'cart', where: "Slug = 'upstream'", annotation: 'tiny.example/base-rev=2' },
      { kind: 'gate', space: 'cart-c2' },
      { kind: 'changeorder', component: 'cart', name: 'cart-wave', scope: ['cart-c1', 'cart-c2'] },
    ],
  },
});
const files = { 'fleet.yaml': manifest };
const verbs = (calls) => calls.map((args) => args.slice(0, 2).join(' '));

test('fleet down deletes only what up creates, ChangeOrders first, and never an argo-apps Space', () => {
  const { result, calls } = runFleet(['down', '{dir}/fleet.yaml'], { files, rules: [{ when: '^space list', out: 'cart-base\n' }] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [
    ['changeorder', 'delete', 'cart-wave', '--space', 'cart-base'],
    ['space', 'delete', 'cart-c1', '--recursive'],
    ['space', 'delete', 'cart-c2', '--recursive'],
    ['space', 'delete', 'c1', '--recursive'],
    ['space', 'delete', 'c2', '--recursive'],
    ['space', 'list', '--where', "Labels.Component = 'cart'", '-o', 'name'],
    ['space', 'delete', 'cart-base', '--recursive'],
  ]);
  assert.ok(!calls.some((args) => args.join(' ').includes('argo-apps')));
  assert.match(result.stdout, /teardown complete: 5 space\(s\) removed, 1 changeorder\(s\) closed/);
});

test('fleet down reads an explicit not-found as already gone', () => {
  const { result } = runFleet(['down', '{dir}/fleet.yaml'], { files, rules: [
    { when: '^changeorder delete', ...missing('space cart-base') },
    { when: '^space delete c2 ', ...missing('space c2') },
    { when: '^space delete cart-c1 ', ...missing('space cart-c1') },
    { when: '^space list', out: 'cart-base\n' },
  ] });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /teardown complete: 3 space\(s\) removed$/m);
});

test('fleet down stops on any other failure, names it, and never claims completion', () => {
  const { result, calls } = runFleet(['down', '{dir}/fleet.yaml'], { files, rules: [
    { when: '^space delete cart-c2 ', err: 'Failed: space cart-c2 is referenced by changeorder elsewhere\n', code: 1 },
  ] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not delete space cart-c2: Failed: space cart-c2 is referenced/);
  assert.match(result.stderr, /Removed 1 space\(s\) and 1 changeorder\(s\) before stopping.*re-run cub fleet down tiny/);
  assert.doesNotMatch(result.stdout, /teardown complete/);
  assert.equal(calls.at(-1).join(' '), 'space delete cart-c2 --recursive');
});

test('fleet down stops when an authentication failure hides whether a ChangeOrder exists', () => {
  const { result, calls } = runFleet(['down', '{dir}/fleet.yaml'], { files, rules: [
    { when: '^changeorder delete', err: 'Failed: authentication problem. Try logging in (again).\n', code: 1 },
  ] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not delete changeorder cart-wave in cart-base: Failed: authentication problem/);
  assert.equal(calls.length, 1);
});

test('fleet down keeps a base another variant still uses', () => {
  const { result, calls } = runFleet(['down', '{dir}/fleet.yaml'], { files, rules: [{ when: '^space list', out: 'cart-base\ncart-elsewhere\n' }] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!calls.some((args) => args.join(' ') === 'space delete cart-base --recursive'));
  assert.match(result.stdout, /kept cart-base: 1 other variant\(s\) still use it/);
  assert.match(result.stdout, /4 space\(s\) removed, 1 shared base\(s\) kept, 1 changeorder\(s\) closed/);
});

test('fleet up labels cluster Spaces with the manifest owner', () => {
  const { result, calls } = runFleet(['up', '{dir}/fleet.yaml'], { files, rules: [noSpaces] });
  assert.equal(result.status, 0, result.stderr);
  const creates = calls.filter((args) => args[0] === 'space' && args[1] === 'create');
  assert.deepEqual(creates, [['space', 'create', 'c1', '--label', 'Owner=Tiny Team'], ['space', 'create', 'c2', '--label', 'Owner=Tiny Team']]);
});

test('a fleet without an owner labels its cluster Spaces with its own name', () => {
  const unowned = JSON.parse(manifest); delete unowned.spec.owner;
  const { result, calls } = runFleet(['up', '{dir}/fleet.yaml'], { files: { 'fleet.yaml': JSON.stringify(unowned) }, rules: [noSpaces] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.find((args) => args[1] === 'create'), ['space', 'create', 'c1', '--label', 'Owner=tiny']);
});

test('fleet list counts a stack placement by the components it expands to', () => {
  const { result } = runFleet(['list']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /demo-platform[\s\S]*?2 cluster\(s\), 6 component\(s\)/);
  assert.match(result.stdout, /meridian[\s\S]*?10 cluster\(s\), 20 component\(s\)/);
});

test('fleet age issues the cub calls each aging operation names', () => {
  const { result, calls } = runFleet(['age', '{dir}/fleet.yaml'], { files, rules: [
    { when: '^space get cart-c2 -o json', out: JSON.stringify({ Space: { SpaceID: 'space-id-c2' } }) },
    { when: '^changeorder list', out: '' },
  ] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(verbs(calls), [
    'function do', 'function do',
    'trigger create', 'space get', 'space update',
    'changeorder list', 'changeorder create', 'function do',
  ]);
  assert.deepEqual(calls[0].slice(0, 6), ['function', 'do', '--space', 'cart-c1', '--where', "Slug LIKE '%deployment%'"]);
  assert.deepEqual(calls[1].slice(0, 4), ['function', 'do', '--space', 'cart-base']);
  assert.deepEqual(calls[4], ['space', 'update', '--patch', 'cart-c2', '--where-trigger', "SpaceID='space-id-c2'", '--refresh-triggers']);
  assert.deepEqual(calls[6].slice(0, 6), ['changeorder', 'create', 'cart-wave', '--space', 'cart-base', '--in-scope-space']);
  assert.equal(calls[6][6], 'cart-c1,cart-c2');
  assert.match(result.stdout, /changeorder opened: cart-wave \(2 spaces in scope\)/);
});

test('fleet age leaves an open ChangeOrder alone', () => {
  const { calls, result } = runFleet(['age', '{dir}/fleet.yaml'], { files, rules: [{ when: '^changeorder list', out: 'cart-wave\n' }, { when: '^space get', out: '{"Space":{"SpaceID":"x"}}' }] });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!calls.some((args) => args[0] === 'changeorder' && args[1] === 'create'));
  assert.match(result.stdout, /changeorder already open: cart-wave/);
});

test('fleet status recomputes the tiles from fleet queries', () => {
  const { result, calls } = runFleet(['status', '{dir}/fleet.yaml'], { files, rules: [
    { when: 'HeadRevisionNum > LastReleasedRevisionNum', out: 'cart-c1/deployment\ncart-base/deployment\nother-space/deployment\n' },
    { when: 'UpstreamRevisionNum', out: 'cart-c1/deployment\ncart-c2/deployment\n' },
    { when: 'ApplyGates', out: 'cart-c2/deployment\n' },
    { when: '^changeorder list --space cart-base', out: 'cart-wave\n' },
  ] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls, [
    ['unit', 'list', '--space', '*', '--where', 'HeadRevisionNum > LastReleasedRevisionNum', '-o', 'name'],
    ['unit', 'list', '--space', '*', '--where', 'UpstreamRevisionNum < UpstreamUnit.HeadRevisionNum', '-o', 'name'],
    ['unit', 'list', '--space', '*', '--where', 'LEN(ApplyGates) > 0', '-o', 'name'],
    ['changeorder', 'list', '--space', 'cart-base', '-o', 'name'],
  ]);
  assert.match(result.stdout, /Blocking Gates:\s+1 unit/);
  assert.match(result.stdout, /Unreleased Changes:\s+1 unit/);
  assert.match(result.stdout, /Upgrades Available:\s+2 unit/);
  assert.match(result.stdout, /Outstanding Rollouts: 1 ChangeOrder/);
});
