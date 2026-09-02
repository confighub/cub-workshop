# Assistant proof journal: "a web platform with monitoring, a message queue, and my shop app, checked before anything renders"

Run started 2026-09-02T07:02:34Z, sandbox verdict at 2026-09-02T07:04:30Z, cross-checks finished 2026-09-02T07:05:25Z (about 3 minutes of wall time against a 25 minute budget).

Rules I held to: only the public site under https://confighub.github.io/helm-expt/site/ and the public plugin repository it points to (github.com/confighub/cub-workshop, cloned into this directory). I did not read the helm-expt checkout and I did not read the plugin's lib/*.mjs. Every command and its output is below verbatim; where I trimmed I say so. Raw page HTML is saved beside this file (home.html, stack.html, spec.html, custom-stacks.html, try.html); the text extractor I used is totext.py.

## Pages read, in order

1. https://confighub.github.io/helm-expt/site/ (home). Found the hero door "I need a stack" -> ./stack.html, the "proposed verbs" link -> ./d/docs/planning/custom-stacks-and-apps.html, and the install line `cub plugin install confighub/cub-workshop`.
2. https://confighub.github.io/helm-expt/site/stack.html ("Stacks and fleets"). Learned: certify and sandbox need no cluster and no account; the three component forms (bundle+receipt, render, authored); the four certify checks; the eleven shipped stacks; the upload path (`cub stack upload <name> --run`, then `cub variant create`, `cub release publish`, `cub variant promote`); link to the manifest spec and to the plugin repository.
3. https://confighub.github.io/helm-expt/site/d/docs/planning/stack-manifest-spec.html ("The stack manifest, specified"). This is where the manifest format came from: the `apiVersion: helm-expt.confighub.com/v1alpha1`, `kind: Stack` shape with `spec.components[]` each carrying exactly one of `bundle`+`receipt`, `render`, or `authored` as a "repo path", optional `plane: hub | mgmt | workload` and `order`, optional `bindings`.
4. github.com/confighub/cub-workshop: README.md, DEMO.md, stacks/web-platform.yaml, stacks/data-services.yaml, stacks/app-platform.yaml, stacks/web-tiny.yaml, stacks/conflict-demo.yaml, apps/shop-web.yaml, the listings of renders/, apps/, components/, and cub-plugin.yaml.
5. https://confighub.github.io/helm-expt/site/d/docs/planning/custom-stacks-and-apps.html, read after the verdict, for the site's own description of "how a custom stack would flow".
6. https://confighub.github.io/helm-expt/site/try.html, grepped only for the cub CLI install line (`curl -fsSL https://hub.confighub.com/cub/install.sh | bash`); cub was already present so I did not run it.

## Commands and outputs

### 1. Fetch the homepage

```
$ mkdir -p .../assistant-proof && date -u +"%Y-%m-%dT%H:%M:%SZ" && curl -sL https://confighub.github.io/helm-expt/site/ -o home.html && wc -c home.html
2026-09-02T07:02:34Z
   28075 home.html
```

Extracted text (trimmed to the parts I used; nav and footer boilerplate cut; full HTML in home.html):

```
one ladder · free check → certified platform → governed release
# free: certify and render a whole platform
$ cub stack sandbox eks-inference
=> CERTIFIED  130 objects from 8 digest-pinned certified bundles
Where these commands come from. ... cub config, cub app, cub stack, and cub fleet are [proposed verbs] running today as a plugin prototype ...
Before you run it. [Install the cub CLI], then install the proposed verbs with cub plugin install confighub/cub-workshop.
The vocabulary: a [config] is one chart. An [app] is a workload. A [stack] is a certified composition. A [fleet] is placement as data.
```

Links I picked out of home.html: `./stack.html | I need a stack`, `./d/docs/planning/custom-stacks-and-apps.html | proposed verbs`, `./try.html#install-cub | Install the cub CLI`.

