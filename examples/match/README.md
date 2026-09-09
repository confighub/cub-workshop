# Compare a retained model with a supplied Node snapshot

This is an offline comparison, not deployment or inference proof. The model is
an unchanged copy from the Catalog's retained KServe source:

- Repository: [confighub/helm-expt](https://github.com/confighub/helm-expt)
- Revision: `dd9d7f7c54b24e480e887c18447e1cee611192fc`
- Source: `examples/aicr/kserve-nim-inference/upstream/kserve/nim-models/llama3-8b-instruct_2h100_1.0.0.yaml`
- File SHA-256: `a87b0aec9b6d8b3d34bb645fa6bd3ef1957160aa5cd3104e9004b050b2f984e6`

`nodes.yaml` is an illustrative fixture, not a real target observation. It declares
two GPUs and the exact label that this workload requests on one node.

From this plugin checkout, try:

```sh
node bin/cub-app match examples/match/model.yaml --target examples/match/nodes.yaml --out match-result.json
```

With the plugin installed, the same command is `cub app match`. Both file paths
may be anywhere on disk. Add `--json` for assistants. No account, cluster access,
registry access or network request is used. Existing output files are never overwritten.

Expected: `CANDIDATE`, a saved result with hashes of both input files, each node's
checks, omitted checks and the next action. Edit the fixture's GPU count to `1`
and rerun with another output name: the result is `MISMATCH`. Two one-GPU nodes
also mismatch: the two-GPU requirement is per replica, not a fleet total.

To use supplied cluster facts, export the Nodes yourself using an explicitly
selected context, then pass that file to the matcher:

```sh
kubectl --context YOUR_CONTEXT get nodes -o yaml > nodes.yaml
cub app match model.yaml --target nodes.yaml --json --out match-result.json
```

The command accepts one `serving.kserve.io/v1beta1` InferenceService and `v1`
Node documents, a NodeList, or a List containing Nodes. Other workload shapes,
including NIMService, currently refuse rather than being guessed. It does not
select a model for you or validate a whole inference platform.

Exit 0 means at least one node satisfies the supplied selectors and declared GPU
count. Exit 1 means a mismatch or invalid input (invalid input reports an error).
Exit 3 means missing facts prevent a conclusion. Empty snapshots refuse.
Missing allocatable GPU data is unknown; explicit zero is a mismatch. A node's
supplied label map without a requested label is a mismatch; an absent label map
is unknown. Workloads without selectors remain unknown.

Allocatable is not free capacity. Snapshot authenticity and freshness, occupancy,
GPU memory and partitioning, runtime compatibility, other resources, affinity,
taints, scheduling, replicas/autoscaling, serving controllers, storage, credentials,
model entitlement and inference responses are not checked. A candidate is only
an input to target qualification. This does not change the Catalog's blocked GPU
execution status in issue #1581.

For an assistant: run the same local comparison, retain its JSON, explain missing
facts and omitted checks, and propose the next action. Do not convert `candidate`
into “ready”, deploy anything, or fetch credentials. The deterministic result is
the comparison evidence; the assistant's explanation is not a new receipt.
