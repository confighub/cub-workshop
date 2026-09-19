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
check. It writes the exact files, `stack.yaml`, `provenance.json`, and the
check result into a new directory. Entry order is sorted by ID so equivalent
inputs produce the same bytes.

Only `safe-to-flatten` and `born-flat` listings are accepted. Entries marked
`unsafe-to-flatten` or `flatten-with-routes` remain refusals because a retained
render is not permission to publish a literal bundle or skip its source route.
The command creates no OCI reference, receipt, readiness claim, or runtime
proof. A refused static check preserves the materialized files and evidence for
inspection.

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