### 2. Fetch the stack page, the proposed-verbs page, and try.html

```
$ curl -sL .../site/stack.html -o stack.html && curl -sL .../site/d/docs/planning/custom-stacks-and-apps.html -o custom-stacks.html && curl -sL .../site/try.html -o try.html && wc -c stack.html custom-stacks.html try.html
   35270 stack.html
   32895 custom-stacks.html
   30063 try.html
   98228 total
```

stack.html text, trimmed to the parts I relied on (the full page text is reproducible with `python3 totext.py stack.html`):

```
$ cub plugin install confighub/cub-workshop
$ cub stack sandbox eks-inference
  [PASS] no resource conflicts across components (130 objects)
  => CERTIFIED
  130 objects total
$ cub stack certify metrics-double
  [FAIL] 9 resource conflict(s) — the same object is claimed by more than one component:
  => REJECTED

1. What a stack is
A stack manifest names its components in one of three forms: a bundle pinned by digest with a receipt, a committed render, or authored YAML the stack owns. ... Components can declare a plane and an order ... Bindings between components live in the manifest too ... [Read the manifest specification] -> ./d/docs/planning/stack-manifest-spec.html

2. What certify checks
Resource conflicts ... CRD before CR ... Admission webhooks ... Namespaces ...

3. Eleven stacks ship with the plugin
web-platform: cert-manager, ingress-nginx, kube-prometheus-stack — CERTIFIED; carries what an app like shop-web depends on
data-services: redis, postgresql, rabbitmq — CERTIFIED, 31 objects, no CRDs
observability-base: cert-manager, metrics-server, kube-prometheus-stack — CERTIFIED, 175 objects, 10 CRDs before 50 custom resources
(others omitted here)
The render-form stacks ship inside the plugin, so they certify offline.

4. Upload it, then continue with the generic verbs
cub stack upload <name> --run certifies first, then builds one base Space per component in ConfigHub and the profile links the manifest declares. Without --run it prints the plan and changes nothing.
From there nothing is special. cub variant create places a base on a target, cub release publish releases it by digest, and cub variant promote moves a reviewed change up the tree.

6. Receipts and boundaries
[The plugin repository and its ten-minute walkthrough] -> https://github.com/confighub/cub-workshop
```

### 3. Fetch the manifest spec

```
$ curl -sL .../site/d/docs/planning/stack-manifest-spec.html -o spec.html && wc -c spec.html && python3 totext.py spec.html
   32072 spec.html
```

The shape, verbatim from the page (the rest of the page is prose about planes, bindings, certification, fleets and prior art; full HTML in spec.html):

```
apiVersion: helm-expt.confighub.com/v1alpha1
kind: Stack
metadata:
  name: <stack-name>
spec:
  description: "<one sentence>"
  fullVerdict: <repo path>          # optional: the committed eight-check verdict
  components:
    - name: <component>
      plane: hub | mgmt | workload  # optional; see planes
      order: <int>                  # optional; ties inside a plane
      # exactly one source form:
      bundle: "oci://<ref>@sha256:<digest>"   # a retained certified bundle
      receipt: <repo path>                    # required with bundle
      render: <repo path>                     # a committed chart render
      authored: <repo path>                   # literal YAML the stack authors
  bindings:                         # optional: the declared link set
    pathBindings: [...]
    envBindings: [...]
```

Sentences I leaned on: "An authored component is literal YAML the stack itself owns, first-class rather than a workaround" and "Exactly one form per component." The page never says what "<repo path>" is relative to.

### 4. The site's install line, and what is installed

```
$ cub plugin install confighub/cub-workshop
Failed: plugin "workshop" is already installed; run 'cub plugin upgrade workshop' to update it, or 'cub plugin uninstall workshop' first to reinstall fresh
exit=1
```

Noted and continued, as the run rules allow.

