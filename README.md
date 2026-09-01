# cub-stack

A cub plugin: a certified composition of components, spoken by name.

    cub plugin install <this repo>
    cub stack list
    cub stack sandbox eks-inference     # certify + render 130 objects, free, no infrastructure
    cub stack certify conflict-demo     # the gate refusing a broken composition
    cub stack upload <name> --run       # build the base Spaces in ConfigHub

Components are digest-pinned certified bundles, pulled once and hash-verified
against the receipts shipped in receipts/ before a single object parses, or
authored YAML the stack owns. This is the prototype of the proposed stack
verb, packaged as a real plugin; requires node, oras, and cub.

Receipts and stack definitions derive from the public evidence in
confighub/helm-expt at the pinned digests they name.
