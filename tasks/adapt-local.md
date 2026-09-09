# Edit a configuration and inspect exactly what changed

This task requires the Workshop version that provides `cub config diff` (0.6.20).
It uses one Deployment excerpt from retained Prometheus chart 29.8.0. The excerpt
is for reviewing an edit, not a complete chart or standalone deployment. Its
provenance is in `examples/adapt/source.json`.

## Direct route

From this plugin checkout, with the plugin installed, create a fresh directory:

```sh
mkdir adapt-demo
cp examples/adapt/prometheus-before.yaml adapt-demo/before.yaml
cp adapt-demo/before.yaml adapt-demo/after.yaml
```

In `after.yaml`, change only `spec.replicas` from 1 to 2. Keep `before.yaml`
unchanged. Then:

```sh
cub config diff adapt-demo/before.yaml adapt-demo/after.yaml --json --out adapt-demo/diff.json
```

Expected: one changed object, Deployment `monitoring/prometheus-server`, and
one field change at `/spec/replicas`, from 1 to 2. The result retains hashes of
both files. It changes neither input and does not contact ConfigHub or Kubernetes.
Move the entire directory and rerun the diff: the content hashes and findings
should agree. Save to a different output name; existing outputs are not overwritten.

Normal exit 0 means comparison succeeded, even when differences exist. Add
`--exit-code` to return 1 when differences exist; malformed inputs and other
errors return 2. Both inputs must contain at least one named Kubernetes object.
Duplicate identities refuse. Differences in mapping order or YAML document order
do not count as edits; array order, null and missing values do. Array changes
are reported as whole values. No Kubernetes defaulting or schema interpretation
is performed.

## Assistant route

Give either assistant the before/after files and this task:

```text
Using cub config diff, inspect this local configuration edit and save diff.json.
Do not install, upload, deploy, contact a target, or change the before file.
Report each changed object and field from the tool output. If anything besides
Deployment monitoring/prometheus-server /spec/replicas changed from 1 to 2, stop
and report it rather than hiding or repairing the extra change. Explain the
limits: this is a local comparison, not an upstream merge or a live observation.
```

A saved diff is useful review evidence. It does not approve the edit, validate
Kubernetes schemas, protect a field or show that Prometheus runs.

## Continue with the existing protected-upgrade capability

The Catalog already has a real ConfigHub receipt for preserving this kind of
edit: [Prometheus upgrade preservation proof](https://github.com/confighub/helm-expt/blob/dd9d7f7c54b24e480e887c18447e1cee611192fc/data/prometheus-upgrade-preservation-proof/summary.md).
It records a protected two-replica edit surviving chart 29.8.0 to 29.9.0 and a
previewed staging promotion. It did not deliver to Kubernetes, and it does not
prove every field or chart.

That receipt is historical evidence, not the result of this local exercise.
The managed continuation needs an authorized organization, valid authentication,
reviewed sources and the current installer commands. Reuse its existing runner
and protected-field mechanism for a fresh qualified run; do not replace it with
an ad hoc file merge. In a Catalog checkout, the existing receipt can be verified
without repeating the managed run:

```sh
node scripts/run-prometheus-upgrade-preservation-proof.mjs --verify
```

The runner's `--run` mode changes ConfigHub records. It is not part of this local
demo. A fresh managed upgrade, assistant execution trial and independent human
handoff remain separate acceptance work.
