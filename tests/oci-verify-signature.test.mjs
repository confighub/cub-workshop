import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const oci = fileURLToPath(new URL('../lib/oci.mjs', import.meta.url));
const DIGEST = `sha256:${'b'.repeat(64)}`;
const RECEIPT = `sha256:${'c'.repeat(64)}`;
const REFERENCE = `oci://localhost:5001/fixture@${DIGEST}`;

// A fake oras and cosign on PATH. The fake registry holds a receipt referrer
// and, per FAKE_SIG, a signature as a sigstore-bundle or cosign referrer, a
// legacy .sig tag, nothing, or a registry that does not answer.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'oci-verify-signature-'));
  const contents = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: signed\n';
  writeFileSync(join(dir, 'config.yaml'), contents);
  const receipt = { kind: 'CertifiedBundleReceipt', spec: { bundle: { files: [{ path: 'config.yaml', sha256: createHash('sha256').update(contents).digest('hex') }] } } };
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const oras = `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');
const args = process.argv.slice(2);
const sig = process.env.FAKE_SIG;
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(1); };
const record = { digest: '${RECEIPT}', artifactType: 'application/vnd.confighub.record.v1+json' };
if (args[0] === 'discover') {
  if (args.includes('--artifact-type')) { console.log(JSON.stringify({ referrers: [record] })); return; }
  if (sig === 'unreachable') fail('Error: Head "http://localhost:5001/v2/fixture/manifests/x": dial tcp: connect: connection refused');
  const referrers = [record];
  if (sig === 'sigstore') referrers.push({ digest: 'sha256:${'d'.repeat(64)}', artifactType: 'application/vnd.dev.sigstore.bundle.v0.3+json' });
  if (sig === 'cosign') referrers.push({ digest: 'sha256:${'e'.repeat(64)}', artifactType: 'application/vnd.dev.cosign.artifact.sig.v1+json' });
  console.log(JSON.stringify({ referrers }));
  return;
}
if (args[0] === 'manifest') {
  if (sig === 'legacy') { console.log('{}'); return; }
  if (sig === 'unreachable') fail('connection refused');
  fail('Error response from registry: ' + args[args.length - 1] + ': not found');
}
if (args[0] === 'pull') {
  const out = args[args.indexOf('-o') + 1];
  mkdirSync(out, { recursive: true });
  if (args.some((arg) => arg.endsWith('${RECEIPT}'))) execFileSync('cp', [${JSON.stringify(join(dir, 'receipt.json'))}, out]);
  else execFileSync('tar', ['-cf', out + '/bundle.tar', '-C', ${JSON.stringify(dir)}, 'config.yaml']);
}
`;
  writeFileSync(join(bin, 'oras'), oras);
  writeFileSync(join(bin, 'cosign'), '#!/bin/sh\n[ "$FAKE_COSIGN" = ok ]\n');
  chmodSync(join(bin, 'oras'), 0o755);
  chmodSync(join(bin, 'cosign'), 0o755);
  return { dir, bin };
}

function verify(f, { sig, cosign = 'bad', key = null }) {
  const code = `import { verifyBundle } from ${JSON.stringify(oci)}; console.log(JSON.stringify(verifyBundle(${JSON.stringify(REFERENCE)}, { key: ${JSON.stringify(key)} })));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, TMPDIR: f.dir, FAKE_SIG: sig, FAKE_COSIGN: cosign },
  });
  assert.equal(run.status, 0, run.stderr);
  const { verified, findings } = JSON.parse(run.stdout);
  const signature = findings.filter(([, text]) => /signature/.test(text));
  assert.equal(signature.length, 1, JSON.stringify(findings));
  return { verified, signature: signature[0] };
}

test('a signature attached as a sigstore bundle, a cosign referrer, or a .sig tag is reported, not checked, without a key', () => {
  const f = fixture();
  for (const sig of ['sigstore', 'cosign', 'legacy']) {
    const result = verify(f, { sig });
    assert.deepEqual(result.signature, ['NOTE', 'a signature is attached but was not checked: pass --key <public key>'], sig);
    assert.equal(result.verified, true, 'an unchecked signature does not refuse a bundle whose receipt matches');
  }
});

test('no signature is said plainly, as a note without a key and a refusal with one', () => {
  const f = fixture();
  assert.deepEqual(verify(f, { sig: 'none' }).signature, ['NOTE', 'no signature is attached to this digest']);
  const keyed = verify(f, { sig: 'none', key: 'cosign.pub' });
  assert.deepEqual(keyed.signature, ['FAIL', 'no signature is attached to this digest']);
  assert.equal(keyed.verified, false);
});

test('a key that verifies passes, and a key that does not is told apart from a missing signature', () => {
  const f = fixture();
  const good = verify(f, { sig: 'sigstore', key: 'cosign.pub', cosign: 'ok' });
  assert.deepEqual(good.signature, ['PASS', 'signature verifies against the offered key']);
  assert.equal(good.verified, true);
  const wrong = verify(f, { sig: 'sigstore', key: 'other.pub' });
  assert.deepEqual(wrong.signature, ['FAIL', 'a signature is attached but does not verify against the offered key']);
  assert.equal(wrong.verified, false);
});

test('an unreachable registry is unknown, never none', () => {
  const f = fixture();
  const open = verify(f, { sig: 'unreachable' });
  assert.equal(open.signature[0], 'NOTE');
  assert.match(open.signature[1], /could not be determined/);
  assert.doesNotMatch(open.signature[1], /no signature is attached/);
  const keyed = verify(f, { sig: 'unreachable', key: 'cosign.pub' });
  assert.equal(keyed.signature[0], 'FAIL');
  assert.match(keyed.signature[1], /could not be determined/);
});
