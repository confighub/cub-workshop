# Direct CLI, Claude Code and Codex: the same bounded Match task

One direct CLI run and one actual execution through each assistant produced the
same candidate, mismatch and unknown results. Every corresponding result JSON
agrees, including input hashes and per-node findings. Both assistants left the
original model and Node fixture unchanged and made exactly the requested byte
changes in the two copies. They retained exit codes 0, 1 and 3 respectively.

This is a prepared local trial, not a live GPU proof, performance benchmark,
independent human handoff or evidence that the full Match journey is complete.
The Node fixture is illustrative. No model was fetched or inference executed by
the comparison commands. The assistant reports explicitly preserve that boundary.

## Inputs and execution

- Implementation: [PR #16](https://github.com/confighub/cub-workshop/pull/16),
  revision `31202099f41dbd8db51c2f9bd9d87a2be714091d`, plugin 0.6.19.
- Inputs: unchanged `examples/match/model.yaml` and `nodes.yaml` from that revision,
  retained here. The implementation's example records the original Catalog source.
- CLI: cub 0.4.4; Claude Code 2.1.227; Codex CLI 0.153.4.
- Each run used a fresh directory and isolated CUB_CONFIG installation. Preparation
  was completed before starting the task timer and is excluded from elapsed time.
- Both assistants received exactly `task.txt` and `workflow.md`. CLI default model
  selection was used, not pinned models. Claude Code took 56.58 seconds and Codex
  59.22 seconds in these single observations; this is not a speed comparison.
- Claude Code ran in safe mode with `dontAsk`, Bash/Read/Write/Edit tools and a
  three-dollar request cap. Codex ran ephemeral with workspace-write sandbox and
  user configuration ignored. The task prohibited delegation and target operations.

`execution.json` records the implementation revision, input and task hashes,
versions, elapsed observations and assistant process exit codes. The direct and
assistant subdirectories retain all three result JSON files, derived inputs and
command exit codes. Assistant reports are retained verbatim; the Codex report's
referenced stdout/stderr files are also retained. Raw agent session logs and the
prepared plugin installations are not included.

## Verification and limits

```sh
node --test tests/match-local-evidence.test.mjs
```

The verifier compares every assistant result with the direct result, checks exact
input transformations, hashes, GPU findings, exit codes and omitted-check scope.
It also requires completed assistant execution records and nonempty reports.
Report interpretation was reviewed: both distinguish allocatable from free GPUs
and deny hardware compatibility, scheduling, entitlement and inference proof.
The verifier does not rerun assistants or independently attest their complete tool
history. This is retained local task evidence with a declared execution boundary.

Candidate means the supplied labels and per-node GPU count satisfy the declared
requirements. Unknown stays unknown; mismatch stays mismatched. Neither is
repaired or removed to obtain a positive result. Snapshot freshness, free GPU
capacity, GPU/runtime suitability, scheduling, model access and actual responses
remain unverified even for the candidate.

The repeatable task and direct demonstration are in
[tasks/match-local.md](../../tasks/match-local.md). Real target qualification,
automatic model selection, the final website journey and a human handoff remain
separate work in the eight-block plan.
