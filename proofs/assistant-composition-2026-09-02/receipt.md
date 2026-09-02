# An assistant composed a stack from the public site

Recorded 2026-09-02. The question: can a user's own AI assistant, pointed at the
Config Workshop site and nothing else, ask for a system and get certified parts?

## The run

A separate assistant was given one sentence, "I want a web platform with
monitoring, a message queue, and my shop app running on it, and I want the whole
thing checked before anything renders," and the site URL. It was forbidden to
read this plugin's source or the Config Workshop repository; it could read the
site's pages and this repository's README, DEMO, and example manifests, and it
could run cub. Every command and its verbatim output are in `journal.md`.

It read the homepage, the stack page, and the manifest specification, installed
the plugin from the site's install line, listed the shipped stacks, ran
`cub app check shop-web` to learn the app's three platform needs, chose
cert-manager, ingress-nginx, kube-prometheus-stack, and rabbitmq from the shipped
renders, wrote `stacks/shop-platform.yaml` with planes and order, and ran certify
and sandbox. Wall time about six minutes. Certify accepted on the first try.

Verdict, verbatim:

```
  [PASS] no resource conflicts across components (192 objects)
  [PASS] CRD ordering: 10 CRDs are delivered before the 51 custom resources that need them
  [WARN] 5 admission webhook(s) need a caBundle — cert-manager is in the stack and can issue it
  [PASS] namespaces: 0 created, 6 must already exist (cert-manager, ingress-nginx, kube-system, monitoring, rabbitmq, shop)
  => CERTIFIED
  192 objects total
```

Reproduced independently afterwards with the same verdict and counts.

## What the assistant found, and what changed because of it

1. A manifest of its own had nowhere to live: the verbs took only shipped names,
   and nothing said so. Fixed: `cub stack certify <path/to/manifest.yaml>` and
   `cub stack sandbox <path>` accept a file anywhere on disk, and its `render:`
   and `authored:` sources resolve relative to the manifest first, then to the
   plugin.
2. "Sandbox renders" printed counts and no YAML; an `--out` flag was ignored.
   Fixed: `cub stack sandbox <name> --out rendered.yaml` writes every object in
   plane order.
3. The custom-resource count moved by one, not two, when the app added a
   Certificate and a ServiceMonitor. The assistant could not explain it without
   reading source. The cause was a blind spot in the gate: the default
   cert-manager render ships no CRDs, so the Certificate relied on a CRD nothing
   in the stack delivers, and certify said nothing. Fixed: certify now reports
   custom resources whose CRD the stack does not deliver, as a warning that names
   the groups, the way it already names namespaces that must already exist.
   Hub-plane components, held in ConfigHub and never applied, are skipped.
4. Which parts exist to compose from was only learnable by cloning the
   repository. Fixed in the README: the nine shipped renders are listed, and the
   `authored: apps/<name>.yaml` form for putting an app in a stack is documented.
5. The site's install line exits non-zero when the plugin is already installed,
   and the site never names the installed plugin. Noted in the README; the
   command that fixes it is `cub plugin upgrade workshop`.

## What this does and does not show

It shows that the site and the plugin are readable enough for an assistant to go
from a sentence to a certified composition without a human in the loop, and that
the gate is where the assistant's mistakes would have been caught. It does not
show the stack running: no organization was touched, no release was published,
and the manifest declares no bindings between the queue and the app. The
assistant's own list of what remains is at the end of the journal.
