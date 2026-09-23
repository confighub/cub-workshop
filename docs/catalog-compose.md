# Compose retained catalog entries

`cub stack compose` builds a local stack from explicit catalog listing IDs:

```bash
cub stack compose \
  --entry prometheus-community-prometheus-29-9-0-default \
  --entry grafana-promtail-6-17-1-default \
  --name platform \
  --out ./platform
```

The command downloads each listing and its retained object file, verifies the
file SHA-256 and Kubernetes object count, and runs the existing static stack
check. For retained-only entries it writes those exact files, `stack.yaml`,
`provenance.json`, and the check result into a new directory. Entry order is
sorted by ID so equivalent retained-only inputs produce the same bytes.

`safe-to-flatten` and `born-flat` listings compose from their retained objects.
A `flatten-with-routes` listing is accepted only when the selected listing names
a published literal-config OCI reference pinned by manifest digest, a committed
CertifiedBundleReceipt URL and SHA-256, and a receipt that binds the exact chart
version, retained-object digest and count, and at least one declared route. The
command verifies those source bytes and asks the existing stack sandbox to
materialize an editable workspace. The workspace serializes editable YAML and
records its materialized file hashes in `result.workspaceFiles`; it also creates
a local baseline receipt. It preserves the verified source receipt and route
companions as `declared-unexecuted` evidence; it does not execute a route,
establish readiness, or make a runtime claim. `unsafe-to-flatten`, unpublished
bundles, missing receipts, and mismatched receipt or route evidence are refusals
before a workspace is created.

A saved route workspace may append new, uniquely named `authored` components,
then save another workspace. The original materialized manifest is retained as
hashed evidence; its name, bindings, component order, and original component
sources must remain identical. The original bundle receipt and companions do
not prove the appended application or its runtime behavior.

The command creates no OCI reference, readiness claim, or runtime proof. A
refused static check for retained-only entries preserves the materialized files
and evidence for inspection.

Use `--catalog-index` with a local index for deterministic offline fixtures.
Network requests use HTTPS and a bounded timeout.

With `--json`, a compose error is one JSON document with this stable shape:

```json
{
  "kind": "CatalogRetainedCompositionError",
  "code": "source_integrity_failed",
  "message": "retained object hash mismatch for example",
  "actions": ["inspect", "repair"]
}
```

Error codes are `invalid_arguments`, `entry_not_found`,
`missing_retained_objects`, `lifecycle_route_required`,
`source_integrity_failed`, `source_invalid`, `network_failed`,
`output_exists`, `output_write_failed`, `check_failed`, and
`internal_error`. Actions are limited to `inspect`, `select`, and `repair`;
the command never selects or applies a remedy automatically.
