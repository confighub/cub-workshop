import test from 'node:test';
import assert from 'node:assert/strict';
import { runFleet, noSpaces } from './fleet-fake-cub.mjs';

// One canary, two secondary and one primary cluster carry cart in waves; a
// fifth cluster has no phase, which is fine because only search lands there.
const spec = () => ({
  metadata: { name: 'waved' },
  spec: {
    clusters: [
      { name: 'c1', labels: { phase: 'canary' } },
      { name: 'c2', labels: { phase: 'secondary' } },
      { name: 'c3', labels: { phase: 'secondary' } },
      { name: 'c4', labels: { phase: 'primary' } },
      { name: 'lab' },
    ],
    placements: [
      { app: 'cart', team: 'retail', authored: 'apps/cart.yaml', clusters: ['c1', 'c2', 'c3', 'c4'], waves: ['canary', 'secondary', 'primary'] },
      { app: 'search', team: 'retail', authored: 'apps/search.yaml', clusters: ['lab', 'c1'] },
    ],
    demoAging: [{ kind: 'rollout', component: 'cart', where: "Slug LIKE '%deployment%'" }],
  },
});
const files = (manifest = spec()) => ({ 'fleet.yaml': JSON.stringify(manifest) });

// The fake cub answers the ChangeOrder state queries the way the server
// would: every slug opened on cart-base, and those in progress or aborted.
const state = ({ opened = [], inProgress = [], aborted = [] } = {}) => [
  { when: "^changeorder list --space cart-base --where State = 'InProgress'", out: inProgress.map((slug) => `${slug}\n`).join('') },
  { when: "^changeorder list --space cart-base --where State = 'Aborted'", out: aborted.map((slug) => `${slug}\n`).join('') },
  { when: '^changeorder list --space cart-base -o name', out: opened.map((slug) => `${slug}\n`).join('') },
];
const creates = (calls) => calls.filter((args) => args[0] === 'changeorder' && args[1] === 'create');

