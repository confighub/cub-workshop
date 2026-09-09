# Local Match results

These are illustrative inputs, not observations from a real target. All three comparisons ran using the installed Workshop plugin through the offline `cub app match` command.

| Target input | Saved result | Observed status | Actual command exit code |
| --- | --- | --- | --- |
| `nodes.yaml` | `candidate.json` | candidate | 0 |
| `mismatch-nodes.yaml` | `mismatch.json` | mismatch | 1 |
| `unknown-nodes.yaml` | `unknown.json` | unknown | 3 |

Commands executed:

```sh
cub app match model.yaml --target nodes.yaml --json --out candidate.json
cub app match model.yaml --target mismatch-nodes.yaml --json --out mismatch.json
cub app match model.yaml --target unknown-nodes.yaml --json --out unknown.json
```

The candidate has the exact requested GPU product label and supplies 2 allocatable GPUs on one node, matching the requirement of 2 GPUs per replica. The comparison is per node, not a fleet total.

The mismatch retains the matching label but supplies only 1 GPU against the requirement of 2. Only the requested GPU value was changed in its copy; the mismatch remains preserved.

The unknown retains the matching label but omits the GPU allocatable line. The result records the supplied count as null and the GPU check as unknown, not zero. Only that line was removed from a copy of the original nodes.yaml; no GPU count was invented.

Allocatable GPUs are not free GPUs: this supplied capacity fact does not establish availability after concurrent workloads. No real target was observed. Every result records `liveChecked: false` and `execution: "not-run"`.

These results do not prove hardware or runtime compatibility, successful scheduling, model entitlement, or inference. GPU memory and partitioning, other resources, readiness, quotas, placement, controllers, registry credentials, entitlement, and application responses were not checked. Snapshot authenticity and freshness were not checked either.

The original model.yaml and nodes.yaml were verified byte-for-byte unchanged. Derived inputs were verified against the exact byte transformations requested. Saved JSON was parsed and checked against retained command stdout, and its input hashes were verified. Actual subprocess exit codes are recorded in exit-codes.json; raw stdout and stderr are retained in the corresponding *.stdout.json and *.stderr.log files. No installation, upgrade, cluster or registry contact, credential reading, or deployment was performed.