```
$ cub stack list

Available stacks

  app-platform  —  A full platform for a web application: database, cache, ingress, certificates, and monitoring. The shape a Spring Boot app lands on.
      cert-manager, ingress-nginx, postgresql, redis, kube-prometheus-stack
  conflict-demo  —  Two components claim the same object with different content. Certify must refuse this composition.
      team-a, team-b
  data-services  —  A stateful data tier: cache, relational database, and message queue.
      redis, postgresql, rabbitmq
  eks-inference  —  The EKS inference platform as a stack: eight digest-pinned certified bundles across three planes. The keystone, spoken in the settled vocabulary.
      platform-profile, ack-controllers, aws-network, eks-cluster, karpenter-aws, karpenter, gpu-runtime, inference-workloads
  gitops-secrets  —  A delivery control plane: Argo CD, External Secrets, and cert-manager, three CRD-shipping components composed together.
      cert-manager, external-secrets, argo-cd
  kubara-platform  —  A small platform of cert-manager, Traefik, and metrics-server, composed from the catalog's published certified bundles.
      cert-manager, traefik, metrics-server
  metrics-double  —  Two copies of metrics-server, composed to show the certify step catching a resource conflict.
      metrics-server, metrics-server-again
  observability-base  —  A base observability platform: certificates, cluster metrics, and the Prometheus stack.
      cert-manager, metrics-server, kube-prometheus-stack
  redis-platform  —  A managed Redis platform: the cache, its secrets, and monitoring. After the redis-platform pattern in confighub/examples.
      redis, external-secrets, kube-prometheus-stack
  web-platform  —  A platform for web apps: ingress, certificates, and monitoring. Carries exactly what an app like shop-web depends on.
      cert-manager, ingress-nginx, kube-prometheus-stack
  web-tiny  —  A tiny two-component web stack, used to run cub stack install end to end without burning quota.
      frontend, backend

cub stack sandbox <name>   # certify and render, free

exit=0
```

So "shop-platform" is a free name.

```
$ cub stack --help
cub stack — a certified composition of components, spoken by name

Usage:
  cub stack list
  cub stack certify <name>
  cub stack sandbox <name>
  cub stack upload <name> [--run]

This is the prototype of the proposed stack verb, packaged as a cub plugin.
exit=0
```

### 5. Clone the public plugin repo and look around

```
$ git clone -q --depth 1 https://github.com/confighub/cub-workshop plugin-repo
exit=0
$ ls plugin-repo
DEMO.md LICENSE README.md apps bin components cub-plugin.yaml fleets lib receipts renders stacks
$ ls plugin-repo/stacks
app-platform.yaml conflict-demo.yaml data-services.yaml eks-inference.yaml gitops-secrets.yaml kubara-platform.yaml metrics-double.yaml observability-base.yaml redis-platform.yaml web-platform.yaml web-tiny.yaml
$ ls plugin-repo/renders
argo-cd.yaml cert-manager.yaml external-secrets.yaml ingress-nginx.yaml kube-prometheus-stack.yaml metrics-server.yaml postgresql.yaml rabbitmq.yaml redis.yaml
$ ls plugin-repo/apps
cart.yaml catalog-api.yaml checkout.yaml conflict-a.yaml conflict-b.yaml fraud-scoring.yaml hello-standalone.yaml identity.yaml ledger.yaml payment-gateway.yaml search.yaml shipment-tracker.yaml shop-web.yaml storefront.yaml warehouse-api.yaml
$ cub plugin list
NAME             COMMANDS                     STATUS
che              che                          ok
eks-inference    eksinf                       ok
helm             helm                         ok
install          install                      ok
installer        installer                    ok
lk               lk                           ok
scan             check, scan                  ok
scout            scout                        ok
server           server                       ok
workshop         config, app, stack, fleet    ok
$ cub app --help
cub app — a workload: check it, upload it under governance, export it to Score

Usage:
  cub app list
  cub app check <name>
  cub app upload <name> [--run]
  cub app score <name>

This is the prototype of the proposed app verb, packaged as a cub plugin.
$ cub app list

Available apps

  cart  —  3 objects, standalone
  catalog-api  —  3 objects, standalone
  checkout  —  3 objects, standalone
  conflict-a  —  1 objects, standalone
  conflict-b  —  1 objects, standalone
  fraud-scoring  —  3 objects, standalone
  hello-standalone  —  2 objects, standalone
  identity  —  3 objects, standalone
  ledger  —  3 objects, standalone
  payment-gateway  —  3 objects, standalone
  search  —  3 objects, standalone
  shipment-tracker  —  3 objects, standalone
  shop-web  —  5 objects, needs a platform (3 deps)
  storefront  —  3 objects, standalone
  warehouse-api  —  3 objects, standalone

cub app check <name>   # render and analyze, free
```

