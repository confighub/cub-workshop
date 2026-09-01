# cub-workshop

The Config Workshop noun family as a real cub plugin. Four commands, one per noun,
each speaking the settled verbs:

```bash
cub plugin install /path/to/cub-workshop   # or, once published: cub plugin install confighub/cub-workshop
```

Requires `node`, `oras`, and `cub` on the PATH.

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

cub fleet list
```

Bringing your own chart? The config catalog here is fixed to the nine shipped
renders, so render yours first and check the result: `helm template <chart> >
my-app.yaml`, then either drop the file into `apps/` and run `cub app check
my-app`, or use the browser check on the Config Workshop site, which accepts any
rendered YAML without an account. Coming from Flux or Argo CD, nothing changes on
your side: every governed rung below publishes OCI your reconciler pulls as usual.

With an account (the governed rungs):

```bash
cub app upload hello-standalone --run     # one Unit per resource, release gated on review
cub stack upload eks-inference --run      # base Spaces and profile links for a certified composition
cub fleet up meridian                     # scaffold clusters, upload bases, place and release everything
cub fleet age meridian                    # replay the declared operations so real attention states exist
cub fleet status meridian                 # the four attention tiles, recomputed from fleet queries
cub fleet down meridian                   # delete everything the manifest names
```

From there the generic cub verbs continue the ladder: `cub release publish`,
`cub variant promote`, gates and ChangeOrders for governance.

## What ships in the plugin

- `renders/` — nine verified chart renders from the public catalog, the config catalog.
- `apps/` — thirteen authored workloads: two teaching apps (`hello-standalone`,
  `shop-web`) and the eleven services the meridian fleet places.
- `stacks/` — eleven stack manifests: eight composed from the shipped renders
  (including `metrics-double`, which certify rightly rejects), plus `eks-inference`
  and `kubara-platform` built from digest-pinned certified bundles pulled by `oras`
  and hash-verified against `receipts/`, and `conflict-demo`.
- `fleets/meridian.yaml` — ten regional clusters, twenty components, 125 placements,
  and the demo-aging operations that give the fleet real attention states.

Everything is a prototype of the proposed `cub <noun>` surface, packaged so it runs
as cub itself. The manifest formats (stack, fleet) are documented in the Config
Workshop repository's planning notes, and the receipts derive from the public
evidence in confighub/helm-expt at the pinned digests they name.
