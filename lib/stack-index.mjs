// A published stack index: an OCI image index over its components' digests in
// one repository, with the stack's manifest attached as a StackIndexRecord.
// cub stack reads one to check or sandbox it, and cub fleet to place it, so
// both see the same components pinned by the same digests.

import { fail, parseDocs } from "./common.mjs";
import { discoverRecords, parseReference } from "./oci.mjs";
import { validateStackManifest } from "./stack-manifest.mjs";

// A reference names an index only through its digest: a tag can be moved, and
// a fleet that followed one would place something nobody checked.
export const INDEX_REFERENCE = /^oci:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/;

// A published index names its components by digest in one repository, with
// the manifest attached; loading one turns every component into bundle form.
export function loadIndexStack(reference) {
  const target = parseReference(reference);
  const found = discoverRecords(reference, "StackIndexRecord")[0];
  if (!found) fail(`${reference} has no stack record attached; publish it with cub stack publish`);
  const record = found.record;
  const parsed = parseDocs(record.spec.manifest)[0];
  validateStackManifest(parsed);
  const digests = new Map((record.spec.components ?? []).map((entry) => [entry.name, entry.digest]));
  parsed.spec.components = (parsed.spec.components ?? []).map((comp) => {
    const digest = digests.get(comp.name);
    if (!digest) fail(`index record has no digest for component "${comp.name}"`);
    const { render, authored, bundle, receipt, ...rest } = comp;
    return { ...rest, bundle: `oci://${target.repo}@${digest}` };
  });
  return { stack: parsed, path: reference };
}