`cub plugin list` prints no paths, so where the installed copy lives was not yet known.

### 6. README.md and DEMO.md

Read in full (`cat README.md`, `cat DEMO.md`; both are in plugin-repo/, so I reproduce only the lines that mattered):

```
Requires `node`, `oras`, and `cub` on the PATH.
cub stack certify metrics-double      # the composition gate alone; exits non-zero on a conflict
cub stack sandbox eks-inference       # certify, then render the whole platform with no infrastructure
Bringing your own chart? The config catalog here is fixed to the nine shipped renders, so render yours first and check the result: `helm template <chart> > my-app.yaml`, then either drop the file into `apps/` and run `cub app check my-app`, or use the browser check ...
- `stacks/` — eleven stack manifests: eight composed from the shipped renders ...
```

DEMO.md step 2: "The second [shop-web] needs an ingress controller, cert-manager, and a Prometheus operator, which the `web-platform` stack carries exactly."

Neither file says how to add a stack of your own, or where a new manifest goes.

### 7. Example manifests, components/, cub-plugin.yaml

```
$ cat stacks/web-platform.yaml
apiVersion: helm-expt.confighub.com/v1alpha1
kind: Stack
metadata:
  name: web-platform
spec:
  description: "A platform for web apps: ingress, certificates, and monitoring. Carries exactly what an app like shop-web depends on."
  components:
    - name: cert-manager
      render: "renders/cert-manager.yaml"
    - name: ingress-nginx
      render: "renders/ingress-nginx.yaml"
    - name: kube-prometheus-stack
      render: "renders/kube-prometheus-stack.yaml"

$ cat stacks/data-services.yaml
apiVersion: helm-expt.confighub.com/v1alpha1
kind: Stack
metadata:
  name: data-services
spec:
  description: "A stateful data tier: cache, relational database, and message queue."
  components:
    - name: redis
      render: "renders/redis.yaml"
    - name: postgresql
      render: "renders/postgresql.yaml"
    - name: rabbitmq
      render: "renders/rabbitmq.yaml"

$ cat stacks/app-platform.yaml
(same shape; five render components: cert-manager, ingress-nginx, postgresql, redis, kube-prometheus-stack)

$ cat stacks/web-tiny.yaml
apiVersion: helm-expt.confighub.com/v1alpha1
kind: Stack
metadata:
  name: web-tiny
spec:
  description: "A tiny two-component web stack, used to run cub stack install end to end without burning quota."
  components:
    - name: frontend
      authored: "components/frontend-config.yaml"
    - name: backend
      authored: "components/backend-config.yaml"

$ cat stacks/conflict-demo.yaml
apiVersion: helm-expt.confighub.com/v1alpha1
kind: Stack
metadata:
  name: conflict-demo
spec:
  description: "Two components claim the same object with different content. Certify must refuse this composition."
  components:
    - name: team-a
      authored: apps/conflict-a.yaml
    - name: team-b
      authored: apps/conflict-b.yaml

$ ls -R components
backend-config.yaml
frontend-config.yaml
$ cat cub-plugin.yaml
name: workshop
version: 0.3.0
commands:
    - name: config ... entrypoint: bin/cub-config
    - name: app ... entrypoint: bin/cub-app
    - name: stack ... entrypoint: bin/cub-stack
    - name: fleet ... entrypoint: bin/cub-fleet
```

