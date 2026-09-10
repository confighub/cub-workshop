# Local Match command

cub app match model.yaml --target nodes.yaml --json --out candidate.json

Supply one KServe InferenceService and a v1 Node snapshot. The command is offline.
It compares exact node selectors and per-node GPU quantity, never a fleet total.
The output records file hashes, node checks, omitted checks and a next action.
Exit 0 = candidate; 1 = mismatch or invalid input; 3 = unknown facts.
Expected nonzero outcomes still save a valid result when inputs are structurally valid.
Existing output files refuse overwrite. No --run or deployment mode exists.
A candidate is not live readiness, hardware/runtime compatibility or inference proof.
Allocatable GPUs are not free GPUs. The target fixture is illustrative.
