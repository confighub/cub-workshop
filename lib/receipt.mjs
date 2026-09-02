// A receipt for what the plugin publishes, in the shape the catalog's certified
// bundles already use, so one verifier reads both.
import { join } from "node:path";
import { pluginRoot, readYamlFile } from "./common.mjs";
import { sha256 } from "./oci.mjs";

const version = readYamlFile(join(pluginRoot, "cub-plugin.yaml"))?.version ?? "0.0.0";

export function buildReceipt({ name, source, files, checks = [], components = null }) {
  const spec = {
    producer: { name: "cub-workshop", version, repository: "https://github.com/confighub/cub-workshop" },
    source,
    checks: checks.map(([mark, text]) => ({ result: mark.trim() || "detail", text })),
    bundle: {
      contentsKind: "rendered-config",
      files: files.map((file) => {
        const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, "utf8");
        return { path: file.path, sha256: sha256(content), bytes: content.length };
      }),
    },
  };
  if (components) spec.components = components;
  return {
    apiVersion: "evidence.confighub.com/v1alpha1",
    kind: "CertifiedBundleReceipt",
    metadata: { name, producedAt: new Date().toISOString() },
    spec,
  };
}

export function printPublished(label, published) {
  console.log(`\n  Published ${label} as a certified bundle`);
  console.log(`    ${published.receipt.spec.bundle.reference}`);
  console.log(`    receipt attached: ${published.receiptDigest}`);
}
