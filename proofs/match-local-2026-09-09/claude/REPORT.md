# Match Report — offline comparison of `model.yaml` against supplied Node snapshots

All three runs were `cub app match`, which is an offline, file-to-file comparison.
No cluster, registry, or credential was contacted.

## Observed statuses

| Run | Target file | Status | Exit code | Deciding check |
|-----|-------------|--------|-----------|----------------|
| candidate | `nodes.yaml` (unchanged) | `candidate` | 0 | `status.allocatable[nvidia.com/gpu]` required 2, supplied 2 → pass |
| mismatch | `mismatch-nodes.yaml` (`"2"` → `"1"`) | `mismatch` | 1 | required 2, supplied 1 → mismatch |
| unknown | `unknown-nodes.yaml` (GPU line removed) | `unknown` | 3 | required 2, supplied `null` → unknown |

In every run the node-selector check (`metadata.labels[nvidia.com/gpu.product]` =
`NVIDIA-H100-SXM4-80GB`) passed. Only the per-node GPU quantity changed the outcome.
The workload hash was identical across all three runs
(`sha256:a87b0aec…`); only the target hash differed, confirming that
`model.yaml` and `nodes.yaml` were left unchanged and that each variant was a
distinct file.

The `mismatch` and `unknown` results are preserved as-is. The missing GPU fact in
`unknown-nodes.yaml` was not filled in with a guessed count — `unknown` (exit 3) is the
correct, honest outcome for absent input, and it is distinct from `mismatch`, which
reports a fact that was present and did not satisfy the requirement.

## Are allocatable GPUs free GPUs?

No. `status.allocatable[nvidia.com/gpu]` is the count of GPUs the node reports as
schedulable capacity in the abstract. It does not subtract GPUs already consumed by
running or pending pods, reserved by other workloads, or held by DaemonSets. A node
that reports 2 allocatable GPUs may have 0 actually free at any moment. Every result
file lists "free GPUs and concurrent workloads" under `notChecked`.

## Was any real target observed?

No. `nodes.yaml` is an illustrative fixture — its first line says so explicitly, and its
node is literally named `illustrative-h100`. Each result records
`"scope": "supplied-node-snapshot"`, `"liveChecked": false`, and `"execution": "not-run"`.
The command compared two local files. Nothing was queried, and snapshot authenticity and
freshness were not checked either.

## What a `candidate` does and does not prove

The `candidate` result proves exactly one thing: the declared node selector and the
declared per-node GPU quantity in `model.yaml` are consistent with the facts stated in
the supplied snapshot file. That is a comparison of declarations, not an observation of a
system.

It does **not** establish:

- **Hardware compatibility** — GPU memory, MIG/partitioning, driver and CUDA versions,
  interconnect, and runtime compatibility with
  `nvidia-nim-llama3-8b-instruct-1.0.0` were all omitted. A label string matching is not
  a hardware qualification.
- **Scheduling** — taints, tolerations, affinity/anti-affinity, quotas, node readiness,
  pressure conditions, replica placement, and autoscaling were not evaluated. Nothing
  says a pod would actually be admitted or placed. The comparison is also per-node, never
  a fleet total, so it says nothing about aggregate capacity.
- **Entitlement** — registry credentials and model license/entitlement for the NIM image
  and `pvc://nvidia-nim-pvc/` storage were not checked. No credential was read.
- **Inference** — nothing was run. `"execution": "not-run"`. The serving runtime,
  controllers, and API availability were not verified, and no request was made or answered.
  There is zero evidence about whether the model would load, serve, or produce correct output.

## Next action

As recorded in `candidate.json`: review the omitted checks and qualify the exact workload
on an authorized target before any deployment. This report is not a readiness sign-off.
