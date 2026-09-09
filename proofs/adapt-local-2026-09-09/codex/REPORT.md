Both candidates change the apps/v1 Deployment `monitoring/prometheus-server`.

| Candidate | Actual field changes | Within requested edit |
| --- | --- | --- |
| candidate-a | `/spec/replicas`: 1 → 2 | Yes |
| candidate-b | `/spec/replicas`: 1 → 2; `/spec/revisionHistoryLimit`: 10 → 5 | No |

Candidate B includes an unrequested revision history limit change. Its unexpected JSON Pointer is `/spec/revisionHistoryLimit`. This change remains preserved in the input and diff; no YAML content was repaired or overwritten. The judgments in `review.json` use every change reported by the actual diffs.

Both initial comparisons used `cub config diff before.yaml candidate-<a|b>.yaml --json --exit-code --out candidate-<a|b>.json`, separately for each candidate. Both returned exit 1, recorded from the actual processes in `exit-codes.json`. Here exit 1 means differences were found, not approval or policy refusal. Exit 0 means equal inputs; exit 2 means invalid input or another error.

All three input YAML files were moved into `moved/`. Both comparisons were rerun with `moved/` input paths and `--json --exit-code --out`, producing `moved/candidate-a.json`, `moved/candidate-b.json`, and actual exit codes in `moved/exit-codes.json`. Both reruns returned 1. The original and rerun diff files are byte-for-byte identical, and their parsed JSON results are identical. SHA-256 hashes of all three inputs are unchanged and match the hashes in the diff outputs. See `input-hashes.json`, `moved/input-hashes.json`, and `move-verification.json` for verification evidence.

This was a local configuration comparison using the existing Workshop installation and this directory's isolated CUB_CONFIG. It performed no upstream merge, protected no field, changed nothing in ConfigHub, and observed no running application. No install, upgrade, credential inspection, target or registry contact, upload, deployment, or configuration-content edit was performed.

The diff provides no guarantee of Kubernetes schema or admission validity, upstream merge correctness or protected-field preservation, target readiness or live drift, or application availability. It applies no Kubernetes defaulting or schema interpretation. Object identity includes API version and explicit namespace; mapping and document order are ignored, arrays are compared as whole values, and missing values differ from null. Being within the requested edit is only a judgment about the reported local changes.
