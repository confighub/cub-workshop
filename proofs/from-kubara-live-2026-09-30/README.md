# from-kubara on real Kubara output and a live hub

`run.log` is one run of `run.sh` on 2026-09-30 (#84). It generated a two-cluster
Kubara platform, built one stack from it with `cub stack from-kubara`, checked
it, published it to a local registry, and uploaded it twice to a hosted
ConfigHub organization. `cleanup.log` is `cleanup.sh` deleting what the upload
created, after the log was captured.

Tools: Kubara v0.16.0; `cub kubara` built from confighub/kubara-confighub main at
96ba393 and installed as a local plugin (`cub plugin install <dir>`), which
reports `0.2.3-dev`, since v0.2.3 was not yet released; helm v4.1.4; cub
v0.6.8. `cub stack` is `bin/cub-stack` of this branch, run with node.

What it shows, in the order of the log:

1. `cub kubara init` wrote a platform with a hub (dev) and a spoke (prod), the
   services cert-manager, metrics-server and traefik on both and
   homer-dashboard on the hub, as in kubara-confighub's kind lab. Kubara
   v0.16.0 ran `generate --helm` on it.
2. `cub stack from-kubara .` ran `cub kubara render` and built one stack: six
   components, ten cluster renders, 364 objects. The one Secret with values, Argo CD's cluster
   Secret, kept its keys and lost its values, and `from-kubara` named it.
   This platform has no object two services render, so nothing was dropped.
3. `cub stack check` passed for the whole stack and for `--cluster hub` and
   `--cluster spoke`.
4. On the same generated platform, the stack's objects match what the
   JavaScript renderer this replaces (cub-workshop 95b6242) wrote, object for
   object, 364 of 364, with the two Secrets compared by their keys
   (`parity.mjs`).
5. `cub stack publish` to `localhost:5002` checked the bases and then each
   cluster, published the index, and `check --cluster spoke` read the spoke
   back from the index by digest.
6. `cub stack upload --run` to the organization Kubara made 6 base Spaces and
   10 cluster variant Spaces, 591 Units. The second run re-issued every
   upload, found each variant already cloned, and wrote nothing: a snapshot
   of every Unit and its head revision after each run is identical.

What it does not show: no cluster was involved, so nothing here was applied,
reconciled or seen healthy. The Units hold no Secret, since `cub variant
upload` never uploads one. The registry was a local `registry:2`, removed
after the run. The upload used Space names with the prefix `m6-0930`; the
Component slugs the upload creates are not prefixed, so `cleanup.sh` deleted
each Component that did not exist before the run.

To run it again:

```bash
docker run -d -p 5002:5000 --name m6-registry registry:2
LAB=$(mktemp -d) KUBARA=/path/to/kubara-v0.16.0 OLD_WS=/path/to/cub-workshop-95b6242 \
  REGISTRY=localhost:5002 PREFIX=m6-0930 CUB_CONTEXT=<context> \
  bash proofs/from-kubara-live-2026-09-30/run.sh
LAB=... PREFIX=m6-0930 CUB_CONTEXT=<context> bash proofs/from-kubara-live-2026-09-30/cleanup.sh
docker rm -f m6-registry
```

`STOP_BEFORE_UPLOAD=1` stops `run.sh` before it writes to the organization.
