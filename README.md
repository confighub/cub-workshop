# cub-workshop

The ConfigHub Workshop noun family as a real cub plugin. Four commands, one per noun,
each speaking the settled verbs:

```bash
cub plugin install confighub/cub-workshop
# already installed? cub plugin upgrade workshop
# tracking main instead: add --source-repo; from a local clone: cub plugin install /path/to/cub-workshop
```

Requires `node`, `oras`, and `cub` on the PATH. [DEMO.md](./DEMO.md) walks the whole
ladder in ten minutes, copy-paste.

## Inspect a local configuration edit

`cub config diff before.yaml after.yaml --json --out diff.json` reports changed
objects and fields and retains both input hashes. It performs no merge, upload or
deployment. [Try the Adapt task](./tasks/adapt-local.md), then follow the existing
Catalog evidence for preserving a protected edit through an upstream upgrade.

## The design center: every result is an OCI image

Every verb can hand its result on as a certified bundle: an OCI artifact of the
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
stack you can certify or sandbox by digest: `cub stack certify oci://…@sha256:<index>`.
Add `--sign cosign.key` to any publish and `--key cosign.pub` to verify; without a key,
verify says plainly that the signature was not checked. The shipped stacks name their
components as images: the nine renders are published as certified bundles whose bytes
ship in `cache/` keyed by digest, so certify works offline and still hash-verifies
every file against the receipt in `receipts/workshop/`. `scripts/seed-cache.mjs`
rebuilds that from `renders/`, and the same script pushes the same digests to the
public registry. Registries on
localhost are spoken to over plain HTTP, so `docker run -d -p 5001:5000 registry:2`
is enough to try all of this. The design note is
`docs/planning/oci-design-center.md` in the ConfigHub Workshop repository.

## The nouns

- **config** — one config, one chart. The smallest noun.
- **app** — a workload. Standalone, or needing a platform for its dependencies.
- **stack** — a certified composition of components, spoken by name.
- **fleet** — placement as data: which stacks and apps land on which clusters.
- **platform** — a stack put under governance (a role stacks reach, not a command).

## The verbs

Free, no account, no cluster:

```bash
cub config list
cub config check redis                # render a chart, see what it installs and its lifecycle work

cub app list
cub app check shop-web                # render a workload, learn which platform services it needs
cub app score shop-web                # export its workloads to Score (score.dev)

cub stack list
cub stack certify metrics-double      # the composition gate alone; exits non-zero on a conflict
cub stack sandbox eks-inference       # certify, then render the whole platform with no infrastructure
cub stack sandbox shop-platform --out shop-platform.yaml   # and write the rendered objects, in plane order
cub stack certify ./my-stack.yaml     # your own manifest, anywhere on disk

cub fleet list
cub fleet plan meridian               # the expanded placements, a whole stack per line if you place one
```

For custom resources with a bundled CRD, certification checks the exact group,
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

Bringing your own chart? The config catalog here is fixed to the nine shipped
renders, so render yours first and check the result: `helm template <chart> >
my-app.yaml`, then run `cub config check ./my-app.yaml` or `cub app check
./my-app.yaml`, or use the browser check on the ConfigHub Workshop site, which accepts any
rendered YAML without an account. Coming from Flux or Argo CD, nothing changes on
your side: every governed rung below publishes OCI your reconciler pulls as usual.

With an account (the governed rungs):

```bash
cub app upload hello-standalone --run     # one Unit per resource, release gated on review
cub stack upload eks-inference --run      # base Spaces and profile links for a certified composition
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
cub stack certify ./my-platform/stack.yaml --json > ./my-platform/changed-result.json &&
  cub stack sandbox ./my-platform/stack.yaml --out ./my-platform/changed.yaml &&
  git diff --no-index ./my-platform/rendered.yaml ./my-platform/changed.yaml
```

Run the render only after certification succeeds. The diff command exits 1 when it
finds a change; inspect that difference. The saved baseline should remain unchanged.
The new JSON result's `renderedFile.sha256` identifies the bytes in `changed.yaml`.
If certification refuses a change, repair its findings before rendering or sharing
that candidate as checked.

To resume tomorrow or hand over to someone else, keep the entire directory and run
the same certify command against its `stack.yaml`. The saved component files are
materialized copies, so continuation does not need the original charts, plugin
sample data or registry. It still needs the plugin runtime. Component names,
planes, order, app roles and declared bindings are preserved; original source
references remain in the baseline result. Edits are new local configuration, not
updates to the original published bundles or their certification.

An existing directory is never overwritten, even when empty. If creation is
interrupted before `stack.yaml` appears, keep the partial directory for inspection
and choose a new output directory. A complete saved directory is the resume point;
re-running the creation command against it is deliberately refused.

This example still needs target namespaces, an issuer and a secret store before
live use. No target has been checked, no application response has been observed,
and this local copy is not a published OCI artifact.

## Certification for assistants and automation

```bash
cub stack certify web-tiny --json > result.json
cub stack certify conflict-demo --json > refused.json
```

A completed check writes one `StackCertificationResult` JSON object to stdout.
Exit 0 means the composition passed the implemented checks; exit 1 with a JSON
result means it was refused. Execution or setup errors remain on stderr; an empty
stdout is not a certification result. JSON mode is supported only for `certify`.

The result includes `certified`, component counts and sources, the existing receipt
check fields (`result` and `text`), and `renderedFile` with the SHA-256 and size of
the exact bytes a sandbox would write. A rejected candidate also has a byte hash;
that hash does not make it approved or published. `scope` explicitly marks target
availability and application health as `not-checked`. No account or target is
contacted by certification; uncached bundle inputs may require registry access.

Claude Code, Codex and other consumers should use `certified` and the scope fields
for control flow, preserve warnings and findings for review, and retain the result
when handing work to another person. Do not infer deployment approval or a healthy
application from a static result. Run the same command without `--json` for human
output; both forms use the same certification function.

## What ships in the plugin

- `renders/` — nine verified chart renders from the public catalog, the config catalog.
- `apps/` — thirteen authored workloads: two teaching apps (`hello-standalone`,
  `shop-web`) and the eleven services the meridian fleet places.
- `stacks/` — twelve stack manifests: nine composed from the shipped renders, now named as images by digest with the bytes in `cache/`
  (including `metrics-double`, which certify rightly rejects), plus `eks-inference`
  and `kubara-platform` built from digest-pinned certified bundles pulled by `oras`
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

`cub stack certify <stack> --json` includes a scoped `prerequisites` inventory.
It reports explicit namespaces, Certificate issuer references, ExternalSecret
store references and named Ingress classes. Each requirement identifies its
consuming component and field, whether its object is `bundled` or its target
availability is `unknown`, and the next action. Bundled means the object is
present in the materialized stack; it does not mean the controller is ready.

For `kubara-shop-platform`, the five namespaces, `ClusterIssuer/letsencrypt`
and `ClusterSecretStore/platform-store` need target verification. The Traefik
IngressClass is bundled. The human output warns about the unknown prerequisites;
static certification can still pass. No cluster is contacted. The inventory is
not exhaustive: credentials, storage, DNS, workload scheduling, implicit/default
namespaces, arbitrary resource references and application responses are outside
this check. Neither people nor assistants should use `certified: true` as a
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