Discovery: conflict-demo is the only shipped example that puts an app from apps/ into a stack, via `authored: apps/<name>.yaml`. That is how I put the shop app into mine. The paths are relative to the plugin root; I guessed that from the examples.

### 8. The shop app and what it needs

```
$ cat plugin-repo/apps/shop-web.yaml
(5 objects in namespace shop: Deployment shop-web (image registry.k8s.io/e2e-test-images/agnhost:2.47, 3 replicas), Service shop-web, Ingress shop-web (ingressClassName nginx, host shop.example.com, tls secret shop-web-tls), Certificate shop-web-tls (issuerRef letsencrypt ClusterIssuer), ServiceMonitor shop-web)

$ cub app check shop-web

App: shop-web
Rendering the workload (free, no infrastructure)

Installs
  5 objects: 1 Deployment, 1 Service, 1 Ingress, 1 Certificate, 1 ServiceMonitor
  namespaces that must already exist: shop

Dependencies (this app needs a platform to provide these)
  [NEEDS] an ingress controller
             Ingress shop-web (class nginx)
  [NEEDS] cert-manager
             Certificate shop-web-tls
  [NEEDS] a Prometheus operator (kube-prometheus-stack)
             ServiceMonitor shop-web

  Install onto a platform that carries those services (for example a cub stack such
  as web-platform), then your Argo CD or Flux reconciles it.

exit=0
```

Composition decision: web platform = cert-manager + ingress-nginx; monitoring = kube-prometheus-stack; message queue = rabbitmq (the only queue among the nine renders); the shop app = shop-web as an authored component. mgmt plane for the platform services, workload plane for rabbitmq and the app, so the CRDs land before the app's Certificate and ServiceMonitor.

### 9. Where does a new manifest go? (wrong turn)

```
$ for d in "$HOME/.confighub" "$HOME/.cub" ...; do find "$d" -maxdepth 4 -name cub-plugin.yaml; done
/Users/alexis/.confighub/plugins/workshop/cub-plugin.yaml
(eight other plugins' cub-plugin.yaml, omitted)

$ cat > shop-platform.yaml <<'EOF2'   (the manifest, see section 12)
$ cub stack certify ./shop-platform.yaml
error: no such stack "./shop-platform.yaml". Try: cub stack list
exit=2
$ cub stack certify shop-platform
error: no such stack "shop-platform". Try: cub stack list
exit=2
```

The verb takes only a name and resolves it inside the installed plugin. No page, README line, or --help text says this. Per the run rules I placed my single new file in the installed plugin's stacks/ directory and record it as a usability finding.

### 10. Place the one new file, certify

```
$ ls /Users/alexis/.confighub/plugins/workshop
DEMO.md LICENSE README.md apps bin components cub-plugin.yaml fleets lib receipts renders stacks
$ grep -m1 version /Users/alexis/.confighub/plugins/workshop/cub-plugin.yaml
version: 0.3.0
$ diff <(ls .../workshop/renders) <(ls plugin-repo/renders) && diff <(ls .../workshop/apps) <(ls plugin-repo/apps) && echo same-file-sets
same-file-sets
$ test ! -e .../workshop/stacks/shop-platform.yaml && cp shop-platform.yaml .../workshop/stacks/shop-platform.yaml && echo copied
copied
$ cub stack list | grep -A1 shop-platform
  shop-platform  —  A web platform with monitoring and a message queue, with the shop app running on it: ingress, certificates, the Prometheus stack, RabbitMQ, and shop-web.
      cert-manager, ingress-nginx, kube-prometheus-stack, rabbitmq, shop-web

$ cub stack certify shop-platform

Stack: shop-platform  —  A web platform with monitoring and a message queue, with the shop app running on it: ingress, certificates, the Prometheus stack, RabbitMQ, and shop-web.
Resolving 5 components: cert-manager, ingress-nginx, kube-prometheus-stack, rabbitmq, shop-web

Certify
  [PASS] no resource conflicts across components (192 objects)
  [PASS] CRD ordering: 10 CRDs are delivered before the 51 custom resources that need them
  [WARN] 5 admission webhook(s) need a caBundle — cert-manager is in the stack and can issue it
  [PASS] namespaces: 0 created, 6 must already exist (cert-manager, ingress-nginx, kube-system, monitoring, rabbitmq, shop)
  => CERTIFIED

exit=0
```

