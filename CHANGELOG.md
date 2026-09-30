# Changelog

Each release names what changed for someone running the plugin. The pull
requests hold the reasons and the evidence.

## 0.6.51

### Kubara
- `cub stack from-kubara` renders each service the way Kubara's hub
  ApplicationSets deliver it: the ApplicationSet's release name and
  namespace, values files in its order, only the services `config.yaml`
  enables, and `bootstrap-crds` as its CRDs alone (#64, closes #60).
- It makes one stack for the whole platform: a component per service, a
  variant per cluster that runs it, with the hub's render as the base.
  `--cluster` narrows it to one cluster (#68, closes #59).
- `cub stack check`, `sandbox` and `upload` take `--cluster <name>` to read a
  platform stack as one cluster runs it. `upload` clones each cluster's
  variant from its base, so promotion runs base to cluster (#68).
- `cub stack publish` publishes a whole platform as one index, every
  cluster's variant by digest, and `--cluster` reads it back from the index
  (#75).

### Stacks
- `check` and `sandbox` validate delivered objects against their schemas with
  the Flux schema plugin when it is installed. Without it the line is a WARN
  and the verdict is unchanged (#69, closes #3).
- `upload` says what an interrupted run left and gives the rerun command;
  rerunning is safe, since every upload is create-or-update (#73).
- `upload` links every declared binding to the profile, path and env
  bindings alike, and the linked values follow the profile; verified on
  hub.confighub.com (#74).
- `upload` refuses a component that defines an object twice before writing
  anything, since the hub refuses it; `check` says so (#77).
- A current hub's not-found wording is read as absence, so `fleet up` and
  `upload` create what is missing instead of stopping (#70, #73), and
  `--space-prefix` names Spaces by the Component slug the hub can render
  (#73, #68).
- The verdict word is CHECKED everywhere, including the published index
  annotation. **Breaking:** `cub stack check --json` no longer carries the
  deprecated `certified` field; read `checked` (#62).
- Bundle cache entries left incomplete under `$TMPDIR/cub-stack-bundles` are
  replaced by a fresh pull instead of failing every run (#61).

### Fleets
- `cub fleet rollout <fleet> <component>` rolls a change out in waves
  (canary, secondary, primary), one ChangeOrder per wave, each gated on the
  last; `status` counts rollouts by wave (#72, closes #4).
- A placement may name a published stack by index digest (#71, part of #1).
- The Space owner comes from the manifest's `spec.owner`; `down` deletes only
  what `up` and `age` create and stops on a failure; `list` counts a stack's
  components (#70).

### Config
- `cub config values` fails `--exit-code` on values it did not check, and
  `--max-renders` raises the cap (#63).
- `cub config verify` says whether a signature is attached, with or without
  `--key` (#65, part of #2).

### Errors
- A missing `oras`, `helm` or `cosign` is named with the step that needs it
  (#66). Errors keep their cause: the bound a bounded input hit, a child's
  stderr, the receipt file that differs (#67).

### Housekeeping
- Every verb and flag appears in its command's help and in the plugin
  summaries; README and DEMO match the tree; dead code removed; CI runs every
  test file and every offline stack.
