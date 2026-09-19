# Check every proposed platform edit

Keep a local Stack manifest and its component files under `platform/`. Copy
[stack-check.yml](./stack-check.yml) to `.github/workflows/stack-check.yml` in
that repository. Each pull request changing those files runs the same checker
as the manual command:

```bash
cub stack check platform/stack.yaml --json
```

The workflow pins Workshop v0.6.34 by commit and runs its Node entrypoint, so it
does not need a ConfigHub account, cluster credentials or a global cub install.
It supports local `render` and `authored` component files. OCI bundle sources
also need ORAS and any registry access; configure those separately before using
this workflow for bundle components.

For example, create `platform/` with `cub stack compose`, inspect the saved
provenance and warnings, then commit the manifest and component files. The
workflow checks edits under that directory automatically. If your manifest
references files elsewhere, extend both the trigger paths and the checked path.

A resource ownership conflict, invalid manifest or known wrong-namespace
Promtail destination makes the check fail. GitHub retains the JSON result for
both passing and refused checks. Make this job required in the repository's
branch rules if merges must be gated on it; copying the workflow does not set
those rules.

Warnings and unknown target facts do not become live proof. This workflow does
not apply objects, test health, establish rollout safety or prove rollback.
An agent and a person can inspect the same result and repair the same files.
