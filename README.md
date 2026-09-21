# cub-workshop

The ConfigHub Workshop noun family as a real cub plugin. Four commands, one per noun,
each speaking the settled verbs:

```bash
cub plugin install confighub/cub-workshop
# already installed? cub plugin upgrade workshop
# tracking main instead: add --source-repo; from a local clone: cub plugin install /path/to/cub-workshop
```

Requires `node`, `oras`, and `cub` on the PATH, and `helm` for `cub config values`.
[DEMO.md](./DEMO.md) walks the whole ladder in ten minutes, copy-paste.
[Check proposed platform edits in CI](./examples/stack-ci/README.md) with the
same static checker a person or agent runs locally.

## Find the values that did nothing

Helm accepts a values file without checking it against the chart. A key that is
misspelled, out of date, or written from memory for a different chart is ignored, and
the install succeeds.

```bash
cub config values oci://registry-1.docker.io/cloudpirates/redis --version 0.34.11 --values my-values.yaml
```

Each value you set gets one verdict. `APPLIED` names the objects it changed. `IGNORED`
means the chart has no such key, and says which key you may have meant or where the
chart does declare that setting. `NO EFFECT` is a real key that another setting
switches off. `DEFAULT` is what the chart already uses. The chart is rendered with your
values, then once more for each value with that one value taken out, so the verdict
follows the rendered objects and not a guess. Generated passwords and checksums are
found first and left out of every comparison. `--json` gives the report as data,
`--exit-code` fails when a value did nothing, and no value is ever printed. To keep a
redacted diagnosis for review, save each attempt under a fresh name:

```bash
cub config values ./chart --values before.yaml --out before-diagnosis.json --render-out before-candidate.yaml --exit-code
cub config values ./chart --values repaired.yaml --out repaired-diagnosis.json --render-out repaired-candidate.yaml --exit-code
```

Each result records hashes of the supplied values bytes and its rendered candidate,
plus the requested chart reference, version, repository, release and namespace. The
chart reference is what you requested, not a resolved chart digest. `--render-out`
saves the exact first candidate render named by that hash; it is useful with `--out`
when handing work to the next session. A render can contain Secrets, so the file is
created with local-only permissions and must stay private. The diagnosis does not
store rendered Kubernetes YAML or values contents.

For a static next-session review, retain the original values file privately elsewhere,
then check and compare the saved candidates:

```bash
cub config check ./repaired-candidate.yaml
cub config diff ./before-candidate.yaml ./repaired-candidate.yaml --out candidate-diff.json
```

These commands inspect only the saved manifests. They do not resolve a chart digest,
contact a cluster, or prove that either candidate will be accepted.

It also says what the chart does that you did not write. A resource preset in force,
such as Bitnami's `resourcesPreset: nano`, is named with the objects it sets CPU and
memory for. Setting your own resources replaces the whole preset. A field that changes
on every render, such as a generated password, is named too, because Argo CD, Flux and
`helm template` render without your cluster and get a new value every time.

`cub config check` names every image tagged `latest` or not tagged at all, since the
same name can pull different bytes later. With `--images` it also asks each image's own
registry, anonymously, whether that image can be pulled at all. A tag that has been
withdrawn, such as a versioned Bitnami image, reports `NOT FOUND` before you install
the chart and watch the pods fail. This is the one part of `check` that needs a network.

It also names the bytes. An image already pinned by digest reads `pinned`, and one named
by a tag reads `resolves … -> sha256:…`, which is the digest that name answers to right
now. Pin with `name@digest` and you keep the bytes you checked.

## Inspect a local configuration edit

`cub config diff before.yaml after.yaml --json --out diff.json` reports changed
objects and fields and retains both input hashes. It performs no merge, upload or
deployment. [Try the Adapt task](./tasks/adapt-local.md), then follow the existing
Catalog evidence for preserving a protected edit through an upstream upgrade.

## Compare a GPU workload with target facts

`cub app match model.yaml --target nodes.yaml --json --out match-result.json`
compares a KServe workload's declared selectors and GPU count against a supplied
Node snapshot. It saves candidate, mismatch or unknown findings without contacting
a cluster. A candidate is not scheduling or inference proof.
[Try the bounded example and refusal case](./examples/match/README.md).

## Check mounted Promtail destinations

