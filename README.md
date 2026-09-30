# cub-workshop

The ConfigHub Workshop noun family as a real cub plugin. Four commands, one per noun,
each speaking the settled verbs:

```bash
cub plugin install confighub/cub-workshop
# already installed? cub plugin upgrade workshop
# tracking main instead: add --source-repo; from a local clone: cub plugin install /path/to/cub-workshop
```

To pin a version, install its release tag, such as
`cub plugin install confighub/cub-workshop@v0.6.54`.

Requires `node`, `oras`, and `cub` on the PATH, on Linux or macOS (Windows is not
supported). CI tests Node 22, the current LTS; Node 25 can hang when a command exits, so
prefer Node 22. The plugin is tested with cub 0.6.8. Some commands need more: `helm`
for `cub config values`, `cub kubara` v0.2.3 or later (`cub plugin install
confighub/kubara-confighub`) and `helm` for `cub stack from-kubara`, `cosign` only for `--sign` and
`--key`, and `flux` with its schema plugin for the optional schema check. A command
that needs a tool you do not have stops and names it. Without `node` the shell
reports `env: node: No such file or directory`; install Node and run the command again.

### Try it first (no account, no cluster, under a minute)

```bash
cub config check redis                       # what a chart installs, before you install it
cub app check shop-web                       # which platform services a workload needs
cub stack sandbox shop-platform              # check a whole platform and render it
cub config examples 'how do I start'         # a worked example to follow next
```

Commands that change ConfigHub (`upload --run`, `fleet up`) need an account: run
`cub auth login` first. Everything above, and most of this page, does not.
[DEMO.md](./DEMO.md) walks the whole ladder in ten minutes, copy-paste.
[Check proposed platform edits in CI](./examples/stack-ci/README.md) with the
same static checker a person or agent runs locally.

Maintainers can manually dispatch `.github/workflows/release.yml` on `main`.
It runs the full checks, packages the committed tree, uploads the artifacts, and
creates a draft GitHub release; publishing the draft remains a separate review step.
The installed plugin still requires `node`, `oras`, `cub`, and Helm where the
selected command needs them.

## Find a worked example

