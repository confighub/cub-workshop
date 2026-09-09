# Local workshop results

Completed using the configured cub-workshop 0.6.14 runtime and the command surface in WORKFLOW.md. All work was local to this directory. Nothing was installed, upgraded, published or uploaded; no cluster was contacted, no credentials were read, and no work was delegated.

## Commands and actual results

1. `cub stack sandbox kubara-shop-platform --workspace ./platform` exited 0, certified the composition, and saved an editable workspace with five components and 135 objects. Its original `platform/result.json` and `platform/rendered.yaml` remain unchanged.
2. Edited only `spec.replicas` in Deployment `shop/shop-web` in `platform/components/05-shop-web.yaml`, from 3 to 2.
3. `cub stack certify ./platform/stack.yaml --json > ./platform/changed-result.json` exited 0 with `certified: true`. Only after it succeeded, `cub stack sandbox ./platform/stack.yaml --out ./platform/changed.yaml` ran and exited 0, rendering 135 objects.
4. `git diff --no-index ./platform/rendered.yaml ./platform/changed.yaml` exited 1 because it found the expected single-line difference: `replicas: 3` became `replicas: 2` on the shop-web Deployment. No other render bytes changed.
5. `cp -R platform incompatible` exited 0. In `incompatible/components/05-shop-web.yaml`, changed only the shop app's ExternalSecret `shop/shop-web-db` apiVersion from `external-secrets.io/v1` to `external-secrets.io/v1beta1`. Deployment replicas remain 2.
6. `cub stack certify ./incompatible/stack.yaml --json > ./incompatible/refusal.json` exited 1 with a complete JSON result and `certified: false`. This was a certification refusal, not an execution error.

## Render hashes and preservation

SHA-256 values were recomputed from the actual files and matched their corresponding JSON `renderedFile.sha256` fields. Both renders are 3,634,443 bytes.

| File | SHA-256 |
| --- | --- |
| `platform/rendered.yaml` (original baseline) | `9f5b637c96a19137c533a95b34652f3a27840dabab12ea7e1fc525ec206d97f8` |
| `platform/changed.yaml` (replicas 2) | `82b2c60892442f86dcd6cb843beaec4cce23d713aa20de8ae928c74fcdbacf54` |

The original `platform/result.json` SHA-256, recorded before editing and verified afterward, is `c46cfd3fa47ed6b10bcc2c2c708f86f3ff3932da457f5faf13d9dcaacb9511f7`. Every original workspace file matched the baseline inventory hashes after reversing only the replica edit in memory for comparison. Baseline files were not rewritten.

Byte comparisons also verified that incompatible contains an exact copy of every platform file except the single ExternalSecret API-version edit, plus the new refusal.json. Its inherited result.json/rendered.yaml and changed-result.json/changed.yaml are historical evidence copied from platform; they do not certify or render the incompatible candidate.

## Refusal and limits

The refusal identifies `external-secrets.io/v1beta1|ExternalSecret|shop|shop-web-db: version-not-served; externalsecrets.external-secrets.io serves v1`. The bundled CRD does not serve the requested version. The incompatible resource remains present and uncorrected. No sandbox render was run for that candidate. The refusal's candidate render hash is `9136bc8f55e1ea022dceaaa2754b051eda42710329d958ffaa86d5ff4dff78d6` (3,634,448 bytes); this hash is not approval or publication evidence.

Baseline and changed certification passed resource-conflict checks, ordering of 56 CRDs before two custom resources, served-version matching, and declared app dependency checks. Both retained the warning that four admission webhooks need a caBundle; including cert-manager does not establish that those bundles are ready. The refusal retained this warning too.

All results explicitly mark scope as `static-composition`, with `targetAvailability: not-checked` and `applicationHealth: not-checked`. Target prerequisites remain unverified: the existing namespaces `cert-manager`, `external-secrets`, `kube-system`, `shop`, and `traefik` (the stack creates none); the `letsencrypt` ClusterIssuer; the `platform-store` ClusterSecretStore and access to the referenced `shop/db` password; target API/CRD availability; and controller, webhook, certificate, secret and ingress readiness. No live scheduling, image startup, DNS/routing or application response was tested.

This proves that the replica-only candidate passes the implemented static composition checks and that the incompatible API version is refused. It does not prove that the app runs. Nothing was deployed or published.