`cub stack check` follows only configuration mounted by an identified Promtail
container. It reads mounted Secret and ConfigMap keys, including Secret
`stringData` and base64 `data`, then checks `clients[].url` service DNS against
Services carried by the same static composition. A short service name must resolve
in the Promtail namespace; an explicit `service.namespace` or `.svc` name must
match that namespace. Two-label names are ambiguous unless their target Namespace
is explicitly included. Missing Services, external endpoints, malformed URLs and
target readiness remain unknown. This is a static composition check and never
queries a cluster or prints URL paths or credentials.

## The design center: every result is an OCI image

Every verb can hand its result on as a bundle with its receipt: an OCI artifact of the
same type the ConfigHub Workshop catalog publishes, with the receipt attached to the
digest, so anyone can pull it and verify it. A stack publishes as an index of
those images with its manifest and verdict attached; the flattened stack is the
release form a reconciler pulls. One receipt links them.

```bash
cub config check redis --out oci://registry.example.com/team/redis:v1     # push a verified image, receipt attached
cub config verify oci://registry.example.com/team/redis@sha256:<digest>   # pull it back and re-hash it
cub app check shop-web --out oci://registry.example.com/team/shop-web:v1
cub stack sandbox shop-platform --out oci://registry.example.com/team/shop-platform:release   # the flattened release form
cub stack publish shop-platform --out oci://registry.example.com/team/shop-platform:v1        # the index of images, the catalog form
```

A component named only by `bundle: oci://…@sha256:…` needs no local receipt when
one is attached in the registry; the resolver discovers it. A published index is a
stack you can check or sandbox by digest: `cub stack check oci://…@sha256:<index>`.
Add `--sign cosign.key` to any publish and `--key cosign.pub` to verify; without a key,
verify says plainly that the signature was not checked. The shipped stacks name their
components as images: the nine renders are published as bundles with receipts whose bytes
ship in `cache/` keyed by digest, so the check works offline and still hash-verifies
every file against the receipt in `receipts/workshop/`. `scripts/seed-cache.mjs`
rebuilds that from `renders/`, and the same script pushes the same digests to the
public registry. Registries on
localhost are spoken to over plain HTTP, so `docker run -d -p 5001:5000 registry:2`
is enough to try all of this. The design note is
`docs/planning/oci-design-center.md` in the ConfigHub Workshop repository.

## The nouns

- **config** — one config, one chart. The smallest noun.
- **app** — a workload. Standalone, or needing a platform for its dependencies.
- **stack** — a composition of components, checked before anything runs.
- **fleet** — placement as data: which stacks and apps land on which clusters.
- **platform** — a stack put under governance (a role stacks reach, not a command).

## The verbs

Free, no account, no cluster:

```bash
cub config list
cub config list --role cache                  # discover catalog candidates for a platform role
cub config list --role metrics --json         # return stable candidate objects as JSON
cub config check redis                # render a chart, see what it installs and its lifecycle work
cub config values <chart> --values my-values.yaml   # which of the values you set did anything

cub app list
cub app check shop-web                # render a workload, learn which platform services it needs
cub app score shop-web                # export its workloads to Score (score.dev)

cub stack list
cub stack check metrics-double      # the composition alone; exits non-zero on a conflict
cub stack sandbox eks-inference       # check, then render the whole platform with no infrastructure
cub stack sandbox shop-platform --out shop-platform.yaml   # and write the rendered objects, in plane order
cub stack check ./my-stack.yaml     # your own manifest, anywhere on disk

cub fleet list
cub fleet plan meridian               # the expanded placements, a whole stack per line if you place one
```

`cub config list --role ROLE` reads the public catalog listing index and returns
every classified candidate for one of `cache`, `database`, `ingress`,
`certificates`, `metrics`, `logs`, `secrets`, `queue`, or `gpu`. Use
`--catalog-index FILE_OR_HTTPS_URL` to test against a local index. Discovery
labels describe a service, operator, or agent; they are candidates for review,
not runtime claims or an automatic selection. Inspect each full listing and its
evidence before choosing one.

For custom resources with a bundled CRD, the check reads the exact group,
kind and served API version. A declared but unserved version is refused before
sandbox output or publication. The Kubara shop example uses the served
`external-secrets.io/v1` API. These checks do not discover APIs on a target or
establish namespace, issuer, secret-store or application readiness.