test('rollout is a dry run that prints the first wave, scoped to its phase', () => {
  const { result, calls } = runFleet(['rollout', '{dir}/fleet.yaml', 'cart'], { files: files(), rules: state() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cart: wave 1 of 3 \(canary -> secondary -> primary\): canary, 1 Space\(s\)/);
  assert.match(result.stdout, /cub changeorder create cart-rollout-canary --space cart-base --in-scope-space cart-c1 --description 'Wave canary/);
  assert.match(result.stdout, /cub function do --space cart-base --where 'Slug = '\\''upstream'\\''' set-annotation meridian\.example\/rollout canary/);
  assert.match(result.stdout, /Dry run\. Add --run to execute\./);
  assert.deepEqual(calls, [['changeorder', 'list', '--space', 'cart-base', '-o', 'name']]);
});

test('rollout plans the next wave once the previous one has closed', () => {
  const { result, calls } = runFleet(['rollout', '{dir}/fleet.yaml', 'cart'], { files: files(), rules: state({ opened: ['cart-rollout-canary'] }) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wave 2 of 3 .*: secondary, 2 Space\(s\)/);
  assert.match(result.stdout, /--in-scope-space cart-c2,cart-c3 /);
  assert.equal(creates(calls).length, 0);
});

test('rollout --run opens the wave ChangeOrder and stamps the change it carries', () => {
  const { result, calls } = runFleet(['rollout', '{dir}/fleet.yaml', 'cart', '--where', "Slug LIKE '%deployment%'", '--run'], {
    files: files(), rules: state({ opened: ['cart-rollout-canary', 'cart-rollout-secondary', 'unrelated'] }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.slice(-2), [
    ['changeorder', 'create', 'cart-rollout-primary', '--space', 'cart-base', '--in-scope-space', 'cart-c4',
      '--description', 'Wave primary of the cart rollout across fleet waved: 1 Space(s).'],
    ['function', 'do', '--space', 'cart-base', '--where', "Slug LIKE '%deployment%'", 'set-annotation', 'meridian.example/rollout', 'primary',
      '--change-desc', 'Rollout: the change wave primary takes to its Spaces'],
  ]);
  assert.match(result.stdout, /ChangeOrder cart-rollout-primary opened on 1 Space\(s\)\. This is the last wave\./);
});

test('rollout refuses the next wave while the previous wave\'s ChangeOrder is open', () => {
  const { result, calls } = runFleet(['rollout', '{dir}/fleet.yaml', 'cart', '--run'], {
    files: files(), rules: state({ opened: ['cart-rollout-canary'], inProgress: ['cart-rollout-canary'] }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Refused: cart wave secondary waits, because wave canary's ChangeOrder cart-rollout-canary is still open\./);
  assert.match(result.stderr, /Finish promoting it through its 1 Space\(s\) so it closes, then run cub fleet rollout waved cart again\./);
  assert.equal(creates(calls).length, 0);
  assert.ok(!calls.some((args) => args[0] === 'function'));
});

test('rollout refuses to go on past an aborted wave', () => {
  const { result, calls } = runFleet(['rollout', '{dir}/fleet.yaml', 'cart'], {
    files: files(), rules: state({ opened: ['cart-rollout-canary', 'cart-rollout-secondary'], aborted: ['cart-rollout-secondary'] }),
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /wave primary waits, because wave secondary's ChangeOrder cart-rollout-secondary was aborted/);
  assert.equal(creates(calls).length, 0);
});

test('rollout says so when every wave already has its ChangeOrder', () => {
  const { result, calls } = runFleet(['rollout', '{dir}/fleet.yaml', 'cart'], {
    files: files(), rules: state({ opened: ['cart-rollout-canary', 'cart-rollout-secondary', 'cart-rollout-primary'] }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /every wave \(canary -> secondary -> primary\) already has its ChangeOrder/);
  assert.equal(creates(calls).length, 0);
});

test('rollout of a base not yet uploaded plans the first wave, and a lookup failure stops it', () => {
  const absent = runFleet(['rollout', '{dir}/fleet.yaml', 'cart'], { files: files(), rules: [{ when: '^changeorder list', err: 'Failed: space cart-base not found\n', code: 1 }] });
  assert.equal(absent.result.status, 0, absent.result.stderr);
  assert.match(absent.result.stdout, /wave 1 of 3/);
  const denied = runFleet(['rollout', '{dir}/fleet.yaml', 'cart'], { files: files(), rules: [{ when: '^changeorder list', err: 'Failed: permission denied\n', code: 1 }] });
  assert.equal(denied.result.status, 1);
  assert.match(denied.result.stderr, /permission denied/);
});

test('rollout refuses a component without waves', () => {
  const { result } = runFleet(['rollout', '{dir}/fleet.yaml', 'search'], { files: files() });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /placement search names no waves/);
});

test('the age rollout op opens the next wave, and is held while the previous wave is open', () => {
  const opens = runFleet(['age', '{dir}/fleet.yaml'], { files: files(), rules: state() });
  assert.equal(opens.result.status, 0, opens.result.stderr);
  assert.equal(creates(opens.calls)[0][2], 'cart-rollout-canary');
  assert.ok(opens.calls.some((args) => args.join(' ') === "function do --space cart-base --where Slug LIKE '%deployment%' set-annotation meridian.example/rollout canary --change-desc Rollout: the change wave canary takes to its Spaces"));
  assert.match(opens.result.stdout, /rollout wave opened: cart-rollout-canary \(1 spaces in scope\)/);
  const held = runFleet(['age', '{dir}/fleet.yaml'], { files: files(), rules: state({ opened: ['cart-rollout-canary'], inProgress: ['cart-rollout-canary'] }) });
  assert.equal(held.result.status, 0, held.result.stderr);
  assert.equal(creates(held.calls).length, 0);
  assert.match(held.result.stdout, /rollout held: cart wave secondary waits, cart-rollout-canary is still open/);
});

test('fleet up records each cluster\'s phase on its deployment Space labels', () => {
  const { result, calls } = runFleet(['up', '{dir}/fleet.yaml'], { files: files(), rules: [noSpaces] });
  assert.equal(result.status, 0, result.stderr);
  const variants = calls.filter((args) => args[0] === 'variant' && args[1] === 'create');
  assert.deepEqual(variants.map((args) => [args[2], args[3], args.slice(6).join(' ')]), [
    ['c1', 'cart-base', '--space-label Phase=canary'],
    ['c2', 'cart-base', '--space-label Phase=secondary'],
    ['c3', 'cart-base', '--space-label Phase=secondary'],
    ['c4', 'cart-base', '--space-label Phase=primary'],
    ['lab', 'search-base', ''],
    ['c1', 'search-base', '--space-label Phase=canary'],
  ]);
});

test('fleet status counts the Spaces of each opened wave and names the open one', () => {
  const { result, calls } = runFleet(['status', '{dir}/fleet.yaml'], {
    files: files(), rules: state({ opened: ['cart-rollout-canary', 'cart-rollout-secondary'], inProgress: ['cart-rollout-secondary'] }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Rollouts by wave:\s+canary 1, secondary 2, primary 0 Space\(s\) in opened waves; open: cart secondary/);
  assert.match(result.stdout, /Outstanding Rollouts: 2 ChangeOrder/);
  assert.deepEqual(calls.filter((args) => args[0] === 'changeorder').map((args) => args.join(' ')), [
    'changeorder list --space cart-base -o name',
    "changeorder list --space cart-base --where State = 'InProgress' -o name",
    'changeorder list --space search-base -o name',
  ]);
});

test('fleet status leaves out the wave line when no placement names waves', () => {
  const plain = spec(); delete plain.spec.placements[0].waves; plain.spec.demoAging = [];
  const { result } = runFleet(['status', '{dir}/fleet.yaml'], { files: files(plain) });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Rollouts by wave/);
});

test('fleet down deletes the wave ChangeOrders a rollout opened', () => {
  const { result, calls } = runFleet(['down', '{dir}/fleet.yaml'], { files: files(), rules: [
    { when: '^changeorder delete cart-rollout-primary', err: 'Failed: changeorder cart-rollout-primary not found\n', code: 1 },
  ] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.slice(0, 3).map((args) => args.slice(0, 3).join(' ')), [
    'changeorder delete cart-rollout-canary', 'changeorder delete cart-rollout-secondary', 'changeorder delete cart-rollout-primary',
  ]);
  assert.match(result.stdout, /2 changeorder\(s\) closed/);
});

test('fleet plan shows how many Spaces each wave takes', () => {
  const { result } = runFleet(['plan', '{dir}/fleet.yaml'], { files: files() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cart\s+4 cluster\(s\)\s+path apps\/cart\.yaml\s+waves canary 1, secondary 2, primary 1/);
  const shipped = runFleet(['plan', 'meridian']);
  assert.match(shipped.result.stdout, /external-dns\s+10 cluster\(s\).*waves canary 2, secondary 3, primary 5/);
});

test('a manifest whose waves do not match its clusters\' phases is refused', () => {
  const cases = [
    [(m) => { delete m.spec.clusters[3].labels; }, /placement cart names waves, but cluster c4 has no phase label; give it labels: \{phase: <one of canary, secondary, primary>\}/],
    [(m) => { m.spec.placements[0].waves = ['canary', 'secondary', 'primary', 'final']; }, /placement cart: wave final is not the phase of any cluster it lands on/],
    [(m) => { m.spec.placements[0].waves = ['canary', 'primary']; }, /placement cart: cluster c2 is in phase secondary, which none of its waves \(canary, primary\) reaches/],
    [(m) => { m.spec.placements[0].waves = ['canary', 'canary', 'secondary', 'primary']; }, /waves names a phase twice/],
    [(m) => { m.spec.placements[0].waves = 'canary'; }, /waves must be a list of phases/],
    [(m) => { m.spec.demoAging = [{ kind: 'rollout', component: 'search' }]; }, /demoAging rollout names search, which no placement with waves places/],
  ];
  for (const [change, message] of cases) {
    const manifest = spec(); change(manifest);
    const { result, calls } = runFleet(['plan', '{dir}/fleet.yaml'], { files: files(manifest) });
    assert.equal(result.status, 2, `${message}: ${result.stdout}`);
    assert.match(result.stderr, message);
    assert.equal(calls.length, 0);
  }
});
