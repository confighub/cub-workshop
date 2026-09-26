# Choosing a worked example

For a request about what a first app looks like, an existing chart, Argo CD,
Flux, app settings, a platform, or GPU configuration, start with the packaged
public example snapshot:

```sh
cub config examples 'the user problem in plain words' --json
```

The default result includes only public, maintained walkthroughs whose source
and guide paths were verified. `--all` exposes candidates and source-reviewed
references for research; do not present those as admitted runnable routes.
Read the selected pinned human and AI guides before suggesting or executing a
step. Name its required tools, credentials, effects, first useful artifact,
stop condition, and the static, connected, controller, and runtime evidence
separately. A source check or local preview does not prove delivery or health.

The JSON is read-only data copied from `confighub/examples`; its exact source
revision and content hash are in `catalog/source.json`. The command does not
download or run the example. A human can use the same command and open the
returned canonical guide. `cub config list --role` still serves the separate
chart catalog.