Writing your own stack? Put a manifest anywhere and pass its path. Its `render:`
and `authored:` sources resolve relative to the manifest first, then to this plugin,
so it can name the nine shipped renders (`renders/argo-cd.yaml`, `cert-manager`,
`external-secrets`, `ingress-nginx`, `kube-prometheus-stack`, `metrics-server`,
`postgresql`, `rabbitmq`, `redis`) and put an app in the stack with
`authored: apps/<name>.yaml`. `stacks/shop-platform.yaml` was composed that way by
an assistant pointed at the ConfigHub Workshop site; the recorded run is in
`proofs/assistant-composition-2026-09-02/`.

Bringing your own chart? `cub config values <chart> --values my-values.yaml` checks
your values against any chart Helm can pull. The config catalog here is fixed to the
nine shipped renders, so to check what your chart installs, render it first: `helm template <chart> >
my-app.yaml`, then run `cub config check ./my-app.yaml` or `cub app check
./my-app.yaml`, or use the browser check on the ConfigHub Workshop site, which accepts any
rendered YAML without an account. Coming from Flux or Argo CD, nothing changes on
your side: every governed rung below publishes OCI your reconciler pulls as usual.

With an account (the governed rungs):

```bash
cub app upload hello-standalone --run     # one Unit per resource, release gated on review
cub stack upload eks-inference --run      # base Spaces and profile links for a composition that checked out
cub fleet up meridian                     # scaffold clusters, upload bases, place and release everything
                                          # a placement may name a whole stack: `stack: web-platform`
cub fleet age meridian                    # replay the declared operations so real attention states exist
cub fleet status meridian                 # the four attention tiles, recomputed from fleet queries
cub fleet down meridian                   # delete everything the manifest names
```

From there the generic cub verbs continue the ladder: `cub release publish`,
`cub variant promote`, gates and ChangeOrders for governance.

## Save, change and hand over a local stack

With workshop plugin 0.6.14 or newer, start with a checked editing copy, without
a cluster or ConfigHub account:

```bash
cub stack sandbox kubara-shop-platform --workspace ./my-platform
```

The directory must not already exist, and its parent must exist. The command checks
the composition before creating anything. It writes `stack.yaml`, separate files
under `components/`, the baseline `rendered.yaml`, and `result.json` with checks,
original component sources, file hashes and explicit not-checked target status.

For this example, edit only `spec.replicas` in the `shop-web` Deployment in
`my-platform/components/05-shop-web.yaml`, from `3` to `2`. Check and render the
candidate under new names:

```bash
cub stack check ./my-platform/stack.yaml --json > ./my-platform/changed-result.json &&
  cub stack sandbox ./my-platform/stack.yaml --out ./my-platform/changed.yaml &&
  git diff --no-index ./my-platform/rendered.yaml ./my-platform/changed.yaml
```

Run the render only after the check passes. The diff command exits 1 when it
finds a change; inspect that difference. The saved baseline should remain unchanged.
The new JSON result's `renderedFile.sha256` identifies the bytes in `changed.yaml`.
If the check refuses a change, repair its findings before rendering or sharing
that candidate as checked.

To resume tomorrow or hand over to someone else, keep the entire directory and run
the same check command against its `stack.yaml`. The saved component files are
materialized copies, so continuation does not need the original charts, plugin
sample data or registry. It still needs the plugin runtime. Component names,
planes, order, app roles and declared bindings are preserved; original source
references remain in the baseline result. Edits are new local configuration, not
updates to the original published bundles or their receipts.

An existing directory is never overwritten, even when empty. If creation is
interrupted before `stack.yaml` appears, keep the partial directory for inspection
and choose a new output directory. A complete saved directory is the resume point;
re-running the creation command against it is deliberately refused.

This example still needs target namespaces, an issuer and a secret store before
live use. No target has been checked, no application response has been observed,
and this local copy is not a published OCI artifact.

## Certification for assistants and automation

```bash
cub stack check web-tiny --json > result.json
cub stack check conflict-demo --json > refused.json
```

A completed check writes one `StackCertificationResult` JSON object to stdout.
Exit 0 means the composition passed the implemented checks; exit 1 with a JSON
result means it was refused. Execution or setup errors remain on stderr; an empty
stdout is not a check result. JSON mode is supported only for `check`.

The result includes `checked`, component counts and sources, the existing receipt
check fields (`result` and `text`), and `renderedFile` with the SHA-256 and size of
the exact bytes a sandbox would write. A rejected candidate also has a byte hash;
that hash does not make it approved or published. `scope` explicitly marks target
availability and application health as `not-checked`. No account or target is
contacted by the check; uncached bundle inputs may require registry access.

