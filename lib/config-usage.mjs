// The one usage text for cub config. bin/cub-config prints it for --help and
// lib/config.mjs prints it for the bare command, so the two cannot drift.
export const CONFIG_USAGE = `cub config — one config, one chart: render it for free and see what it installs

Usage:
  cub config list
  cub config list --role ROLE [--json] [--catalog-index FILE_OR_HTTPS_URL]
  cub config examples [problem words] [--json] [--all]
  cub config check <name | local.yaml> [--images] [--exit-code] [--out oci://<repo>[:tag] [--sign cosign.key] | --out file.yaml]
  cub config verify oci://<repo>@sha256:<digest> [--key cosign.pub]
  cub config diff <before.yaml> <after.yaml> [--summary] [--json] [--out result.json] [--exit-code]
  cub config values <chart> (--values | -f) my-values.yaml [--version X] [--repo URL] [--namespace ns] [--release name] [--max-renders N] [--json] [--out result.json] [--render-out candidate.yaml] [--exit-code]
      -f is short for --values. --namespace (default "default") and --release (default "release") are what the chart renders as.
      --max-renders N (default 60) caps the renders spent checking values; a value past it is NOT CHECKED, and --exit-code fails on it.

Roles: cache, database, ingress, certificates, metrics, logs, secrets, queue, gpu
Role discovery returns candidates for inspection; it does not select one or make runtime claims.
With check --images --exit-code, exit 1 means an image was confirmed missing; exit 2
means an anonymous registry check was incomplete, such as when credentials or network
access are unavailable.

This is the prototype of the proposed config verb, packaged as a cub plugin.`;
