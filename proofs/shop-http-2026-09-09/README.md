# Kubara demo app HTTP listener

The retained agnhost 2.47 image defaults to `/agnhost pause`. Merely declaring
containerPort 8080 did not start a server. The Kubara app now selects
`serve-hostname --http=true --port=8080`, pins the observed image digest, and
uses an HTTP readiness probe on the same port as its Service target.

receipt.json records two serial local Linux/arm64 container runs: the default
command produced no HTTP response within the bounded probe window; the explicit
listener returned HTTP 200 with a nonempty hostname. Both temporary containers
were removed. app.yaml retains the exact edited source and its recorded hash.

Run `python3 proofs/shop-http-2026-09-09/run.py` from the repository root to repeat
this local container check with Docker. It binds only a random loopback port and
stops each container before starting the next. The test
`node --test tests/shop-http-evidence.test.mjs` checks the retained receipt and
current listener/Service/probe agreement without Docker.

This is a test app returning its hostname, not a business shop or database client.
No Kubernetes cluster, ingress, certificate, secret store or ConfigHub release was
used. This response does not complete the Kubara live proof, controller observation,
rollout, rollback or target cleanup acceptance. The historic assistant trial keeps
its earlier input revision and does not validate this newer app automatically.
