# The whole ladder in ten minutes

Every step is copy-paste. The free rungs need only `node`, `oras`, and `cub`, plus
`helm` for the values check and for `from-kubara`, which also needs `cub kubara` v0.2.3 or later
(`cub plugin install confighub/kubara-confighub`); the governed rungs need a ConfigHub org you can write to — the disposable self-hosted
sandbox from `cub server` is ideal, and the hosted hub works the same way.

## 0. Install the family

```bash
cub plugin install confighub/cub-workshop
```

## 1. config — see what one chart installs (free)

```bash
cub config check redis
```

Fourteen objects, the namespaces that must already exist, and the lifecycle work:
CRDs, hooks, setup Jobs, webhook certificates.

Writing values for a chart of your own? Find the ones that did nothing:

```bash
cub config values oci://registry-1.docker.io/cloudpirates/redis --version 0.34.11 \
  --values "$(cub config path)/examples/values/redis-values.yaml"
```

## 2. app — does this workload need a platform? (free)

```bash
cub app check hello-standalone
cub app check shop-web
cub app score shop-web
```

The first is standalone and delivers straight from OCI. The second needs an ingress
controller, cert-manager, and a Prometheus operator, which the `web-platform` stack
carries exactly. `score` exports the workloads to Score (score.dev).

## 3. stack — check a whole platform, and watch a refusal (free)

```bash
cub stack sandbox eks-inference
cub stack check metrics-double
```

The first checks and renders a real inference platform: 130 objects from eight
digest-pinned bundles with receipts, pulled and hash-verified against shipped receipts.
The second exits non-zero because two components claim the same objects — the gate
refuses rather than reports.

### An app tells the platform what it needs

Check also reads what each authored app needs from the platform under it, off
the app's own objects, and refuses a stack that does not carry it:

```
cub app check shop-web                      # needs an ingress controller, cert-manager, a Prometheus operator
cub stack check kubara-shop-first-try     # REFUSED: the Ingress asks for class nginx and the platform's controller is Traefik; nothing provides the operator
cub app check shop-web-kubara               # the app adapted: Traefik's class, a secret through external-secrets
cub stack sandbox kubara-shop-platform      # CHECKED: the platform grew by external-secrets, every need carried
```

### A platform Kubara generated

If a Kubara platform already exists, its own output becomes a stack, rendered
with the values Kubara generated, so the check reads the platform you actually
have rather than the catalog's copy of its parts:

```
kubara --work-dir . --config-file config.yaml --env-file .env generate --helm
cub stack from-kubara . --app shop-web-kubara        # the whole platform: a component per service, a variant per cluster
cub stack check ./confighub/stack.yaml
cub stack check ./confighub/stack.yaml --cluster prod   # what one cluster runs
cub stack upload  ./confighub/stack.yaml               # the plan; add --run to upload
```

`cub kubara render` renders each service the way Kubara's ApplicationSets deliver it,
and `from-kubara` keeps one owner per object and each Secret's keys without its values. A rerun of `upload --run` after a stop repeats every upload safely and
links the declared path bindings once the bases are up. A fleet manifest may place
that stack by path (`stack: ./confighub/stack.yaml`), and `cub fleet up
path/to/fleet.yaml` builds it like any shipped fleet.

## 3b. Hand it on as an image (free, any registry)

```bash
docker run -d -p 5001:5000 registry:2            # or any registry you can push to
cub config check redis --out oci://localhost:5001/demo/redis:v1
cub config verify oci://localhost:5001/demo/redis@sha256:<the digest it printed>
cub stack publish shop-platform --out oci://localhost:5001/demo/shop-platform:v1
```

The first command pushes the render as a bundle with its receipt
attached and pulls it back to verify it. The second re-hashes every file against
that receipt from nothing but the digest. The third publishes the stack as an
index of five images with the manifest and verdict attached: the form a catalog
holds, and the form an assistant picks from.

## 4. fleet — a governed fleet from two manifests (account)

Prerequisite: a ConfigHub org with room for 155 Spaces. The self-hosted sandbox
ships a 100-Space quota, so raise it first (the `entity_quota` table in the
sandbox's own Postgres); `cub fleet up` stops with a named remediation if you skip
this, and resumes where it stopped once you fix it.

```bash
cub fleet up meridian
cub fleet age meridian
cub fleet status meridian
```

What `cub fleet up` puts into ConfigHub, exactly: for each cluster, a Space with
a server-hosted worker and an OCI target; for each component and app, the
published bundle or the authored YAML uploaded as a base variant, one Unit per
file or resource; for each placement, a deployment variant cloned from its base,
bound to its cluster's target, with a release published for it, an OCI image in
ConfigHub's registry pinned to its digest. Everything after that, the aging, a
promotion, a gate, an approval, a ChangeOrder, is ConfigHub's own verbs on those
Spaces.

What it does not do: nothing pulls those releases. The sandbox has no reconciler
attached, so the fleet is loaded into ConfigHub and governed there, and it runs
nowhere. Attaching a cluster that pulls is a separate step. It is not part of this
plugin: `cub cluster up` is a `cub` command that brings up a local kind cluster with
Argo CD wired to ConfigHub, and `cub cluster --help` describes it.

`up` scaffolds ten regional cluster Spaces, uploads twenty component bases, and
places and releases 125 deployments through the ordinary governed verbs. `age`
replays declared operations — an edit pending deployment, a base advancing, an
approval gate arming, a ChangeOrder opening — so the attention states are real
residue, not staged data. `status` recomputes the four attention tiles from the
same queries a components view renders; open the hub UI to see them drawn.

`external-dns` is placed in waves, canary then secondary then primary. Open the first
wave's ChangeOrder, check where it stands, and see what comes next:

```bash
cub fleet rollout meridian external-dns          # the plan, no changes
cub fleet rollout meridian external-dns --run    # open the canary wave
cub fleet status meridian                        # adds the Rollouts by wave line
```

The next wave is refused until the canary's ChangeOrder closes. Opening a wave does not
deliver anything by itself.

Tear it all down when finished:

```bash
cub fleet down meridian
```

It deletes what `up` and `age` created, including the ChangeOrders, keeps a base that
another fleet still uses, and stops on the first failure other than not-found.

## What to take away

One plugin install gave four nouns that speak the same verbs at every size: check
one chart, check one workload, check one platform, generate one fleet. The
governed rungs underneath are ConfigHub's own released verbs — the plugin proposes
the surface, the engine decides.
