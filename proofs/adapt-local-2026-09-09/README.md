# Direct CLI and assistant review of a local Adapt change

The direct CLI route and one actual run through each of Claude Code and Codex
reviewed the same two candidates against the retained Prometheus Deployment.
Candidate A changes replicas from 1 to 2. Candidate B additionally changes
revisionHistoryLimit from 10 to 5, outside the requested edit.

Both assistants retained the complete diffs, judged A within the requested edit,
and flagged B's extra field. Neither repaired or hid the unexpected change. All
input bytes were checked after the task. Each route also moved the three inputs
and reran the comparison; findings and hashes stayed identical.

Every comparison exited 1 under `--exit-code`, including candidate A. That means
differences exist. It is not an approval or policy refusal. The assistant's
`review.json` is a separate judgment, checked against the retained diff by the
verifier; the CLI does not enforce this task's one-field allowance itself.

## Execution and evidence

- Implementation: merged #18, revision
  `1816d573b832efd78fc53790e8a53f5bcb8a4006`, Workshop 0.6.20.
- Input: `examples/adapt/prometheus-before.yaml` from that revision, with source
  provenance retained in the implementation's `examples/adapt/source.json`.
- `before.yaml` and both candidate files are retained here. The candidates were
  prepared with exactly the two stated text substitutions before task execution.
- Each route used a fresh directory and isolated CUB_CONFIG plugin installation.
  Setup is excluded from assistant elapsed times in `execution.json`.
- Both assistants received the same `task.txt` and `workflow.md`, with CLI default
  model selection. This is one observation per assistant, not a speed benchmark,
  pinned-model evaluation or independent human trial.
- Claude Code used safe mode, `dontAsk`, Bash/Read/Write/Edit and a three-dollar
  request cap. Codex ran ephemeral with workspace-write and user config ignored.
  The task prohibited delegation and target operations.

Each route's directory retains both diffs and exit codes, plus its rerun records
under `moved/`. The assistant review JSON and reports are retained verbatim.
`execution.json` records source and task identity, CLI versions, execution status,
elapsed observations and hashes of the actual final inputs in each trial.
Prepared installations and raw agent session logs are not included. The reports
refer to their original trial directories; shared input bytes are stored once here.

## Verify

```sh
node --test tests/adapt-local-evidence.test.mjs
```

The verifier checks exact input transformations, per-field values, identities,
hashes, exit codes, portability results and assistant judgments. It requires
completed assistant execution records and reports. Report interpretation was
reviewed separately. This test does not rerun the assistants or independently
attest their complete tool history.

This is local comparison evidence. It performs no upstream merge, protection,
ConfigHub change, Kubernetes delivery or live observation. The historical
Prometheus preservation proof remains a different receipt with a different scope.
Neither this task nor its passing verifier demonstrates that the application runs.

See [the Adapt task](../../tasks/adapt-local.md) for the direct route and existing
protected-upgrade continuation. A fresh managed upgrade and independent human
handoff remain separate acceptance work.