Claude Code, Codex and other consumers should use `checked` and the scope fields
for control flow, preserve warnings and findings for review, and retain the result
when handing work to another person. Do not infer deployment approval or a healthy
application from a static result. Run the same command without `--json` for human
output; both forms run the same check.

## What ships in the plugin

- `renders/` — nine verified chart renders from the public catalog, the config catalog.
- `apps/` — thirteen authored workloads: two teaching apps (`hello-standalone`,
  `shop-web`) and the eleven services the meridian fleet places.
- `stacks/` — twelve stack manifests: nine composed from the shipped renders, now named as images by digest with the bytes in `cache/`
  (including `metrics-double`, which the check rightly refuses), plus `eks-inference`
  and `kubara-platform` built from digest-pinned bundles with receipts pulled by `oras`
  and hash-verified against `receipts/`, and `conflict-demo`.
- `fleets/meridian.yaml` — ten regional clusters, twenty components, 125 placements,
  and the demo-aging operations that give the fleet real attention states.

Everything is a prototype of the proposed `cub <noun>` surface, packaged so it runs
as cub itself. The manifest formats (stack, fleet) are documented in the Config
Workshop repository's planning notes, and the receipts derive from the public
evidence in confighub/helm-expt at the pinned digests they name.

Maintenance rule: `receipts/` and `renders/` are copies of that public evidence.
When a chart re-renders or a bundle republishes upstream, refresh the copy and its
digest here in the same change — the resolver hash-verifies every bundle against
these receipts, so a stale copy fails loudly rather than drifting silently.

### Inspect target prerequisites before delivery

`cub stack check <stack> --json` includes a scoped `prerequisites` inventory.
It reports explicit namespaces, Certificate issuer references, ExternalSecret
store references and named Ingress classes. Each requirement identifies its
consuming component and field, whether its object is `bundled` or its target
availability is `unknown`, and the next action. Bundled means the object is
present in the materialized stack; it does not mean the controller is ready.

For `kubara-shop-platform`, the five namespaces, `ClusterIssuer/letsencrypt`
and `ClusterSecretStore/platform-store` need target verification. The Traefik
IngressClass is bundled. The human output warns about the unknown prerequisites;
the static check can still pass. No cluster is contacted. The inventory is
not exhaustive: credentials, storage, DNS, workload scheduling, implicit/default
namespaces, arbitrary resource references and application responses are outside
this check. Neither people nor assistants should use `checked: true` as a
permission or readiness signal for deployment.
### Check configuration you already have

```sh
cub config check ./rendered.yaml --out ./retained.yaml
cub app check ./my-app.yaml
```

Local YAML or JSON files can be outside the plugin installation. The check reads
named Kubernetes objects and refuses empty or partly invalid documents. A local
`--out` copy preserves the original bytes. These inspections summarize resources
and recognized dependencies; they do not prove target compatibility or that a
workload runs. Keep the source version and your authored values or edits when
bringing a new upstream render; this command does not merge upstream changes.
Fleet creation stops on authentication, permission or other lookup failures;
only the CLI's explicit missing-Space response permits creating that Space.
Errors keep the useful message instead of a trailing punctuation line. Inspect
any earlier completed steps before retrying a partially completed fleet operation.
The Kubara shop fixture explicitly starts a digest-pinned HTTP hostname server
on port 8080 and has an HTTP readiness probe. Its [local container receipt](proofs/shop-http-2026-09-09/README.md)
proves a response from that image and command only; Kubernetes, ingress, issuer,
secret-store and release observations still need the named target.

### Select Kubara with an Argo CD controller

```sh
cub stack sandbox kubara-gitops-shop --workspace ./gitops-platform
```

This named selection adds the retained, digest-pinned Argo CD bundle to all five
components of `kubara-shop-platform`. It preserves the existing app and its
requirements. Static composition contains 184 objects, including the Argo CD
application controller and Application CRD. It does not create an Application,
bind a repository or release, or establish a working GitOps loop.

Before delivery, verify the six namespaces (`argocd`, `cert-manager`,
`external-secrets`, `kube-system`, `shop`, `traefik`), issuer, secret store,
controller access and app prerequisites on the named target. Select and review
the GitOps source and destination separately. A controller render is not a
controller observation or an application response.
The [local CLI and assistant task](tasks/compose-local.md) gives the same save,
change and refusal exercise to a person, Claude Code or Codex. It is a bounded
local workflow, with live delivery and independent human trials still separate.
