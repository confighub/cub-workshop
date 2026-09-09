# Local Adapt review — Deployment monitoring/prometheus-server

Requested edit: **only** `/spec/replicas` 1 → 2.

## What the diffs actually show

Both comparisons ran as `cub config diff before.yaml <candidate>.yaml --json --exit-code --out <candidate>.json`.
Both identify the same object: `apps/v1 Deployment monitoring/prometheus-server`.

### candidate-a — within the requested edit
| path | operation | before | after |
|---|---|---|---|
| `/spec/replicas` | replace | 1 | 2 |

Summary: `changed: 1`, one field. No other paths. Exit code **1**.

### candidate-b — NOT within the requested edit
| path | operation | before | after |
|---|---|---|---|
| `/spec/replicas` | replace | 1 | 2 |
| `/spec/revisionHistoryLimit` | replace | 10 | 5 |

candidate-b carries the requested replica change **plus an unrequested change** to
`/spec/revisionHistoryLimit` (10 → 5), which was not authorized by the request.
That extra field is why candidate-b falls outside the requested edit. The change has
been **preserved and reported, not repaired** — `moved/candidate-b.yaml` is unmodified
and the baseline `moved/before.yaml` was not overwritten. Exit code **1**.

Machine-readable verdict: `review.json`.

## What exit 1 means here

With `--exit-code`, `0` = inputs equal, `1` = differences found, `2` = invalid input or
another error. Both candidates returned **1**, which means only *"the two files differ"*.
It is **not** an approval, a rejection, a policy refusal, or a signal about which
candidate is acceptable. Both a correct candidate (a) and an over-broad candidate (b)
produce the identical exit code 1 — the judgment comes from reading the field list, not
from the exit status.

## Path independence check

All three input YAMLs were moved into `moved/` and both comparisons rerun with the same
flags. Results:

- `moved/candidate-a.json` is byte-identical to `candidate-a.json`
- `moved/candidate-b.json` is byte-identical to `candidate-b.json`
- Input hashes are unchanged:
  - before: `sha256:556cbf4cc1e0412d5bc0b10591b7db522e994287063cb79cd45fd375a9944ea8`
  - candidate-a: `sha256:d6a536a143d74657625854851a427b6f3042c08fcc040ff1b3f9506665cf3d03`
  - candidate-b: `sha256:cf640e562124d7b523cdf898489d7605f3c01bd8f7ebbc3abebc59aa71b31af8`
- Rerun exit codes: both **1** (`moved/exit-codes.json`)

File location does not affect the diff or the content hashes.

## Guarantees that are absent

The tool's own `notChecked` list, and what it means here:

- **Kubernetes schema or admission validity** — neither candidate was validated against
  the API server schema or admission policy.
- **Upstream merge and protected-field preservation** — no three-way merge was performed
  and no field was protected from being overwritten.
- **Target readiness or live drift** — no cluster or target was contacted, so live state
  is unknown.
- **Application availability** — nothing observed about a running Prometheus.

Additional limits: arrays are compared as whole values (a one-element change inside a
list is reported as the whole array), mapping and document order are ignored, and
missing vs. `null` are treated as distinct. No Kubernetes defaulting is applied.

## Explicit statements

| Question | Answer |
|---|---|
| Performed an upstream merge? | **No** |
| Protected a field? | **No** |
| Changed ConfigHub? | **No** — local files only, no upload, no unit/space touched |
| Observed a running application? | **No** — no target contacted |

This was a local, offline comparison of YAML files that produces a diff, not an approval.
