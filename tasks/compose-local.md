# Save, change and check a Kubara app locally

This task works with workshop 0.6.14 or later. It tests a local editing journey;
it does not supply GitOps delivery or prove the platform or app runs.

## Before starting

Install Node.js, cub and the Workshop plugin using the repository instructions.
Choose a new working directory. Initial source resolution may use public registry
access and ORAS. Save the plugin revision and CLI version alongside the result.
For an isolated trial, create an empty directory and set CUB_CONFIG to its absolute
path before installing the plugin. This keeps the existing user installation intact.
The recorded assistant trial used an already prepared isolated installation; setup
time is separate from task execution time.

## Assistant task

Give either assistant the installed README as WORKFLOW.md and this task. For a
normal installation, omit the sentence about CUB_CONFIG. Do not treat this prompt
as permission to deploy.

```text
Complete this local-only workshop task in the current directory. Read WORKFLOW.md for the installed command surface. The cub workshop plugin is already configured for this isolated directory through CUB_CONFIG. Do not install or upgrade anything, contact a cluster, publish, upload, read credentials, or change files outside this directory. Do not delegate.

Use cub to save kubara-shop-platform as a new editable workspace named platform. Retain its original result.json and rendered.yaml. Change only the shop-web Deployment replica count from 3 to 2, certify the changed stack with JSON output to changed-result.json inside the workspace, and render changed.yaml there. Demonstrate a refusal: copy the changed platform folder (with replicas still 2) to a separate folder called incompatible, change only its shop-web ExternalSecret apiVersion to external-secrets.io/v1beta1, then retain the JSON refusal as incompatible/refusal.json. Do not repair or remove the incompatible resource, and do not modify baseline files to disguise a difference.

Write REPORT.md explaining the actual command results, baseline and changed render hashes, exactly what changed, what was refused and why, which target prerequisites remain unverified, and whether this proves the app runs. Keep the final answer short. Complete the work by running the tools, not just describing commands.
```

## Direct demonstration

The same task is available without an assistant:

```sh
cub stack sandbox kubara-shop-platform --workspace ./platform
cub stack certify ./platform/stack.yaml --json
```

Keep `platform/result.json` and `platform/rendered.yaml` as the baseline. In
`platform/components/05-shop-web.yaml`, change only the shop-web Deployment's
`spec.replicas` from 3 to 2. Then:

```sh
cub stack certify ./platform/stack.yaml --json > ./platform/changed-result.json &&
  cub stack sandbox ./platform/stack.yaml --out ./platform/changed.yaml &&
  git diff --no-index ./platform/rendered.yaml ./platform/changed.yaml
```

The last command returns 1 when the expected difference exists. Inspect that
only the replica count changed. Reopen the stack by its path after moving the
whole directory; do not copy only its manifest.

For the refusal demonstration, copy the whole folder to a new `incompatible`
directory. In that copy's app component only, change the ExternalSecret API from
`external-secrets.io/v1` to `external-secrets.io/v1beta1`. Run:

```sh
cub stack certify ./incompatible/stack.yaml --json > ./incompatible/refusal.json
```

Expect exit 1 and `certified: false`: the bundled CRD does not serve that version.
Preserve the refusal. Do not remove the object to make the check pass. No cluster
cleanup is needed because these commands create local files only. Keep or remove
those local folders deliberately after reviewing them.

## What to show and explain

Show the baseline, exact diff, changed result and refusal result. Explain that
certification is static: namespaces, issuer, secret store, target availability
and the application response remain unobserved. The fixture does not include a
GitOps controller. This bounded demo therefore does not complete the original
GitOps-plus-app journey or the real-target acceptance gate.
