#!/usr/bin/env node
// cub fleet — placement as data: which stacks and apps land on which clusters.
//
//   cub fleet list
//   cub fleet up <name>       scaffold the clusters, upload the bases, place and release every component
//   cub fleet age <name>      replay the demo operations the manifest declares, so the fleet shows real attention states
//   cub fleet status <name>   the four attention tiles, recomputed from fleet queries
//   cub fleet down <name>     delete everything the fleet manifest names
//
// A fleet manifest lists clusters and placements. A placement's component is a
// digest-pinned certified bundle, receipt-verified, or authored YAML shipped
// with the plugin. The attention states a fleet view renders are the residue
// of operations, so `age` replays the ladder rather than faking any state.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cub, fail, pluginRoot, readYamlFile } from "./common.mjs";

const FLEETS_DIR = join(pluginRoot, "fleets");
const args = process.argv.slice(2);
const verb = args[0];
const name = args[1];

function loadFleet(fleetName) {
  const path = join(FLEETS_DIR, `${fleetName}.yaml`);
  if (!existsSync(path)) fail(`no such fleet "${fleetName}". Try: cub fleet list`);
  const fleet = readYamlFile(path);
  const clusters = (fleet.spec?.clusters ?? []).map((cluster) => cluster.name);
  // A placement names an app, or a whole stack, which expands to one placement
  // per component: bundle components by digest, the rest by their shipped path.
  const expand = (placement) => {
    if (!placement.stack) return [placement];
    const stackPath = join(pluginRoot, "stacks", `${placement.stack}.yaml`);
    if (!existsSync(stackPath)) fail(`placement names unknown stack ${placement.stack}`);
    const stack = readYamlFile(stackPath);
    return (stack.spec?.components ?? []).map((comp) => ({
      app: comp.name,
      team: placement.team ?? stack.metadata?.name ?? placement.stack,
      bundle: comp.bundle ?? null,
      authored: comp.render ?? comp.authored ?? null,
      clusters: placement.clusters,
    }));
  };
  const placements = (fleet.spec?.placements ?? []).flatMap(expand).map((placement) => ({
    ...placement,
    clusters: placement.clusters.includes("*") ? clusters : placement.clusters,
  }));
  for (const placement of placements) for (const cluster of placement.clusters) {
    if (!clusters.includes(cluster)) fail(`placement ${placement.app} names unknown cluster ${cluster}`);
  }
  return { name: fleet.metadata?.name ?? fleetName, clusters: fleet.spec?.clusters ?? [], clusterNames: clusters, placements, demoAging: fleet.spec?.demoAging ?? [] };
}

const spaceExists = (space) => { try { cub(["space", "get", space, "-o", "name"]); return true; } catch { return false; } };

