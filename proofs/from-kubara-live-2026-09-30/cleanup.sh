#!/usr/bin/env bash
# Delete what run.sh created in the organization: the Spaces named with its
# prefix, and each Component the upload created that did not exist before the
# run ($LAB/components-before.txt). Nothing else is touched.
#
#   LAB=/tmp/lab PREFIX=m6-0930 CUB_CONTEXT=<context> bash proofs/from-kubara-live-2026-09-30/cleanup.sh
set -euo pipefail
WS=$(cd "$(dirname "$0")/../.." && pwd)
: "${LAB:?}" "${PREFIX:?}" "${CUB_CONTEXT:?}"
export CUB_CONTEXT
show() { printf '$ %s\n' "$*"; }

spaces=$(cub space list --no-headers --where "Slug LIKE '$PREFIX-%'" | awk '{print $1}' | sort)
if [ -n "$spaces" ]; then
  list=$(echo "$spaces" | paste -sd, -)
  show "cub space delete --recursive --space $list"
  cub space delete --recursive --space "$list"
fi
touch "$LAB/components-before.txt"
components=$(node -e 'const y=require(process.argv[1]); const s=y.load(require("fs").readFileSync(process.argv[2],"utf8")); for (const c of s.spec.components) console.log(c.name)' "$WS/lib/yaml.cjs" "$LAB/platform/confighub/stack.yaml")
for comp in $components; do
  if grep -qx "$comp" "$LAB/components-before.txt"; then echo "kept Component $comp: it existed before the run"; continue; fi
  show "cub component delete $comp"
  cub component delete "$comp"
done
show "cub space list --where \"Slug LIKE '$PREFIX-%'\""
left=$(cub space list --no-headers --where "Slug LIKE '$PREFIX-%'" | wc -l | tr -d ' ')
echo "$left Space(s) left with the prefix $PREFIX-"
