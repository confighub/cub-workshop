# Review an existing Argo CD app without changing its reconciler

Use this task when an application already runs under Argo CD and you need to
understand its scope, review an intended revision, and leave Argo in control.
It creates local review files only. It does not import, sync, disable, delete,
connect, or change the Application.

## Inputs and outcome

Choose an Argo CD Application and namespace, an Argo CLI context, and two exact
Git commits or chart versions: a selected baseline and a candidate. Record the
export hashes too: chart versions and tags alone do not establish immutable content.
The result is a Scout ownership/topology preview, two Argo-rendered desired
manifest files, and `review.json` with every desired-object change. Keep the
files with the pull request or change review.

`KUBECONFIG` names a kubeconfig file, whose current context Scout reads.
`argocd` uses its own `--argocd-context`. Set both deliberately. They can
describe the same cluster, but their context names and credentials are separate.

```sh
set -eu
umask 077
export KUBECONFIG=/path/to/cluster.kubeconfig
APP=payments
ARGO_NAMESPACE=argocd
APP_REF="$ARGO_NAMESPACE/$APP"
ARGO_CONTEXT=production-argo
BASE_REV='replace-with-exact-current-commit-or-chart-version'
CANDIDATE_REV='replace-with-exact-candidate-commit-or-chart-version'
kubectl config current-context
mkdir argo-review
cd argo-review
```

Replace the example application, paths, contexts and revisions before running the commands. `mkdir` must
make a fresh review directory; do not reuse files from an earlier review.

## Discover the right Application

Start with the read-only Scout proposal:

```sh
cub-scout import argocd "$APP" --argocd-namespace "$ARGO_NAMESPACE" --dry-run
```

Read its source, destination, status, and managed-resource summary. If it says
the selected Application is an app-of-apps, it orchestrates child Application
CRs: choose one named child Application and rerun the command for that child.
Set `APP` and `ARGO_NAMESPACE` to that child’s name and namespace, then reset
`APP_REF="$ARGO_NAMESPACE/$APP"` and rerun the preview.
Do not review or retain the root as though it were the workload. Scout's dry
run reads a **live snapshot** of tracked resources; it is useful for scope and
ownership, not the desired source of truth.

Do not redirect `--show-yaml` into a manifest file: it deliberately includes
human-readable headings and summary text. Do not run Scout with `--disable-sync`,
`--delete-app`, `--connect`, or either test flag in this task.

## Export desired state and review it

Capture the Application definition for source and destination evidence, then
ask Argo to render each selected revision. `--source git` means the desired
configuration Argo obtains from its source, rather than live Kubernetes state.
`APP_REF` is Argo's documented `namespace/name` application identity, so both
commands address the same Application. These exports use the current Application
settings with the selected revisions; they do not reconstruct historical deployment state.

```sh
argocd --argocd-context "$ARGO_CONTEXT" app get "$APP_REF" -o json > application.json
```

Inspect the saved source and destination before exporting. This sequence is for a
single-source Application. If `spec.sources` lists multiple sources, stop and
select their revisions explicitly instead of using this single-revision sequence.

```sh
argocd --argocd-context "$ARGO_CONTEXT" app manifests "$APP_REF" \
  --source git --revision "$BASE_REV" > before.yaml
argocd --argocd-context "$ARGO_CONTEXT" app manifests "$APP_REF" \
  --source git --revision "$CANDIDATE_REV" > candidate.yaml

cub config check before.yaml
cub config check candidate.yaml
cub config diff before.yaml candidate.yaml --json --out review.json
```

Review `review.json`: it identifies additions, removals, changed objects and
changed fields while retaining hashes of both inputs. If `equal` is true, keep
the unchanged review rather than inventing a change. If either Argo export or
Workshop check fails, keep its error and stop; do not substitute live YAML,
repair the output, or claim a candidate was reviewed. Multi-source Applications
need an explicit Argo source/revision selection before this task proceeds.

`cub config check` and `cub config diff` inspect local files. They do not prove
schema admission, target readiness, sync, drift, or application health.

## Offline rehearsal

From this Workshop checkout, the retained Prometheus Deployment excerpt checks
the local half of this task without an Argo server or cluster:

```sh
mkdir local-argo-review
cub config check examples/adapt/prometheus-before.yaml
cub config diff examples/adapt/prometheus-before.yaml \
  examples/adapt/prometheus-before.yaml --json \
  --out local-argo-review/unchanged.json
```

The saved result must report `equal: true`. This is a synthetic unchanged
review of one excerpt; it does not exercise Argo discovery, rendering, or
delivery.

## Optional later step

After a separate authorization to preserve or share reviewed configuration in
ConfigHub, begin with the existing
[managed continuation boundary](./adapt-local.md#continue-with-the-existing-protected-upgrade-capability)
when its documented scope fits. It is separate from this task. Do not treat
Scout's live import as the desired-manifest record, and do not hand Argo
reconciliation to ConfigHub as part of this review.

## Same task for an assistant

Give an assistant the chosen inputs and ask it to run this task, retain
`application.json`, `before.yaml`, `candidate.yaml`, and `review.json`, report
the root-or-child decision and source/destination, and list every changed
object and field. It must stop on an export or check failure and state the
local-review limits above. It must not invoke any non-dry-run import, Argo sync,
or controller cleanup command.

Argo documents the namespace-qualified application name in its
[Applications in any namespace guide](https://argo-cd.readthedocs.io/en/stable/operator-manual/app-any-namespace/#application-names).