The [public example index](https://github.com/confighub/examples/tree/main/catalog)
links to the maintained guide for a task. This checkout carries a reviewed,
pinned snapshot for offline discovery:

```sh
cub config examples 'what an app looks like'
cub config examples 'existing chart values'
cub config examples 'review an existing Argo app' --json
```

The first-app tutorial follows source files into a flattened manifest, then
shows the proposed managed configuration and delivery boundary with a local edit.
It gives a person and an AI assistant the same path. Each result names its
first useful artifact, stop condition, source, and proof limits. Open the guide
at the pinned URL before running its steps. The command reads local JSON only
and never executes a linked command. `--all` includes clearly labelled research
candidates that the default view omits. The exact snapshot revision and hash
are in [`catalog/source.json`](./catalog/source.json). `cub config list --role`
remains the separate catalog of chart candidates.

## Find the values that did nothing

Helm accepts a values file without checking it against the chart. A key that is
misspelled, out of date, or written from memory for a different chart is ignored, and
the install succeeds.

```bash
cub config values oci://registry-1.docker.io/cloudpirates/redis --version 0.34.11 \
  --values "$(cub config path)/examples/values/redis-values.yaml"
```

That sample file sets one value of each kind; point `--values` at your own file next.
Each value you set gets one verdict. `APPLIED` names the objects it changed. `IGNORED`
means the chart has no such key. It may list up to three advisory, fully qualified
keys declared by the chart's source values or schema; review them before changing
your values, because Cub never applies a replacement. `NO EFFECT` is a real key that another setting
switches off. `DEFAULT` is what the chart already uses. `NOT CHECKED` means the value was
not tested because the render limit ran out first; it is not a finding about the value.
The chart is rendered with your values, then once more for each value with that one
value taken out, so the verdict follows the rendered objects and not a guess. Generated
passwords and checksums are found first and left out of every comparison. `--json` gives
the report as data, `--exit-code` fails when a value did nothing or was not checked,
and no value is ever printed.

`--max-renders N` sets how many renders the check may spend. The default is 60. A value
past the limit reads `NOT CHECKED`, and the report names the number that would check
them all:

```bash
cub config values ./your-chart --values your-values.yaml --max-renders 200 --exit-code
```

The report also inventories literal `lookup` calls in the chart source, including
packaged dependencies where they can be read within fixed limits. It never evaluates a
template expression or queries a target cluster, so a listed callsite is not evidence
that the lookup ran.

An `APPLIED` value can still render an invalid container resource field, such as
`resources.limit` instead of `resources.limits`; that is reported separately as
`INVALID`. `--exit-code` also fails for those findings. This check covers container
resource field names only, not the full Kubernetes schema or cluster admission.

To keep a redacted diagnosis for review, save each attempt under a fresh name:

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
on every render, such as a generated password, is named too, because Argo CD and offline
`helm template` render without your target cluster, so a generated value may change every
time. A Flux HelmRelease runs Helm against its target cluster, where chart lookups can
observe existing values; whether that preserves a generated value depends on the chart.

`cub config check` names every image tagged `latest` or not tagged at all, since the
same name can pull different bytes later. With `--images` it also asks each image's own
registry, anonymously, whether that image can be pulled at all. A tag that has been
withdrawn, such as a versioned Bitnami image, reports `NOT FOUND` before you install
the chart and watch the pods fail. This is the one part of `check` that needs a network.
Use `--images --exit-code` in CI: exit 1 means at least one registry confirmed an image
is missing, and exit 2 means an authentication or network failure left an anonymous
check incomplete. The latter is not reported as missing. A strict check writes no
`--out` file or OCI bundle unless every image is verified to pull anonymously.

It also names the bytes. An image already pinned by digest reads `pinned`, and one named
by a tag reads `resolves … -> sha256:…`, which is the digest that name answers to right
now. Pin with `name@digest` and you keep the bytes you checked.

## Check configuration you already have

```sh
cub config check "$(cub config path)/examples/adapt/prometheus-before.yaml"   # a shipped sample
cub config check ./rendered.yaml --out ./retained.yaml   # your own rendered YAML
cub app check ./my-app.yaml                              # your own workload
```

Local YAML or JSON files can be outside the plugin installation. The check reads
named Kubernetes objects and refuses empty or partly invalid documents. A local
`--out` copy preserves the original bytes. These inspections summarize resources
and recognized dependencies; they do not prove target compatibility or that a
workload runs. Keep the source version and your authored values or edits when
bringing a new upstream render; this command does not merge upstream changes.
A failure names its cause, such as the limit that was exceeded, the file that could
not be read or the tool that is missing, instead of a generic line. YAML syntax detail
and fetch URLs stay withheld, because either can quote a Secret or a credential.

## Inspect a local configuration edit

`cub config diff before.yaml after.yaml --json --out diff.json` reports changed
objects and fields and retains both input hashes. For a concise inventory view across
a large rename, add `--summary`:

```bash
cub config diff before.yaml after.yaml --summary
```

It groups objects by API version and kind, with before and after counts plus their
delta. It is an inventory aid only: equal counts do not establish matching objects or
behavior. `--summary --json` keeps the full object and field changes and adds the
deterministic `kindSummary` array. It performs no merge, upload or deployment. [Try the Adapt task](./tasks/adapt-local.md), then follow the existing
Catalog evidence for preserving a protected edit through an upstream upgrade.

## Review an app Argo CD already reconciles

To map an existing Argo application, choose a child when the selected app is an
app-of-apps, export Argo's desired manifests at two revisions, and save the
object-level review without changing Argo. [Try the Argo review task](./tasks/adopt-existing-argo-app.md).

## Review an app Flux already reconciles

Trace an existing Flux-owned workload, build a Kustomization from two pinned
local checkouts, and retain an object-level review while Flux stays in control.
[Try the Flux review task](./tasks/adopt-existing-flux-app.md).

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

A platform stack, whose components carry per-cluster variants, publishes every
cluster's variant by digest. `publish` checks the bases and then each cluster's
composition, as `check --cluster` would, and refuses before it pushes anything if one
cluster does not check out; each cluster's verdict is attached with the manifest.

A component named only by `bundle: oci://…@sha256:…` needs no local receipt when
one is attached in the registry; the resolver discovers it. A published index is a
stack you can check or sandbox by digest: `cub stack check oci://…@sha256:<index>`.
Add `--sign cosign.key` to any publish and `--key cosign.pub` to verify. Without a
key, `cub config verify` still looks in the registry and says which of three things is
true: a signature is attached but was not checked, no signature is attached, or the
registry did not answer, so presence is unknown. Only `--key` can make it a pass, and
with `--key` an attached signature that does not verify, or none at all, fails. Presence
is not trust: an attached signature proves nothing until a key you trust verifies it.
The shipped stacks name their
components as images: the nine renders are published as bundles with receipts whose bytes
ship in `cache/` keyed by digest, so the check works offline and still hash-verifies
every file against the receipt in `receipts/workshop/`. `scripts/seed-cache.mjs`
rebuilds that from `renders/`, and the same script pushes the same digests to the
public registry. Registries on
localhost are spoken to over plain HTTP, so `docker run -d -p 5001:5000 registry:2`
is enough to try all of this. The design note is
[`docs/planning/oci-design-center.md`](https://github.com/confighub/helm-expt/blob/main/docs/planning/oci-design-center.md)
in the helm-expt repository.

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
cub stack compose --entry prometheus-community-prometheus-29-9-0-default \
  --entry grafana-promtail-6-17-1-default --name platform --out ./platform  # save a catalog selection

cub fleet list
cub fleet plan meridian               # the expanded placements, a whole stack per line if you place one
```

Published catalog profiles may bind a separately published rendered source with
`flattened.bundleSourcePath`; omitted values keep the chart/version/base path.

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

`cub stack schema` prints the JSON Schema of the manifest this installed version
reads. Give it to an assistant that writes a manifest, or validate one before you
run `check`. It reads a file in the plugin and contacts nothing:

```bash
cub stack schema > stack-manifest.schema.json
```

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
cub stack upload shop-platform            # the plan, no changes; add --run to upload the base Spaces
cub stack upload shop-platform --run      # base Spaces for a composition that checked out
cub fleet up meridian                     # scaffold clusters, upload bases, place and release everything
                                          # a placement may name a whole stack: `stack: web-platform`
cub fleet age meridian                    # replay the declared operations so real attention states exist
cub fleet status meridian                 # the four attention tiles, recomputed from fleet queries
cub fleet rollout meridian external-dns   # the next wave's ChangeOrder; dry run unless --run
cub fleet down meridian                   # delete what up and age created; stops on any failure
```

From there the generic cub verbs continue the ladder: `cub release publish`,
`cub variant promote`, gates and ChangeOrders for governance.

## Turn a Kubara platform into one stack

If a Kubara platform already exists, its own output becomes a stack. After
`kubara ... generate --helm`, point `from-kubara` at the work directory:

```bash
cub stack from-kubara ./my-kubara --app shop-web-kubara
cub stack check ./my-kubara/confighub/stack.yaml
```

The whole platform is one stack. Each service is one component, and each cluster in
Kubara's `config.yaml` that enables it is a variant of that component. The base is the
hub's render where the hub runs the service, and otherwise the first cluster's.
`from-kubara` renders nothing itself. It runs `cub kubara render` from
[kubara-confighub](https://github.com/confighub/kubara-confighub), the one renderer of a
Kubara platform as Kubara delivers it, and assembles the stack from what that writes.
Each service is rendered the way Kubara's hub ApplicationSets deliver it: their release
name and namespace, their values files in their order, and only the services that
cluster enables, plus Argo CD on a hub. `bootstrap-crds` contributes its CRDs alone.
An object two services render, such as a CRD a chart also carries, is kept once, with
the owner the render names (`bootstrap-crds` for those CRDs), so each object has one
owner. `--app` adds a shipped app as a workload component, and `--out` changes the
output directory, which defaults to `confighub/` in the work directory. The render stays
beside the stack in `kubara-render/`, whose `render.json` records each service's
chart, values files and digest.

A Secret reaches the stack with its keys and without its values: a stack is published
and uploaded, and a chart can make up a credential when it renders. `from-kubara`
names each Secret it emptied; the values belong in each cluster's secret store.

It needs `cub kubara` v0.2.3 or later and `helm`; without them it stops and says how to
install them (`cub plugin install confighub/kubara-confighub`). If a chart's dependencies
are not already under `charts/`, the render fetches them, which needs network access.
What it writes is a composition. It does not create an Argo CD Application, contact a cluster or show
that Kubara would sync it.

To read one cluster's platform, narrow with `--cluster`. On `from-kubara` it writes
a stack for that cluster alone. On `check`, `sandbox` and `upload` it reads any stack
whose components carry per-cluster variants as that cluster runs it: each variant
stands in for its base, and a component the cluster does not run drops out. A cluster
the stack does not name is refused, and the error lists the ones it does.

```bash
cub stack check ./my-kubara/confighub/stack.yaml --cluster prod
cub stack sandbox ./my-kubara/confighub/stack.yaml --cluster prod --out prod.yaml
```

A fleet manifest may place the stack by path (`stack: ./confighub/stack.yaml`).

## Upload a stack, and rerun it

`cub stack upload` prints a plan and changes nothing. Add `--run` to execute it.

```bash
cub stack upload ./my-kubara/confighub/stack.yaml --space-prefix acme
cub stack upload ./my-kubara/confighub/stack.yaml --space-prefix acme --run
```

Each run issues every upload. An upload is create-or-update, so a run that stopped
for a network or quota error is resumed by running the same command again: what
landed is re-read unchanged, and a manifest whose digest or render moved updates its
base. A variant that was already cloned is reported as such. A failure stops the run
and prints what was uploaded, what was not, and the command to rerun.

`--space-prefix` keeps one stack's Spaces apart from another's in a shared
organization. A base Space is named `<prefix>-<component>` instead of
`<component>-base`, and a cluster's variant `<prefix>-<component>-<cluster>`. The prefix
takes lowercase letters, digits and dashes. `--cluster` uploads only that cluster's
variants of the components it runs.

After the bases are up, the upload links each declared binding to the profile, which is
the stack's one hub-plane component. A path binding writes the profile's value to the
path the binding names. An env binding sets the container's variable by name, so a chart
that reorders its env list cannot redirect the write. There is one link per downstream
Unit, and each follows the profile: change a value in the profile and the linked Units
take it, and a later promote or re-upload leaves it in place. The upload resolves each
linked Unit at once, so the values are there when it ends. A rerun updates the links it
finds, so a binding added to the manifest later reaches a stack linked before it. A
binding that cannot be linked is listed as `Not linked` with its reason, such as a
missing Unit or two resources that would share one. The dry run prints the link and
resolve commands.

A component that defines one object twice is refused before anything is uploaded:
`kubectl apply` keeps the last copy, but `cub variant upload` refuses the component.
`cub stack check` warns about it.

## Roll a component out in waves

A fleet placement may name the phases it rolls out through. Each cluster it lands on
carries one as a label, and `cub fleet rollout` opens one ChangeOrder per phase, in order:

```yaml
clusters:
  - {name: eu-north-dev1, labels: {phase: canary}}
placements:
  - {app: external-dns, clusters: ["*"], waves: [canary, secondary, primary]}
```

```bash
cub fleet rollout meridian external-dns          # dry run: the next wave's ChangeOrder
cub fleet rollout meridian external-dns --run    # open it
cub fleet status meridian                        # adds "Rollouts by wave"
```

The ChangeOrder for a wave is `<component>-rollout-<wave>`, opened on the component's
base and scoped to the deployment Spaces of the clusters in that phase. The next wave is
refused while an earlier wave's ChangeOrder is still open or was aborted, because a
canary that has not finished is no evidence for the wider waves. `--where` names the
Units the rollout change is stamped on. Every cluster a waved placement lands on needs
a phase, and every wave must be the phase of some cluster; otherwise the fleet does not
load. `fleet status` adds the number of Spaces each opened wave takes in, and which waves
are still open. Opening a wave does not promote anything: the change still moves
through the generic `cub` verbs.

A placement may also name a published stack by its index digest, so a fleet places
exactly what was checked and published. A tag is refused, because a tag can move:

```yaml
placements:
  - stack: oci://registry.example.com/team/shop-platform@sha256:<index digest>
    clusters: ["*"]
```

`oras resolve` prints the digest a tag points at. The index's components are placed as
the bundles it pins. `cub fleet list` never contacts a registry, so it counts such a
stack apart; `cub fleet plan` resolves it.

Fleet commands stop rather than guess. `cub fleet up` creates a Space only when the CLI
says explicitly that it does not exist, so an authentication, permission or network
failure stops it. `spec.owner` labels the cluster Spaces, and the fleet's name is the
owner when it is absent. If `up` stops part way, inspect the steps that completed before
you retry it; a rerun skips what exists. `cub fleet down` deletes only what `up` and
`age` created, including the ChangeOrders they opened, and keeps a shared base while
another fleet's variant still uses it. Something already gone counts as absent, and any
other failure stops the teardown and says how many Spaces it removed. Run it again once
the cause is fixed.

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
For a receipt-bound bundle, it also preserves required lifecycle route evidence under
`evidence/`. Those routes are `declared-unexecuted`: keep the whole directory when
handing it over, and do not read the saved files as a delivery or readiness result.

A route workspace may append a new uniquely named `authored` component and save a
new workspace. Its original materialized manifest remains hashed evidence: do not
rename, remove, reorder, or alter its existing component sources, name, or bindings.
The preserved receipt and routes do not prove the added application or its runtime.

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

## Select Kubara with an Argo CD controller

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

`--json` takes one more flag, `--cluster <name>`, for a stack that carries per-cluster
variants. The result also includes a `schemaValidation` record when the schema check
below ran.

Claude Code, Codex and other consumers should use `checked` and the scope fields
for control flow, preserve warnings and findings for review, and retain the result
when handing work to another person. Do not infer deployment approval or a healthy
application from a static result. Run the same command without `--json` for human
output; both forms run the same check.

## Inspect target prerequisites before delivery

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

The Kubara shop fixture explicitly starts a digest-pinned HTTP hostname server
on port 8080 and has an HTTP readiness probe. Its [local container receipt](proofs/shop-http-2026-09-09/README.md)
proves a response from that image and command only; Kubernetes, ingress, issuer,
secret-store and release observations still need the named target.

## Validate the delivered objects against their schemas

`cub stack check` and `cub stack sandbox` add one line to the verdict: every object
a cluster would receive is validated against its API schema, including its CEL
rules, by the Flux schema plugin. That catches a wrong field type or an unknown field
before an apply would. It needs `flux` 2.9 or later and the plugin, and it fetches the
schema catalogs over HTTPS:

```bash
flux plugin install schema
cub stack check kubara-shop-platform
```

```
  [PASS] schema validation: <n> object(s) valid against the default and ecosystem catalogs (flux-schema)
```

Only a violation the plugin reports refuses the stack, and the check names the object,
path and message of the first eight; `--json` carries all of them. If `flux` or its
plugin is missing, the check times out, or the plugin fails, the line is a `WARN` and the
verdict is unchanged, so a stack can read `CHECKED` without ever having been validated.
Read the line. A catalog that cannot be reached is a `NOTE`. Hub-plane components are
held in ConfigHub and never applied, so they are not validated, and objects without a
catalog schema are skipped and counted. The catalogs track the latest stable APIs, so a
pass says nothing about the Kubernetes version of your target. `publish` and `upload`
repeat the composition checks but not this one.

## What ships in the plugin

- `renders/` — nine verified chart renders from the public catalog, the config catalog.
- `apps/` — authored workloads: the teaching apps (`hello-standalone`, `shop-web`
  and its Kubara adaptation `shop-web-kubara`), the services the meridian fleet
  places, and the pair `conflict-demo` uses. `cub app list` names them all.
- `stacks/` — stack manifests, listed by `cub stack list`. Their components are
  digest-pinned images with receipts, or small authored files. The bytes of the nine
  renders ship in `cache/`; the other bundles are pulled by `oras` and hash-verified
  against `receipts/`. `metrics-double` and `conflict-demo` are refused on purpose.
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

