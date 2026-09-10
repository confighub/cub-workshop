# Local assistant acceptance exercise

Claude Code 2.1.227 and Codex CLI 0.153.4 completed the same retained task against
cub v0.4.4 and Workshop source `59a19a2a7fcfa8b3346693418a1f43ba340ef885`
(plugin 0.6.14). Both processes exited 0. The trials used the tools' default model
selection; this receipt makes no claim about a pinned model or reproducibility
of model reasoning.

Each started in a separate prepared local directory with an isolated CUB_CONFIG,
a plugin source copy, the installed README, and task.txt. Installation/setup was
not timed. Task execution took 110.66 seconds for Claude Code and 102.78 seconds
for Codex. These are single observations, not a performance comparison. Claude
Code ran in safe mode with a three-dollar request budget; Codex used an ephemeral
workspace-write session without the user configuration. Neither was asked to
contact a cluster, deploy, publish, or access credentials.

The first trial wording left the refusal copy's starting point ambiguous: the
agents produced the same accepted change but started the incompatible copy from
different replica counts. The retained task explicitly copies the changed
workspace. Both agents were rerun in fresh directories; this evidence is from
those second runs. The first runs are not counted as identity agreement.

## Evidence and verification

- task.txt and execution.json retain the task, its hash, versions, process exit
  codes and task timings.
- baseline.yaml.gz retains the shared baseline render.
- Each agent directory retains its baseline, changed and refused JSON results,
  the incompatible app source, and its own report.
- `node --test tests/assistant-local-evidence.test.mjs` independently rebuilds
  the candidate bytes from the baseline, changes only shop-web replicas 3 to 2,
  then only the ExternalSecret API to unserved v1beta1. It checks all three
  hashes, source agreement, verdicts, findings and not-checked target scope.

Both agents preserved the baseline, made the one-field edit, and retained the
incompatible resource with `certified: false`. Both reports explicitly deny an
application-running claim and identify missing target prerequisites.

The [shared task and CLI demonstration](../../tasks/compose-local.md) uses the
same local outcome. No new source receipt, registry publication, GitOps binding,
cluster readiness, application response, upstream-refresh proof or independent
human handoff is established by this trial. The original bounded fixture contains
no GitOps controller. Repeat the acceptance exercise for the final reviewed
GitOps selection and target-aware workflow before calling the broader plan done.