Certify accepted the manifest on the first try, so there was no refusal to fix.

### 11. Sandbox

```
$ date -u +"%Y-%m-%dT%H:%M:%SZ"
2026-09-02T07:04:30Z
$ cub stack sandbox shop-platform

Stack: shop-platform  —  A web platform with monitoring and a message queue, with the shop app running on it: ingress, certificates, the Prometheus stack, RabbitMQ, and shop-web.
Resolving 5 components: cert-manager, ingress-nginx, kube-prometheus-stack, rabbitmq, shop-web

Certify
  [PASS] no resource conflicts across components (192 objects)
  [PASS] CRD ordering: 10 CRDs are delivered before the 51 custom resources that need them
  [WARN] 5 admission webhook(s) need a caBundle — cert-manager is in the stack and can issue it
  [PASS] namespaces: 0 created, 6 must already exist (cert-manager, ingress-nginx, kube-system, monitoring, rabbitmq, shop)
  => CERTIFIED

Sandbox render  (free, no infrastructure)
  192 objects total
      cert-manager: 42  [mgmt]
      ingress-nginx: 11  [mgmt]
      kube-prometheus-stack: 124  [mgmt]
      rabbitmq: 10  [workload]
      shop-web: 5  [workload]  [authored]

  Ready. `cub stack upload shop-platform --run` builds the base Spaces and links in ConfigHub.
```

Wrong turn of my own: I printed `${PIPESTATUS[0]}` after a `tee`, which is empty in zsh, so the first exit code line read `exit=`. Re-run for the code:

```
$ cub stack sandbox shop-platform >/dev/null 2>&1; echo "exit=$?"
exit=0
```

Side effects: `find /Users/alexis/.confighub/plugins/workshop -newer shop-platform.yaml -type f` lists only my manifest; `find "$HOME/.confighub" -newer shop-platform.yaml -type f` (excluding it) lists nothing. The sandbox wrote no rendered YAML anywhere I can find.

### 12. The final manifest (verbatim, the file at .../workshop/stacks/shop-platform.yaml and ./shop-platform.yaml)

```
apiVersion: helm-expt.confighub.com/v1alpha1
kind: Stack
metadata:
  name: shop-platform
spec:
  description: "A web platform with monitoring and a message queue, with the shop app running on it: ingress, certificates, the Prometheus stack, RabbitMQ, and shop-web."
  components:
    - name: cert-manager
      plane: mgmt
      order: 1
      render: "renders/cert-manager.yaml"
    - name: ingress-nginx
      plane: mgmt
      order: 2
      render: "renders/ingress-nginx.yaml"
    - name: kube-prometheus-stack
      plane: mgmt
      order: 3
      render: "renders/kube-prometheus-stack.yaml"
    - name: rabbitmq
      plane: workload
      order: 1
      render: "renders/rabbitmq.yaml"
    - name: shop-web
      plane: workload
      order: 2
      authored: "apps/shop-web.yaml"
```

### 13. Cross-checks after the verdict

