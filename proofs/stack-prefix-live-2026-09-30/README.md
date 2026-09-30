# `--space-prefix` names Components too: live run, 2026-09-30

This run checks #88 against a hosted ConfigHub organization, with cub v0.6.8 and `cub kubara` 0.2.3. The stack was the two-cluster platform from `tests/fixtures/kubara-platform`, built with `cub stack from-kubara`: three components, hub and spoke.

## A stack uploaded by v0.6.54, then rerun with this change

- `a1.log`: the released v0.6.54 uploads with `--space-prefix cw88a-0930`. It creates 8 Spaces named `cw88a-0930-…`, and three bare Components: `argo-cd`, `bootstrap-crds` and `web`.
- `a2.log`: this change reruns the same command. Every upload lands in the existing Spaces, each variant is "already cloned", and no Space is added. The Components are now named `cw88a-0930-…`; the three bare Components remain but hold no Spaces.

So an old prefixed stack moves over in place. Delete its empty bare Components afterwards with `cub component delete <name>`.

## A fresh upload with this change, run twice

- `b1.log`: `--space-prefix cw88b-0930 --run` creates the same 8 Space names as before, and Components `cw88b-0930-argo-cd`, `cw88b-0930-bootstrap-crds` and `cw88b-0930-web`. No bare Component is created.
- `b2.log`: the rerun finds all 5 variants already cloned and re-uploads the bases in place.

## Cleanup

Every Space and Component the run created was deleted, including the three bare ones from `a1`. The organization's Components and Spaces were listed before the run and compared after it; nothing was added or removed. Paths in the logs are replaced with `$LAB` and `$WORKSHOP`.

Not covered: links. This stack declares no bindings, so link planning ran with nothing to link.
