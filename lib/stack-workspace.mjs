import { mkdirSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { toYaml } from './common.mjs';
import { buildReceipt } from './receipt.mjs';
import { certificationResult, renderStack } from './stack-result.mjs';

// A materialized editing copy: original sources stay in the baseline result,
// while the manifest reads only files inside this new directory. Publishing a
// changed copy requires a new check and new artifact identity.
export function writeStackWorkspace(stack, result, directory) {
  if (!result.certified) throw new Error('refused compositions cannot create a workspace');
  const target = resolve(directory);
  const files = [];
  const components = stack.components.map((comp, index) => {
    const slug = String(comp.name).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'component';
    const path = `components/${String(index + 1).padStart(2, '0')}-${slug}.yaml`;
    files.push({ path, content: comp.objects.map(toYaml).join('---\n') });
    return { name: comp.name, ...(comp.plane ? { plane: comp.plane } : {}),
      ...(comp.order != null ? { order: comp.order } : {}), [comp.authored ? 'authored' : 'render']: path };
  });
  const manifest = { apiVersion: 'helm-expt.confighub.com/v1alpha1', kind: 'Stack',
    metadata: { name: stack.name }, spec: { description: stack.description, components,
      ...(stack.bindings ? { bindings: stack.bindings } : {}) } };
  const manifestFile = { path: 'stack.yaml', content: toYaml(manifest) };
  // The snapshot lets a later workspace add a new authored component without
  // weakening the receipt-bound identity of the materialized platform.
  const originalManifestFile = { path: 'evidence/original-stack.yaml', content: manifestFile.content };
  files.push({ path: 'rendered.yaml', content: renderStack(stack) }, originalManifestFile);
  const baseline = certificationResult(stack, result, 'rendered.yaml');
  const lifecycle = [];
  for (const [componentIndex, component] of stack.components.entries()) {
    const evidence = component.bundleEvidence;
    if (!evidence) continue;
    const slug = String(component.name).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60) || 'component';
    const root = `evidence/${String(componentIndex + 1).padStart(2, '0')}-${slug}`;
    const receiptPath = `${root}/receipt.yaml`;
    files.push({ path: receiptPath, content: evidence.receipt.bytes });
    const companions = evidence.companions.map((companion, index) => {
      const name = companion.source.split('/').pop().replace(/[^a-zA-Z0-9._-]+/g, '-');
      const path = `${root}/companions/${String(index + 1).padStart(2, '0')}-${name}`;
      files.push({ path, content: companion.bytes });
      return { path, source: companion.source, role: companion.role, sha256: companion.sha256, state: 'declared-unexecuted' };
    });
    const record = {
      component: component.name,
      bundle: evidence.bundle ?? component.bundle,
      receipt: { path: receiptPath, source: evidence.receipt.source, sha256: evidence.receipt.sha256, bundleDigest: evidence.receipt.bundleDigest },
      companions,
      state: companions.length ? 'declared-unexecuted' : 'none-declared',
      boundary: 'Companion routes are preserved evidence only. This workspace does not execute a lifecycle route or establish runtime readiness.',
    };
    const metadataPath = `${root}/metadata.json`;
    files.push({ path: metadataPath, content: `${JSON.stringify(record, null, 2)}\n` });
    lifecycle.push({ ...record, metadataPath });
  }
  baseline.lifecycleCompanions = {
    state: lifecycle.some((entry) => entry.companions.length) ? 'declared-unexecuted' : 'none-declared',
    entries: lifecycle,
  };
  baseline.workspaceFiles = buildReceipt({ name: stack.name, source: { kind: 'stack', name: stack.name },
    files: [...files, manifestFile] }).spec.bundle.files;

  // Claim a previously absent directory; even an empty existing directory is
  // refused. Exclusive file writes never overwrite another writer's contents.
  try { mkdirSync(target); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`workspace already exists: ${directory}; use its stack.yaml to resume, or choose a new directory`);
    throw error;
  }
  try {
    mkdirSync(join(target, 'components'));
    for (const file of files) {
      mkdirSync(dirname(join(target, file.path)), { recursive: true });
      writeFileSync(join(target, file.path), file.content, { flag: 'wx' });
    }
    writeFileSync(join(target, 'result.json'), `${JSON.stringify(baseline, null, 2)}\n`, { flag: 'wx' });
    // Publish a complete manifest atomically, without replacing an existing file.
    // If writing is interrupted first, no runnable stack.yaml is exposed.
    const pending = join(target, '.stack.yaml.partial');
    writeFileSync(pending, manifestFile.content, { flag: 'wx' });
    linkSync(pending, join(target, manifestFile.path));
    unlinkSync(pending);
  } catch (error) {
    throw new Error(`workspace incomplete at ${directory}; preserve it for inspection and choose a new directory (${error.message})`);
  }
  return join(target, 'stack.yaml');
}