```
$ which node oras
/opt/homebrew/bin/node
/opt/homebrew/bin/oras
$ cub stack sandbox shop-platform --out ./render 2>&1 | tail -4
      shop-web: 5  [workload]  [authored]

  Ready. `cub stack upload shop-platform --run` builds the base Spaces and links in ConfigHub.
$ ls ./render
ls: ./render: No such file or directory
```

The unknown flag was ignored silently.

```
$ cub stack certify observability-base   (Certify block only)
Certify
  [PASS] no resource conflicts across components (175 objects)
  [PASS] CRD ordering: 10 CRDs are delivered before the 50 custom resources that need them
  [WARN] 4 admission webhook(s) need a caBundle — cert-manager is in the stack and can issue it
  [PASS] namespaces: 0 created, 3 must already exist (cert-manager, kube-system, monitoring)
  => CERTIFIED
$ cub stack certify web-platform   (Certify block only)
Certify
  [PASS] no resource conflicts across components (177 objects)
  [PASS] CRD ordering: 10 CRDs are delivered before the 50 custom resources that need them
  [WARN] 5 admission webhook(s) need a caBundle — cert-manager is in the stack and can issue it
  [PASS] namespaces: 0 created, 4 must already exist (cert-manager, ingress-nginx, kube-system, monitoring)
  => CERTIFIED
```

The site's "observability-base: 175 objects, 10 CRDs before 50 custom resources" matches. Arithmetic check on my own stack: 177 (web-platform) + 10 (rabbitmq) + 5 (shop-web) = 192, matches. But web-platform has 50 custom resources and shop-web adds two (a Certificate and a ServiceMonitor), so I expected 52 and the check reports 51; see Findings.

```
$ sed -n '95,120p' custom-stacks.txt
How a custom stack would flow
... They pick components, or an assistant assembles a candidate stack from a goal. The system certifies the composition. ... The certified stack is published to ConfigHub and the catalog as a named stack, as a bundle with receipts. cub stack <name> installs it, and sandbox renders it for free ... Delivery goes through the reconciler the team already runs, which is Argo CD or Flux, and the reviewed result stays in ConfigHub.
$ grep -n -i -E 'brew|curl .*install|install-cub|cub CLI' try.txt | head
19:    curl -fsSL https://hub.confighub.com/cub/install.sh | bash
$ date -u +"%Y-%m-%dT%H:%M:%SZ"
2026-09-02T07:05:25Z
```

## What I had to guess

- That `authored:` may point at a file under apps/ (only conflict-demo shows it) and that all "repo paths" resolve against the plugin root, not my working directory. Confirmed by it working from the scratchpad.
- That the plane names in the spec (`mgmt`, `workload`) are accepted by the render-form path; no shipped render-form stack uses planes, only eks-inference does. Confirmed by the `[mgmt]`/`[workload]` tags in the sandbox output.
- That the installed plugin is the same version as the public repo (0.3.0, identical renders/ and apps/ file sets), so reading the clone was a fair substitute for reading the install.
- That "message queue" means rabbitmq: it is the only queue among the nine renders, and the site never lists the nine renders, only the stacks composed from them.

## Findings

### (1) Final verdict and object count, verbatim

```
  => CERTIFIED
Sandbox render  (free, no infrastructure)
  192 objects total
      cert-manager: 42  [mgmt]
      ingress-nginx: 11  [mgmt]
      kube-prometheus-stack: 124  [mgmt]
      rabbitmq: 10  [workload]
      shop-web: 5  [workload]  [authored]
```

with `[PASS] no resource conflicts across components (192 objects)`, `[PASS] CRD ordering: 10 CRDs are delivered before the 51 custom resources that need them`, `[WARN] 5 admission webhook(s) need a caBundle — cert-manager is in the stack and can issue it`, `[PASS] namespaces: 0 created, 6 must already exist (cert-manager, ingress-nginx, kube-system, monitoring, rabbitmq, shop)`. Exit code 0 for both certify and sandbox.

### (2) The three hardest things to discover

