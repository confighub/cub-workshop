# Match a GPU workload with supplied facts

Requires the implementation in [PR #16](https://github.com/confighub/cub-workshop/pull/16),
tested at revision `31202099f41dbd8db51c2f9bd9d87a2be714091d` (proposed plugin
version 0.6.19). This task is not supported by older plugin installations.

Install that reviewed plugin revision and prepare a new directory with `model.yaml`
and `nodes.yaml` from its `examples/match/` directory. The model is retained Catalog
configuration; the Node snapshot is illustrative, not a real target observation.
Setup and task execution are separate. An isolated trial uses a separate CUB_CONFIG
folder; an ordinary installation does not need that extra sentence in the prompt.

## Direct route

```sh
cub app match model.yaml --target nodes.yaml --json --out candidate.json
```

Expected: exit 0, status candidate. Copy the original nodes.yaml to
mismatch-nodes.yaml and change only the GPU quantity from 2 to 1:

```sh
cub app match model.yaml --target mismatch-nodes.yaml --json --out mismatch.json
```

Expected: exit 1, status mismatch. Preserve the mismatch. Copy the ORIGINAL
nodes.yaml to unknown-nodes.yaml and remove only its GPU quantity line:

```sh
cub app match model.yaml --target unknown-nodes.yaml --json --out unknown.json
```

Expected: exit 3, status unknown. Do not turn missing data into zero or assume it
matches. Expected nonzero results are still retained; do not chain these commands
with `&&` and mistake a deliberate refusal for a broken demonstration. Existing
output files refuse overwrite; use a fresh directory when repeating the task.

## Assistant route

Give either assistant the [workflow](../proofs/match-local-2026-09-09/workflow.md)
and the same [task](../proofs/match-local-2026-09-09/task.txt). Both must run the
commands and retain results and exit codes. A prose answer alone is not completion.

Compare source hashes, per-node findings and statuses with the direct route. Keep
all three results: candidate, mismatch and unknown are different useful outcomes.
Ask the assistant to explain what remains unverified. Allocatable GPUs are not
free GPUs, and a candidate does not establish runtime compatibility, scheduling,
model entitlement or an inference response. No target was contacted in this task.

The [retained trial](../proofs/match-local-2026-09-09/README.md) records one execution
per assistant, not an independent human handoff or evidence of repeatable speed.
This slice does not choose a model automatically, validate a full inference stack,
or complete the real GPU execution requirement.
