# Changelog

Each release names what changed for someone running the plugin. The pull
requests hold the reasons and the evidence.

## Unreleased

- `cub stack sandbox eks-inference --workspace DIR` saves the workspace instead of
  refusing `ack-controllers` with "pulled files do not match its receipt". The
  `ack-controllers` and `karpenter` receipts each name a `crd-ordering` route that
  their published bundles do not carry. The plugin now ships those two routes at the
  receipts' own paths under `data/certified-bundles/routes/`. A route the bundle
  lacks is read from that copy only when its SHA-256 equals the receipt's, and a
  route the bundle does carry must still verify there. Each saved route records
  `suppliedBy` as `bundle` or `plugin` in the workspace evidence. Configuration
  files always come from the bundle, and no digest or receipt changed (#105).

## 0.6.57

- `cub stack compose` accepts the Catalog's literal-bundle publication receipts. A
  `flatten-with-routes` entry bound by a `CatalogLiteralBundlePublicationReceipt` with
  verdict `decided`, at `runs/catalog-literal-bundles/<record>/publication-receipt.yaml`,
  composes the same way as one bound by a `CertifiedBundleReceipt` with verdict `certified`.
  The receipt must still pin the manifest, reference, object count, retained-object hash
  and at least one route; the other kind-and-verdict pairs are refused. Routes stay
  `declared-unexecuted`, and nothing is uploaded to ConfigHub.
- `cub config examples` describes the Kubara kind lab as "Kubara's managed
  add-ons", and points it at `cub kubara` v0.3.0, the first release that works
  with ConfigHub v0.8.0. The snapshot reads confighub/examples at `bcc3166`.
- `cub app upload` now imports through the current `cub variant upload` contract and
  creates the predictable `<app>-base` Space. It no longer creates a surprising
  `<app>-app` Space with a review trigger before the user has a target.
- `hello-standalone` now carries its Namespace, so the first app is self-contained.
- `cub stack deploy web-tiny --target <space/target>` provides one deliberately bounded
  first-stack path: two Bases, two target variants and two Releases. It refuses every
  other stack and distinguishes requested delivery from controller/runtime proof.

## 0.6.56

- `cub config examples` points the Kubara kind lab at `cub kubara` v0.2.4. The
  snapshot reads confighub/examples at `921cb9d`.

## 0.6.55

- `cub stack upload --space-prefix` names each Component `<prefix>-<component>` as
  well as its Spaces, so an upload into a shared organization creates no bare
  Component such as `cert-manager`. Space names are unchanged. A stack uploaded
  with a prefix by 0.6.54 or earlier moves over in place when rerun, leaving its
  old bare Components empty for `cub component delete`
  (`proofs/stack-prefix-live-2026-09-30`, #88).

## 0.6.54

- `cub config examples` knows the Kubara kind lab: "bring my Kubara platform
  into ConfigHub" returns the `cub kubara` v0.2.3 walkthrough first. The
  snapshot reads confighub/examples at `ed58e32` (#89).

## 0.6.53

### Kubara
- `cub stack from-kubara` renders through `cub kubara render` (kubara-confighub
  v0.2.3 or later), the one renderer of a platform as Kubara delivers it, and
  builds the stack from its `render.json` and object files. Its own helm
  rendering is gone. It needs `cub kubara`; without it, or with an older one,
  it stops and names `cub plugin install confighub/kubara-confighub` (#84).
- A shared object stays with the owner the render names and leaves every other
  service. The render is kept beside the stack in `kubara-render/` (#84).
- A Secret reaches the stack with its keys and without its values, and
  `from-kubara` names each one it emptied. Before, the stack carried the
  values the chart rendered (#84).
- Proven on real Kubara v0.16 output and a hosted organization
  (`proofs/from-kubara-live-2026-09-30`): the stack checks whole and per
  cluster, publishes, and uploads twice with the rerun writing nothing; its
  364 objects match what the old renderer wrote, Secrets compared by keys (#84).

### Stacks
- `cub stack publish` checks each cluster's composition as well as the bases,
  refuses before it pushes anything when one cluster does not check out, and
  attaches each cluster's verdict to the index record (#84).

## 0.6.52

- `sandbox` no longer says Ready for a stack that upload would refuse, and
  says why; the README's upload example is one that uploads (#80).
- A logged-out `cub` is reported with its reason and the fix, `cub auth
  login`, instead of "Failed: ."; `fleet age` no longer reports success
  when nothing aged (#80).
- `cub config examples` answers "how do I start", and shows the best match
  in full and the rest in a line each; `--full` shows all (#80).
- `cub config path` prints where the plugin is installed, and the task
  guides copy their examples from it (#80).
- The README opens with a first run that needs no account or cluster,
  states the requirements (Linux or macOS, Node 22), and its examples run
  as written, including a shipped sample values file (#80).
- `app check` suggests a shipped stack that already places the app (#80).

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
- `cub config examples` finds a pinned, public worked example for a problem
  described in plain words (#56).
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