1. Where a manifest of my own has to live. `cub stack certify ./shop-platform.yaml` answers `no such stack`; the verbs take a name and resolve it only inside the installed plugin, and `cub plugin list` prints no paths, so I had to search $HOME for cub-plugin.yaml to find /Users/alexis/.confighub/plugins/workshop/stacks/. Nothing on the site, in README.md, in DEMO.md, or in `cub stack --help` says this. Writing into an installed plugin's directory is the usability finding the run rules anticipated. (README.md does say "drop the file into apps/" for apps, which hints that editing the install is the intended way, but only for apps.)
2. How to put the shop app into the stack. The spec calls the third form "authored: literal YAML the stack owns" and gives "<repo path>"; the only shipped example that reuses an app file that way is conflict-demo, the stack that exists to be refused. Everything else about the format (planes, order, exactly one form per component) came from the spec page, which was easy to find from stack.html.
3. Which parts exist to compose from. stack.html lists eleven stacks but never the nine render components; the queue (rabbitmq) and the fact that shop-web needs exactly ingress + cert-manager + a Prometheus operator were only learnable by cloning the repository (`ls renders/`) and running `cub app check shop-web`.

### (3) What the site or plugin said that turned out wrong, or not quite right

- The site's install line `cub plugin install confighub/cub-workshop` exits 1 here ("plugin "workshop" is already installed"). The site never says the plugin's installed name is "workshop", so the `cub plugin upgrade workshop` remedy is not discoverable from the site; the CLI message supplies it.
- stack.html and the spec say sandbox "renders" the stack "for free", and the home page promises "see the exact objects". At stack altitude the sandbox prints per-component counts and nothing else; no rendered YAML is written anywhere under the plugin or ~/.confighub, and an `--out` flag is ignored silently. A user cannot inspect the 192 objects the verdict is about.
- The CRD-before-CR count moved by one, not two, when I added shop-web, which carries a Certificate and a ServiceMonitor (web-platform: 50 custom resources; mine: 51). Either one of the app's custom resources is not being matched to its CRD, or the count is defined differently from what the line says. The output does not say which resources it counted, and finding out would mean reading lib/, which this run forbids.
- Nothing wrong was found in the numeric claims I could test offline: observability-base "175 objects, 10 CRDs before 50 custom resources" matches; web-platform "carries what an app like shop-web depends on" agrees with `cub app check shop-web`; the certify checks named on stack.html are the four the tool ran.
- Not wrong but worth naming: the manifest form has no inline YAML, so creating the six missing namespaces (or the `letsencrypt` ClusterIssuer the app's Certificate references) needs a second authored file inside the plugin directory; I did not add one because the run allowed a single new file.

### (4) From this verdict to the thing running in a ConfigHub org, as the site describes it

- An account and an org I can write to: sign in to the hosted hub (hub.confighub.com) or run the self-hosted sandbox from `cub server`; nothing in this run touched either.
- `cub stack upload shop-platform` to see the plan, then `cub stack upload shop-platform --run`, which certifies again and builds one base Space per component plus the profile links the manifest declares. My manifest declares no bindings, so there is nothing to wire between rabbitmq and shop-web; the app's image is a test image and the queue is composed beside it, not integrated with it.
- Then the generic verbs the site names: `cub variant create` to place each base on a target, `cub release publish` to release by digest, `cub variant promote` to move a reviewed change up the tree, with gates and ChangeOrders for governance.
- Delivery by the reconciler I already run (Argo CD or Flux) pulling the published OCI digest, onto a cluster where the six namespaces already exist (the stack creates none), a `letsencrypt` ClusterIssuer exists for shop-web-tls, DNS for shop.example.com points at the ingress, and cert-manager has actually issued the five webhook caBundles. The spec is explicit that waiting for the mgmt plane before the workload plane "remains the deliverer's job".
- Only after that would the site's fourth question, "did it work?", have live evidence; everything in this run answers only "what will it produce?".
