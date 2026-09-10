# Kubara shop platform — local workspace, one change, one refusal

All work was local. No cluster, account, registry push, or credential was contacted.
Everything below is the output of commands actually run in this directory with
`CUB_CONFIG` pointed at `./config`; cub client v0.4.4.

## 1. Saved the stack as an editable workspace

```
cub stack sandbox kubara-shop-platform --workspace ./platform     # exit 0
```

Certified before writing anything: 135 objects across 5 components
(cert-manager 46, traefik 31, metrics-server 9, external-secrets 44, shop-web 5).
Checks: no resource conflicts; 56 CRDs ordered before the 2 custom resources that
need them; served API versions matched; app needs met (ingress controller,
cert-manager, external-secrets all carried by the stack); namespaces 0 created,
5 must already exist. One WARN: 4 admission webhooks need a `caBundle`, which
cert-manager in this stack can issue. Verdict **CERTIFIED**.

Wrote `platform/stack.yaml`, `platform/components/01..05-*.yaml`,
`platform/rendered.yaml`, and `platform/result.json`.

## 2. The one change

`platform/components/05-shop-web.yaml`, `shop-web` Deployment, `spec.replicas: 3 → 2`.
Nothing else was touched. Confirmed by a full-file diff of the two renders:

```
64316c64316
<   replicas: 3
---
>   replicas: 2
```

That is the entire difference between `rendered.yaml` and `changed.yaml` — one line.

```
cub stack certify ./platform/stack.yaml --json > ./platform/changed-result.json   # exit 0, certified: true
cub stack sandbox ./platform/stack.yaml --out ./platform/changed.yaml             # exit 0, 135 objects
```

Certification was run first and passed; only then was the render written.

### Render hashes

| Render | SHA-256 | Bytes |
|---|---|---|
| baseline `platform/rendered.yaml` | `9f5b637c96a19137c533a95b34652f3a27840dabab12ea7e1fc525ec206d97f8` | 3634443 |
| changed `platform/changed.yaml` | `82b2c60892442f86dcd6cb843beaec4cce23d713aa20de8ae928c74fcdbacf54` | 3634443 |

Both hashes were verified two ways: `shasum -a 256` on the files on disk, and the
`renderedFile.sha256` field each certification wrote into its own JSON result.
They agree. Byte counts are identical because `3` and `2` are the same width.

The baseline was preserved, not disguised: `platform/rendered.yaml` still hashes to
`9f5b…97f8`, exactly what the original `platform/result.json` recorded. The original
`result.json` and `rendered.yaml` were never rewritten.

Note on the JSON: `changed-result.json` reports `renderedFile.path` as
`kubara-shop-platform.yaml` — the name a default sandbox would use — while the file
was written to `changed.yaml` via `--out`. The hash, not the path, is what identifies
the bytes, and the hash matches `changed.yaml`.

## 3. The refusal

`platform/` was copied to `incompatible/` with replicas still at 2, then exactly one
line changed in `incompatible/components/05-shop-web.yaml`:

```
70c70
< apiVersion: external-secrets.io/v1
---
> apiVersion: external-secrets.io/v1beta1
```

```
cub stack certify ./incompatible/stack.yaml --json > ./incompatible/refusal.json   # exit 1
```

**Exit 1, `certified: false`, verdict REJECTED.** The failing check:

> `[FAIL] 1 custom resource API(s) cannot be resolved against the bundled CRDs:`
> `external-secrets.io/v1beta1|ExternalSecret|shop|shop-web-db: version-not-served; externalsecrets.external-secrets.io serves v1`

**Why:** the `external-secrets` CRD bundled in this very stack serves `v1` for
`externalsecrets.external-secrets.io`. `v1beta1` is not a served version there, so the
`shop-web-db` ExternalSecret names an API that nothing in the composition can accept.
The refusal comes from comparing the resource against the bundled CRD, not from
querying any cluster. The other checks still passed — conflicts, CRD ordering, app
needs, namespaces — which is why the result is a targeted refusal rather than a
general failure.

The broken resource was left exactly as-is: not repaired, not removed. No render was
produced for it.

Caveat on the copied folder: `incompatible/rendered.yaml`, `changed.yaml`,
`result.json` and `changed-result.json` are inherited copies from the certified
2-replica workspace. They describe that certified state, **not** the refused
`v1beta1` edit. Only `incompatible/refusal.json` describes the refused candidate.
`refusal.json` does carry a `renderedFile.sha256`
(`9136bc8f55e1ea022dceaaa2754b051eda42710329d958ffaa86d5ff4dff78d6`, 3634448 bytes)
— a byte hash of a rejected candidate. Per the plugin's own documentation, that hash
does not make it approved or published, and no such file was written.

## 4. What is still unverified

Both certifications record the same scope, verbatim from the JSON:

```json
{"mode": "static-composition", "targetAvailability": "not-checked", "applicationHealth": "not-checked"}
```

Specifically unverified:

- **Target availability.** No cluster or API server was contacted. Whether a target
  cluster actually serves `external-secrets.io/v1` at runtime was never checked; the
  version check compared against the CRD bundled in the stack.
- **Namespaces.** The check reports 5 namespaces that *must already exist*
  (`cert-manager`, `external-secrets`, `kube-system`, `shop`, `traefik`) and 0 created
  by this stack. Their existence was not confirmed anywhere.
- **A cert-manager issuer.** The `shop-web-tls` Certificate references ClusterIssuer
  `letsencrypt`. Nothing in this stack creates it, and its presence was not checked.
- **A secret store.** The ExternalSecret references ClusterSecretStore
  `platform-store` and remote key `shop/db`. Not created here, not checked.
- **Webhook caBundle.** The open WARN: 4 admission webhooks need a caBundle. The
  stack can issue it via cert-manager, but that it *was* issued is unobserved.
- **Application health.** No pod was scheduled, no request was served, no response
  was observed.
- **Publication.** This is a local workspace, not a published OCI artifact. These
  edits are new local configuration, not updates to the original published bundles
  or their certification.

## 5. Does this prove the app runs?

**No.** It proves something narrower and worth being precise about: a static
composition check passed, and a set of YAML bytes was rendered and hashed.

What was actually established — the 135 objects do not conflict, CRDs are ordered
before the resources needing them, the custom resource API versions match the CRDs
shipped alongside them, shop-web's declared platform needs are carried by this stack,
and a single deliberate replica edit changed exactly one line of output and nothing
else. The refusal case shows the version check has teeth: it caught a one-token API
change and rejected the whole candidate.

What was not established — that any cluster exists, that it would accept these
objects, that the namespaces, issuer and secret store are present, that images pull,
that pods become ready, or that shop-web answers a request. Certification is a
composition gate, not a deployment approval and not a health signal. `replicas: 2`
here means two replicas are *declared*, not two running.

## Artifacts

| Path | What it is |
|---|---|
| `platform/result.json` | baseline certification, `certified: true`, preserved unmodified |
| `platform/rendered.yaml` | baseline render, `9f5b…97f8`, preserved unmodified |
| `platform/changed-result.json` | certification of the 2-replica stack, `certified: true` |
| `platform/changed.yaml` | render of the 2-replica stack, `82b2…cf54` |
| `incompatible/refusal.json` | `certified: false`, exit 1, version-not-served |
| `incompatible/components/05-shop-web.yaml` | the `v1beta1` resource, left unrepaired |
