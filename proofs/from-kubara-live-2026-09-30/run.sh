#!/usr/bin/env bash
# from-kubara on real Kubara output and a live hub (#84). It generates a
# two-cluster Kubara platform, builds the stack with `cub stack from-kubara`
# (which runs `cub kubara render`), checks it whole and per cluster, publishes
# it to a local registry, and uploads it twice to a hosted organization.
#
#   LAB=/tmp/lab KUBARA=/path/to/kubara-v0.16.0 OLD_WS=/path/to/cub-workshop@95b6242 \
#   REGISTRY=localhost:5002 PREFIX=m6-0930 CUB_CONTEXT=<context> \
#     bash proofs/from-kubara-live-2026-09-30/run.sh
#
# `cub stack` here is bin/cub-stack of this checkout, run with node, so the
# log is of the code under review rather than an installed release. It deletes
# nothing; cleanup.sh deletes the Spaces and Components it created.
set -euo pipefail
WS=$(cd "$(dirname "$0")/../.." && pwd)
: "${LAB:?set LAB to an empty scratch directory}" "${KUBARA:?set KUBARA to a kubara v0.16 binary}"
: "${REGISTRY:=localhost:5002}" "${PREFIX:=m6-0930}" "${CUB_CONTEXT:?set CUB_CONTEXT to the context of the organization to upload to}"
export CUB_CONTEXT
# Helm repositories of the run's own, so a broken entry in a global list cannot
# stop a render, as in kubara-confighub's kind lab.
export HELM_REPOSITORY_CONFIG=$LAB/helm/repositories.yaml HELM_REPOSITORY_CACHE=$LAB/helm/cache HELM_CACHE_HOME=$LAB/helm/cache-home

step() { printf '\n== %s\n' "$*"; }
show() { printf '$ %s\n' "$*"; }
cub_stack() { show "cub stack $*"; node "$WS/bin/cub-stack" "$@"; }
# Every Unit in the run's Spaces with its head revision, one line each, so two
# snapshots show whether an upload wrote anything.
snapshot() {
  for space in $(cub space list --no-headers --where "Slug LIKE '$PREFIX-%'" | awk '{print $1}' | sort); do
    cub unit list --space "$space" --no-headers --columns Unit.Slug,Unit.HeadRevisionNum | awk -v space="$space" '{print space, $1, $2}' | sort
  done > "$1"
  awk '{units[$1]++; revs[$1]+=$3} END {for (s in units) printf "  %-30s %3d units, head revisions summing to %d\n", s, units[s], revs[s]}' "$1" | sort
}

step "Tools"
show "kubara --version"; "$KUBARA" --version 2>&1 | tail -1
show "cub kubara version"; cub kubara version
show "helm version --short"; helm version --short
show "cub version"; cub version 2>&1 | sed -n '1,3p'
show "cub context get"; cub context get | grep -E 'Context Name|Organization Name|Server URL'

mkdir -p "$LAB"; cd "$LAB"
# The Components an upload creates are the organization's, not a Space's;
# cleanup.sh deletes only those that were not here before.
cub component list --no-headers | awk '{print $1}' | sort > components-before.txt
step "1. A two-cluster Kubara platform: hub in dev, spoke in prod, as in kubara-confighub's kind lab"
if [ ! -f platform/config.yaml ]; then
  show "cub kubara init --out platform --hub hub:dev --spoke spoke:prod --services cert-manager,metrics-server,traefik,homer-dashboard --repository http://git.git-server.svc.cluster.local/platform.git --email lab@example.com"
  cub kubara init --out platform --hub hub:dev --spoke spoke:prod --services cert-manager,metrics-server,traefik,homer-dashboard \
    --repository http://git.git-server.svc.cluster.local/platform.git --email lab@example.com
  cp platform/.env.example platform/.env
fi
cd platform
show "kubara --work-dir . --config-file config.yaml --env-file .env generate --helm"
"$KUBARA" --work-dir . --config-file config.yaml --env-file .env generate --helm 2>&1 | grep -v -i 'new kubara release'
show "ls platform-components/helm"; ls platform-components/helm

step "2. The stack, from cub kubara render"
cub_stack from-kubara .
show "jq '{generator, secretValues, clusters: [.clusters[] | {name, services: [.services[] | {name, objects, sha256}], shared: (.shared | length)}]}' confighub/kubara-render/render.json"
jq '{generator, secretValues, clusters: [.clusters[] | {name, services: [.services[] | {name, objects, sha256}], shared: (.shared | length)}]}' confighub/kubara-render/render.json

step "3. Check: the whole stack, then each cluster"
cub_stack check confighub/stack.yaml
cub_stack check confighub/stack.yaml --cluster hub
cub_stack check confighub/stack.yaml --cluster spoke

step "4. Parity with the JavaScript renderer this replaces (cub-workshop 95b6242), on the same platform"
if [ -n "${OLD_WS:-}" ]; then
  show "node <cub-workshop@95b6242>/bin/cub-stack from-kubara . --out old-js"
  node "$OLD_WS/bin/cub-stack" from-kubara . --out old-js | grep -E 'cluster|dropped|Wrote' || true
  show "node proofs/from-kubara-live-2026-09-30/parity.mjs confighub old-js"
  node "$WS/proofs/from-kubara-live-2026-09-30/parity.mjs" confighub old-js
fi

step "5. Publish to a registry: the bases and every cluster checked first"
cub_stack publish confighub/stack.yaml --out "oci://$REGISTRY/$PREFIX/kubara-platform:live" | tee ../publish.out
index=$(grep -oE 'oci://[^ ]+@sha256:[0-9a-f]{64}' ../publish.out | tail -1)
cub_stack check "$index" --cluster spoke
# A rehearsal stops here, before anything is written to the organization.
[ -z "${STOP_BEFORE_UPLOAD:-}" ] || exit 0

step "6. Upload to $(cub context get | awk '/Organization Name/ {print $3}'), twice: the rerun is safe"
cub_stack upload confighub/stack.yaml --space-prefix "$PREFIX" --run
show "snapshot: each Unit in the $PREFIX- Spaces and its head revision"
snapshot ../after-first.txt
step "6b. The same upload again"
cub_stack upload confighub/stack.yaml --space-prefix "$PREFIX" --run
show "snapshot again, and diff it against the first"
snapshot ../after-rerun.txt
if diff ../after-first.txt ../after-rerun.txt; then echo "  identical: $(wc -l < ../after-rerun.txt | tr -d ' ') Units, and the rerun wrote no new revision to any of them"; else echo "  the rerun changed the Units above"; fi

step "7. What the organization holds"
show "cub space list --where \"Slug LIKE '$PREFIX-%'\""
cub space list --no-headers --where "Slug LIKE '$PREFIX-%'" | sort
show "cub unit list --space $PREFIX-cert-manager-spoke"
cub unit list --space "$PREFIX-cert-manager-spoke" --no-headers | awk '{print $1}' | sort
