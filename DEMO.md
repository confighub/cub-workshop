# The whole ladder in ten minutes

Every step is copy-paste. The free rungs need only `node`, `oras`, and `cub`; the
governed rungs need a ConfigHub org you can write to — the disposable self-hosted
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

## 2. app — does this workload need a platform? (free)

```bash
cub app check hello-standalone
cub app check shop-web
cub app score shop-web
```

The first is standalone and delivers straight from OCI. The second needs an ingress
controller, cert-manager, and a Prometheus operator, which the `web-platform` stack
carries exactly. `score` exports the workloads to Score (score.dev).

## 3. stack — certify a whole platform, and watch a refusal (free)

```bash
cub stack sandbox eks-inference
cub stack certify metrics-double
```

The first certifies and renders a real inference platform: 130 objects from eight
digest-pinned certified bundles, pulled and hash-verified against shipped receipts.
The second exits non-zero because two components claim the same objects — the gate
refuses rather than reports.

## 3b. Hand it on as an image (free, any registry)

```bash
docker run -d -p 5001:5000 registry:2            # or any registry you can push to
cub config check redis --out oci://localhost:5001/demo/redis:v1
cub config verify oci://localhost:5001/demo/redis@sha256:<the digest it printed>
cub stack publish shop-platform --out oci://localhost:5001/demo/shop-platform:v1
```

The first command pushes the render as a certified bundle with its receipt
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

`up` scaffolds ten regional cluster Spaces, uploads twenty component bases, and
places and releases 125 deployments through the ordinary governed verbs. `age`
replays declared operations — an edit pending deployment, a base advancing, an
approval gate arming, a ChangeOrder opening — so the attention states are real
residue, not staged data. `status` recomputes the four attention tiles from the
same queries a components view renders; open the hub UI to see them drawn.

Tear it all down when finished:

```bash
cub fleet down meridian
```

## What to take away

One plugin install gave four nouns that speak the same verbs at every size: check
one chart, check one workload, certify one platform, generate one fleet. The
governed rungs underneath are ConfigHub's own released verbs — the plugin proposes
the surface, the engine decides.
