# Inspect local edits

cub config diff before.yaml candidate-a.yaml --json --exit-code --out candidate-a.json

The command compares local Kubernetes YAML and retains exact input file hashes,
object identities, field changes and omitted checks. It contacts no target.
With --exit-code: 0 means equal inputs, 1 means differences, 2 means invalid input
or another error. Without --exit-code, a successful comparison returns 0 even
when it finds changes. Existing output files refuse overwrite. Keep expected
nonzero exits while continuing the task. Arrays are reported as whole values.
The tool produces a diff, not an approval. It does not merge upstream changes,
protect local fields, validate schemas, upload or prove an application runs.