if (verb === "list") {
  console.log("\nAvailable fleets\n");
  for (const file of readdirSync(FLEETS_DIR).filter((entry) => entry.endsWith(".yaml")).sort()) {
    const fleet = readYamlFile(join(FLEETS_DIR, file));
    const placements = fleet.spec?.placements ?? [];
    console.log(`  ${fleet.metadata?.name ?? file}  —  ${fleet.spec?.description ?? ""}`);
    console.log(`      ${(fleet.spec?.clusters ?? []).length} cluster(s), ${placements.length} component(s)`);
  }
  console.log("\ncub fleet up <name>   # build the whole fleet\n");
} else if (verb === "plan") {
  if (!name) fail("usage: cub fleet plan <name>");
  const fleet = loadFleet(name);
  console.log(`\nFleet ${fleet.name}: ${fleet.clusterNames.length} clusters, ${fleet.placements.length} placements after expanding stacks\n`);
  for (const placement of fleet.placements) {
    const source = placement.bundle ? `image ${placement.bundle.replace(/^.*@/, "@").slice(0, 20)}` : `path ${placement.authored}`;
    console.log(`  ${placement.app.padEnd(24)} ${String(placement.clusters.length).padStart(3)} cluster(s)  ${source}`);
  }
  console.log(`\n  Dry run. cub fleet up ${fleet.name} builds it.\n`);
} else if (verb === "up") {
  if (!name) fail("usage: cub fleet up <name>");
  const fleet = loadFleet(name);
  const spacesNeeded = fleet.clusterNames.length + fleet.placements.length + fleet.placements.reduce((sum, placement) => sum + placement.clusters.length, 0);
  console.log(`\nFleet ${fleet.name}: ${fleet.clusterNames.length} clusters, ${fleet.placements.length} components, ${spacesNeeded} Spaces when complete\n`);
  try {
    for (const cluster of fleet.clusters) {
      if (spaceExists(cluster.name)) { console.log(`  ${cluster.name}: already scaffolded, left as is`); continue; }
      cub(["space", "create", cluster.name, "--label", "Owner=Meridian"]);
      cub(["worker", "create", "worker", "--space", cluster.name, "--is-server-worker"]);
      cub(["target", "create", "target", "{}", "worker", "--space", cluster.name, "-p", "OCI", "-t", "Any"]);
      console.log(`  ${cluster.name}: cluster space, worker, OCI target`);
    }
    for (const placement of fleet.placements) {
      if (!spaceExists(`${placement.app}-base`)) {
        const owner = placement.team ?? fleet.name;
        if (placement.bundle) {
          cub(["variant", "upload", "--component", placement.app, "--variant", "base", "--granularity", "per-file", "--owner", owner, placement.bundle]);
        } else {
          cub(["variant", "upload", "--component", placement.app, "--variant", "base", "--granularity", "per-resource", "--owner", owner, join(pluginRoot, placement.authored)]);
        }
        console.log(`  ${placement.app}-base uploaded (${placement.team ?? "fleet"})`);
      }
      let placed = 0;
      for (const cluster of placement.clusters) {
        if (spaceExists(`${placement.app}-${cluster}`)) continue;
        cub(["variant", "create", cluster, `${placement.app}-base`, "--target", `${cluster}/target`]);
        cub(["release", "publish", `${placement.app}-${cluster}`]);
        placed += 1;
      }
      console.log(`  ${placement.app}: ${placed ? `placed and released on ${placed} cluster(s)` : "already placed everywhere, left as is"}`);
    }
  } catch (error) {
    const detail = `${error.stderr ?? ""}${error.stdout ?? ""}${error.message ?? ""}`;
    if (/quota/i.test(detail)) {
      console.error(`\nStopped: the server refused with a quota error before the fleet was complete.`);
      console.error(`This fleet needs ${spacesNeeded} Spaces plus whatever the organization already holds.`);
      console.error(`Raise the Space quota (on a self-hosted sandbox it is the entity_quota table), then`);
      console.error(`re-run cub fleet up ${fleet.name} — it resumes where it stopped, skipping what exists.\n`);
      process.exit(1);
    }
    throw error;
  }
  console.log(`\nFleet ${fleet.name} is up. Next: cub fleet age ${fleet.name}, then cub fleet status ${fleet.name}.\n`);
} else if (verb === "age") {
  if (!name) fail("usage: cub fleet age <name>");
  const fleet = loadFleet(name);
  for (const op of fleet.demoAging) {
    try {
    if (op.kind === "pending" || op.kind === "advance-base") {
      const space = op.kind === "pending" ? op.space : `${op.component}-base`;
      // Each aging run stamps a new value, so a rebuilt fleet ages again instead
      // of finding the annotation already there and recording no revision.
      const [key, base] = op.annotation.split("=");
      const value = `${base}-${new Date().toISOString().slice(0, 16).replace(/\D/g, "")}`;
      cub(["function", "do", "--space", space, "--where", op.where, "set-annotation", key, value,
        "--change-desc", op.kind === "pending" ? "Aging: an edit after release, pending deployment" : "Aging: the base advances after placement"]);
      console.log(`  ${op.kind}: ${space}`);
    } else if (op.kind === "gate") {
      try { cub(["trigger", "create", "require-approval", "Mutation", "Kubernetes/YAML", "vet-approvedby", "1", "--space", op.space]); }
      catch { console.log(`  gate already armed: ${op.space}`); continue; }
      const spaceId = JSON.parse(cub(["space", "get", op.space, "-o", "json"])).Space?.SpaceID;
      cub(["space", "update", "--patch", op.space, "--where-trigger", `SpaceID='${spaceId}'`, "--refresh-triggers"]);
      console.log(`  gate armed: ${op.space}`);
    } else if (op.kind === "changeorder") {
      let existing = "";
      try { existing = cub(["changeorder", "list", "--space", `${op.component}-base`, "-o", "name"]); } catch { /* none */ }
      if (existing.includes(op.name)) { console.log(`  changeorder already open: ${op.name}`); continue; }
      cub(["changeorder", "create", op.name, "--space", `${op.component}-base`, "--in-scope-space", op.scope.join(","),
        "--description", "A change rolling across the fleet, tracked as one ChangeOrder."]);
      cub(["function", "do", "--space", `${op.component}-base`, "--where", "Slug = 'upstream'",
        "set-annotation", "meridian.example/rollout", "wave-1", "--change-desc", "Aging: the change the ChangeOrder rolls across the fleet"]);
      console.log(`  changeorder opened: ${op.name} (${op.scope.length} spaces in scope)`);
    }
    } catch (error) {
      // A partial fleet (a quota stop, a placement not yet made) skips the
      // operations whose Spaces are absent rather than aborting the aging.
      const reason = String(error.stderr ?? error.message).trim().split("\n").pop();
      console.log(`  skipped ${op.kind}${op.space ? ` on ${op.space}` : op.component ? ` on ${op.component}` : ""}: ${reason}`);
    }
  }
  console.log("\nAged. cub fleet status shows the attention tiles.\n");
} else if (verb === "status") {
  if (!name) fail("usage: cub fleet status <name>");
  const fleet = loadFleet(name);
  const fleetSpace = (line) => {
    const space = line.split("/")[0];
    return fleet.clusterNames.some((cluster) => space.endsWith(`-${cluster}`)) || space.endsWith("-base");
  };
  const rows = (out) => out.trim().split("\n").filter(Boolean);
  const unreleased = rows(cub(["unit", "list", "--space", "*", "--where", "HeadRevisionNum > LastReleasedRevisionNum", "-o", "name"]))
    .filter((line) => fleetSpace(line) && !line.split("/")[0].endsWith("-base"));
  const upgrades = rows(cub(["unit", "list", "--space", "*", "--where", "UpstreamRevisionNum < UpstreamUnit.HeadRevisionNum", "-o", "name"])).filter(fleetSpace);
  const gated = rows(cub(["unit", "list", "--space", "*", "--where", "LEN(ApplyGates) > 0", "-o", "name"])).filter(fleetSpace);
  let changeOrders = 0;
  for (const placement of fleet.placements) {
    try { changeOrders += rows(cub(["changeorder", "list", "--space", `${placement.app}-base`, "-o", "name"])).length; } catch { /* none */ }
  }
  console.log(`\nFleet ${fleet.name} attention tiles\n`);
  console.log(`  Blocking Gates:      ${gated.length} unit(s)`);
  console.log(`  Unreleased Changes:  ${unreleased.length} unit(s) pending deployment`);
  console.log(`  Upgrades Available:  ${upgrades.length} unit(s) behind their base`);
  console.log(`  Outstanding Rollouts: ${changeOrders} ChangeOrder(s) in flight`);
  console.log("\nThe same queries a components view renders; open the hub to see them drawn.\n");
} else if (verb === "down") {
  if (!name) fail("usage: cub fleet down <name>");
  const fleet = loadFleet(name);
  const order = [];
  for (const placement of fleet.placements) for (const cluster of placement.clusters) order.push(`${placement.app}-${cluster}`);
  for (const cluster of fleet.clusterNames) order.push(`${cluster}-argo-apps`, cluster);
  let deleted = 0;
  for (const space of order) { try { cub(["space", "delete", space, "--recursive"]); deleted += 1; } catch { /* absent */ } }
  // A base is shared by every fleet that places its component. It goes only
  // when no other variant of the component is left in the organization.
  let kept = 0;
  for (const app of new Set(fleet.placements.map((placement) => placement.app))) {
    let others = [];
    try { others = cub(["space", "list", "--where", `Labels.Component = '${app}'`, "-o", "name"]).trim().split("\n").filter((row) => row && row !== `${app}-base`); } catch (error) { console.log(`  could not check ${app}-base: ${String(error.stderr ?? error.message).trim().split("\n").pop()}`); kept += 1; continue; }
    if (others.length) { kept += 1; console.log(`  kept ${app}-base: ${others.length} other variant(s) still use it`); continue; }
    try { cub(["space", "delete", `${app}-base`, "--recursive"]); deleted += 1; } catch { /* absent */ }
  }
  // The ChangeOrders aging opened live on shared bases; they go with the fleet.
  let closed = 0;
  for (const op of fleet.demoAging ?? []) {
    if (op.kind !== "changeorder") continue;
    try { cub(["changeorder", "delete", op.name, "--space", `${op.component}-base`]); closed += 1; } catch { /* absent */ }
  }
  console.log(`fleet ${fleet.name} teardown complete: ${deleted} space(s) removed${kept ? `, ${kept} shared base(s) kept` : ""}${closed ? `, ${closed} changeorder(s) closed` : ""}`);
} else {
  console.log(`cub fleet — placement as data: which stacks and apps land on which clusters

Usage:
  cub fleet list
  cub fleet plan <name>      # the expanded placements, stacks included, without touching the server
  cub fleet up <name>
  cub fleet age <name>
  cub fleet status <name>
  cub fleet down <name>

This is the prototype of the proposed fleet verb, packaged as a cub plugin.`);
  process.exit(verb ? 2 : 0);
}
