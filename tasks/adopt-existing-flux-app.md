# Review an existing Flux app without changing its reconciler

Use this task when Flux already reconciles an application and you need to map
its ownership, review a Kustomization change, and leave Flux in control. It
creates private local review files only. It does not import, reconcile, suspend,
delete, connect, or change a Flux object.

## Inputs and outcome

Choose a workload kind/name/namespace, Flux Kustomization name/namespace, and
two disposable local copies of source revisions: a pinned baseline and candidate.
Each must already contain the Kustomization path's `kustomization.yaml`. The
result is an ownership trace, optional import preview, two local builds, and an
object-level diff. It is review evidence, not a claim about a running cluster.

```sh
set -eu
umask 077
export KUBECONFIG=/path/to/cluster.kubeconfig
KIND=deployment
NAME=payments
NAMESPACE=payments
KUSTOMIZATION=payments
FLUX_NAMESPACE=flux-system
BASE_CHECKOUT=/private/path/to/disposable-baseline-copy
CANDIDATE_CHECKOUT=/private/path/to/disposable-candidate-copy
MANIFEST_PATH=./clusters/production/payments
KUSTOMIZATION_FILE=./clusters/production/payments-kustomization.yaml
REVIEW_DIR="$(mktemp -d "${TMPDIR:-/tmp}/flux-review.XXXXXX")"
test -f "$BASE_CHECKOUT/$MANIFEST_PATH/kustomization.yaml"
test -f "$CANDIDATE_CHECKOUT/$MANIFEST_PATH/kustomization.yaml"
cd "$REVIEW_DIR"
```

Replace every placeholder. `REVIEW_DIR` must be fresh and private; retain it
with the change review. If an export or check fails, retain its error and stop.
Do not inspect a partial output or replace it with live YAML.

## Map the live ownership chain

Scout reads the current cluster only to identify how the selected workload is
owned and delivered:

```sh
cub-scout trace "$KIND/$NAME" -n "$NAMESPACE" --format json > ownership.json
cub-scout import -n "$NAMESPACE" --resource "$KIND/$NAME" --dry-run --json > import-preview.json
```

Read `ownership.json` for the Flux controller, source and revision chain. The
second command is optional and limited to the selected workload. Its dry run is
a **live snapshot** for scope and ownership, not desired-source truth and not
an import authorization. Do not run it without `--dry-run`, or add `--connect`
or `--yes` in this task.

## Build the intended Kustomization revisions

`flux build kustomization` builds the pinned local copies using the local Flux
Kustomization file. The file checks prevent it from generating a
`kustomization.yaml` in either copy. It does not fetch the Flux source artifact, mutate the
cluster, or perform a reconciliation in `--dry-run` mode. Pin any remote bases
referenced by the local build as well.

```sh
flux build kustomization "$KUSTOMIZATION" \
  -n "$FLUX_NAMESPACE" \
  --path "$BASE_CHECKOUT/$MANIFEST_PATH" \
  --kustomization-file "$BASE_CHECKOUT/$KUSTOMIZATION_FILE" \
  --dry-run > before.yaml
flux build kustomization "$KUSTOMIZATION" \
  -n "$FLUX_NAMESPACE" \
  --path "$CANDIDATE_CHECKOUT/$MANIFEST_PATH" \
  --kustomization-file "$CANDIDATE_CHECKOUT/$KUSTOMIZATION_FILE" \
  --dry-run > candidate.yaml

cub config check before.yaml
cub config check candidate.yaml
cub config diff before.yaml candidate.yaml --json --out review.json
```

Review `review.json` for additions, removals, changed objects and fields. An
`equal: true` result is a valid unchanged review. `cub config check` and `diff`
inspect local YAML; they do not prove admission, target readiness, live drift,
health, or reconciliation.

Flux documents that dry-run skips post-build substitutions supplied by Secrets
and ConfigMaps. It cannot establish controller-side source retrieval, decryption,
cluster API behavior, or other controller processing. Record those inputs and
qualify the review; do not call this controller-exact parity.

## HelmRelease route

A HelmRelease CR is not a rendered workload, and `flux build` does not render
it. Inspect the selected HelmRelease first. Resolve its namespace, release name,
target namespace, storage namespace and selected revision from the object and
`helm history`; resolve the chart's artifact version, not a version range. For a
separate, read-only values review, export complete effective values privately;
this may expose Secret values:

```sh
HELMRELEASE=payments
HR_NAMESPACE=flux-system
RELEASE_NAME=replace-with-spec-releaseName-or-controller-default
TARGET_NAMESPACE=replace-with-spec-targetNamespace-or-controller-default
STORAGE_NAMESPACE=replace-with-spec-storageNamespace-or-controller-default
RELEASE_REVISION=replace-with-a-revision-from-helm-history
CHART=oci://registry.example.com/team/payments
CHART_VERSION=replace-with-the-resolved-artifact-chart-version
flux debug helmrelease "$HELMRELEASE" -n "$HR_NAMESPACE" --show-values > effective-values.yaml
cub config values "$CHART" --version "$CHART_VERSION" --namespace "$TARGET_NAMESPACE" \
  --release "$RELEASE_NAME" --values effective-values.yaml \
  --out values-diagnosis.json --render-out values-candidate.yaml
helm get manifest "$RELEASE_NAME" -n "$STORAGE_NAMESPACE" --revision "$RELEASE_REVISION" > installed.yaml
shasum -a 256 effective-values.yaml values-candidate.yaml installed.yaml > inputs.sha256
```

Use the existing `cub config values` workflow to review the complete effective
values and its candidate. Retain `inputs.sha256`. `installed.yaml` is the
recorded Helm release manifest for that revision: it is an installed snapshot,
not desired source or live-object truth. The local render does not establish
Helm controller post-renderer, capabilities, decryption, or cluster parity.

## Offline rehearsal

Without a cluster, copy `examples/adapt/prometheus-before.yaml` into separate
`before/` and `candidate/` directories, each with a `kustomization.yaml` that
lists `prometheus.yaml`; change only candidate `spec.replicas` from 1 to 2.
Create a local Flux `Kustomization` named `prometheus-review`, then run the two
`flux build kustomization prometheus-review --path ... --kustomization-file ...
--dry-run` commands above and the two `cub config check` commands plus `diff`.
The expected result is one changed Deployment,
`monitoring/prometheus-server`, at `/spec/replicas`, from 1 to 2. This fixture
is synthetic: it tests the local build and review path, never discovery,
source retrieval, Secret substitution, or delivery.

## Same task for an assistant

Ask an assistant to retain the trace, optional preview, before and candidate
builds, and `review.json`; report the ownership chain and every object/field
change. It must stop on a failed command, never import without dry-run or run a
Flux mutation, and name the local-build limits. After separate authorization to
preserve a reviewed result in ConfigHub, use the existing protected continuation
from the [Adapt task](./adapt-local.md#continue-with-the-existing-protected-upgrade-capability).
