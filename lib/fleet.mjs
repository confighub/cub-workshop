#!/usr/bin/env node
// cub fleet — placement as data: which stacks and apps land on which clusters.
//
//   cub fleet list
//   cub fleet plan <name>     the expanded placements, stacks included, without touching the server
//   cub fleet up <name>       scaffold the clusters, upload the bases, place and release every component
//   cub fleet age <name>      replay the demo operations the manifest declares, so the fleet shows real attention states
//   cub fleet status <name>   the four attention tiles, recomputed from fleet queries, and rollouts by wave
//   cub fleet rollout <name> <component> [--run]   open the next wave's ChangeOrder, once the last one closed
//   cub fleet down <name>     delete what up created and age opened; stops on anything but not-found
//
// A fleet manifest lists clusters and placements. A placement's component is a
// digest-pinned bundle with its receipt, receipt-verified, or authored YAML shipped
// with the plugin, or a stack: shipped, a manifest path, or a published index
// by digest. spec.owner labels the cluster Spaces (the fleet name when
// absent). A placement naming waves: [canary, secondary, primary] rolls out
// phase by phase, over clusters labelled phase: <wave>, one ChangeOrder per wave.
// The attention states a fleet view renders are the residue
// of operations, so `age` replays the ladder rather than faking any state.

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cub, fail, pluginRoot, readYamlFile } from "./common.mjs";
import { INDEX_REFERENCE, loadIndexStack } from "./stack-index.mjs";

const FLEETS_DIR = join(pluginRoot, "fleets");
const args = process.argv.slice(2);
const verb = args[0];
const name = args[1];
const RUN = args.includes("--run");
const WHERE = args.includes("--where") ? args[args.indexOf("--where") + 1] : null;
// The annotation a rollout stamps on the base, the change each ChangeOrder carries.
const ROLLOUT_ANNOTATION = "meridian.example/rollout";

// A fleet is named (shipped in fleets/) or given as a path to a manifest file.
// A stack placement likewise names a shipped stack or a manifest path, such as
// the one cub stack from-kubara writes, and its component sources resolve
// relative to that manifest first, then to the plugin. A stack placement may
// instead name a published stack index by digest, oci://<repo>@sha256:<digest>,
// whose components are the bundles it pins; offline leaves those unresolved,
// counted, so listing fleets never reaches a registry.
function loadFleet(fleetName, { offline = false } = {}) {
  const isPath = /\.ya?ml$/.test(String(fleetName)) || existsSync(String(fleetName));
  const path = isPath ? resolve(fleetName) : join(FLEETS_DIR, `${fleetName}.yaml`);
  if (!existsSync(path)) fail(isPath ? `no such manifest file: ${fleetName}` : `no such fleet "${fleetName}". Try: cub fleet list`);
  const fleet = readYamlFile(path);
  const fleetDir = dirname(path);
  const clusters = (fleet.spec?.clusters ?? []).map((cluster) => cluster.name);
  let unresolved = 0;
  const expand = (placement) => {
    if (!placement.stack) {
      const source = placement.authored ?? null;
      const sourcePath = source ? [join(fleetDir, source), join(pluginRoot, source)].find((candidate) => existsSync(candidate)) : null;
      return [{ ...placement, sourcePath }];
    }
    let stack; let stackDir = null;
    if (String(placement.stack).startsWith("oci://")) {
      if (!INDEX_REFERENCE.test(placement.stack)) {
        fail(`placement stack ${placement.stack} is not pinned by digest; a fleet places a published stack by its index digest only, oci://<repo>@sha256:<digest> (oras resolve prints the digest a tag points at)`);
      }
      if (offline) { unresolved += 1; return []; }
      // The same reader cub stack sandbox uses: every component comes back as
      // a bundle pinned by the digest the index records for it.
      stack = loadIndexStack(placement.stack).stack;
    } else {
      const stackIsPath = /\.ya?ml$/.test(String(placement.stack)) || existsSync(String(placement.stack));
      const stackPath = stackIsPath ? resolve(fleetDir, placement.stack) : join(pluginRoot, "stacks", `${placement.stack}.yaml`);
      if (!existsSync(stackPath)) fail(`placement names unknown stack ${placement.stack}`);
      stack = readYamlFile(stackPath);
      stackDir = dirname(stackPath);
    }
    return (stack.spec?.components ?? []).map((comp) => {
      const source = comp.render ?? comp.authored ?? null;
      const sourcePath = source && stackDir ? [join(stackDir, source), join(pluginRoot, source)].find((candidate) => existsSync(candidate)) : null;
      if (source && !sourcePath) fail(`stack ${stack.metadata?.name ?? placement.stack}: component "${comp.name}" source is missing: ${source}`);
      return {
        app: comp.name,
        team: placement.team ?? stack.metadata?.name ?? placement.stack,
        bundle: comp.bundle ?? null,
        authored: source,
        sourcePath,
        clusters: placement.clusters,
        ...(placement.waves !== undefined ? { waves: placement.waves } : {}),
      };
    });
  };
  const placements = (fleet.spec?.placements ?? []).flatMap(expand).map((placement) => ({
    ...placement,
    clusters: placement.clusters.includes("*") ? clusters : placement.clusters,
  }));
  for (const placement of placements) for (const cluster of placement.clusters) {
    if (!clusters.includes(cluster)) fail(`placement ${placement.app} names unknown cluster ${cluster}`);
  }
  // The owner labels the cluster Spaces a fleet scaffolds. A manifest names it;
  // one that does not is owned by the fleet itself rather than by a made-up team.
  const owner = fleet.spec?.owner ?? fleet.metadata?.name ?? fleetName;
  // A placement that names waves rolls out phase by phase, so every cluster it
  // lands on must say its phase, and every wave must be a phase one of them
  // carries. A cluster without a phase is fine until a placement names waves.
  const phaseOf = new Map((fleet.spec?.clusters ?? []).map((cluster) => [cluster.name, cluster.labels?.phase ?? null]));
  for (const placement of placements) {
    if (placement.waves === undefined) continue;
    const waves = placement.waves;
    if (!Array.isArray(waves) || !waves.length || waves.some((wave) => typeof wave !== "string" || !wave)) fail(`placement ${placement.app}: waves must be a list of phases, such as [canary, secondary, primary]`);
    if (new Set(waves).size !== waves.length) fail(`placement ${placement.app}: waves names a phase twice`);
    for (const cluster of placement.clusters) {
      const phase = phaseOf.get(cluster);
      if (!phase) fail(`placement ${placement.app} names waves, but cluster ${cluster} has no phase label; give it labels: {phase: <one of ${waves.join(", ")}>}`);
      if (!waves.includes(phase)) fail(`placement ${placement.app}: cluster ${cluster} is in phase ${phase}, which none of its waves (${waves.join(", ")}) reaches`);
    }
    for (const wave of waves) if (!placement.clusters.some((cluster) => phaseOf.get(cluster) === wave)) fail(`placement ${placement.app}: wave ${wave} is not the phase of any cluster it lands on`);
  }
  const demoAging = fleet.spec?.demoAging ?? [];
  for (const op of demoAging) if (op.kind === "rollout" && !placements.some((placement) => placement.app === op.component && placement.waves)) {
    fail(`demoAging rollout names ${op.component}, which no placement with waves places`);
  }
  return { name: fleet.metadata?.name ?? fleetName, owner, clusters: fleet.spec?.clusters ?? [], clusterNames: clusters, phaseOf, placements, unresolved, demoAging };
}

// The CLI's explicit missing-entity response is the only absence evidence.
// Authentication, network and permission failures never read as absent. cub
// has said both `space x not found` and `space "x" not found in any space`.
const notFound = (error, ...entities) => {
  const lines = String(error.stderr || error.stdout || error.message).split("\n").map(line => line.trim().replace(/^Failed: /, ""));
  return entities.some((entity) => {
    const [kind, ...slug] = entity.split(" ");
    return lines.some((line) => line === `${entity} not found` || line.startsWith(`${entity} not found `) || line.startsWith(`${kind} "${slug.join(" ")}" not found`));
  });
};
const lastLine = (error) => String(error.stderr || error.message).trim().split("\n").pop();

const spaceExists = (space) => {
  try { cub(["space", "get", space, "-o", "name"]); return true; }
  catch (error) {
    // Creation follows absence, so only an explicit not-found permits it.
    if (notFound(error, `space ${space}`)) return false;
    throw error;
  }
};

// A wave is the deployment Spaces of a placement whose clusters are in that
// phase. Its ChangeOrder lives on the base, named for the component and wave.
const wavesOf = (fleet, placement) => (placement.waves ?? []).map((wave) => ({
  wave,
  changeOrder: `${placement.app}-rollout-${wave}`,
  spaces: placement.clusters.filter((cluster) => fleet.phaseOf.get(cluster) === wave).map((cluster) => `${placement.app}-${cluster}`),
}));

// The ChangeOrders on a base, by slug. A base not yet uploaded has none.
const changeOrdersOn = (base, where = null) => {
  try {
    return cub(["changeorder", "list", "--space", base, ...(where ? ["--where", where] : []), "-o", "name"])
      .trim().split("\n").map((row) => row.trim().split("/").pop()).filter(Boolean);
  } catch (error) {
    if (notFound(error, `space ${base}`)) return [];
    throw error;
  }
};

// The next wave of a component's rollout, read from the state of the wave
// ChangeOrders already opened: the first wave without one, held while any
// earlier wave's is still in progress or was aborted, since a canary that has
// not finished, or was given up on, is no evidence for the wider waves.
function rolloutPlan(fleet, component, where) {
  const placement = fleet.placements.find((candidate) => candidate.app === component);
  if (!placement) fail(`fleet ${fleet.name} places no component ${component}. Try: cub fleet plan ${fleet.name}`);
  if (!placement.waves) fail(`placement ${component} names no waves; add waves: [canary, secondary, primary] and a phase label on each of its clusters`);
  const base = `${component}-base`;
  const waves = wavesOf(fleet, placement);
  const opened = new Set(changeOrdersOn(base));
  const index = waves.findIndex((wave) => !opened.has(wave.changeOrder));
  if (index === -1) return { waves, done: true };
  const next = waves[index];
  if (index > 0) {
    const open = new Set(changeOrdersOn(base, "State = 'InProgress'"));
    const aborted = new Set(changeOrdersOn(base, "State = 'Aborted'"));
    const held = waves.slice(0, index).find((wave) => open.has(wave.changeOrder) || aborted.has(wave.changeOrder));
    if (held) return { waves, next, held, heldBecause: open.has(held.changeOrder) ? "is still open" : "was aborted" };
  }
  return { waves, next, index, steps: [
    ["changeorder", "create", next.changeOrder, "--space", base, "--in-scope-space", next.spaces.join(","),
      "--description", `Wave ${next.wave} of the ${component} rollout across fleet ${fleet.name}: ${next.spaces.length} Space(s).`],
    ["function", "do", "--space", base, "--where", where ?? "Slug = 'upstream'",
      "set-annotation", ROLLOUT_ANNOTATION, next.wave, "--change-desc", `Rollout: the change wave ${next.wave} takes to its Spaces`],
  ] };
}

// A printed command a reader can paste: arguments with spaces or quotes are quoted.
const shellLine = (step) => `cub ${step.map((arg) => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`).join(" ")}`;

if (verb === "list") {
  console.log("\nAvailable fleets\n");
  for (const file of readdirSync(FLEETS_DIR).filter((entry) => entry.endsWith(".yaml")).sort()) {
    const fleet = readYamlFile(join(FLEETS_DIR, file));
    // A stack placement is counted by the components it expands to, the number
    // plan and up work with, not as one line of the manifest. A published stack
    // is counted apart: its components are known only once its index is read,
    // which plan does and a listing does not.
    const { placements, unresolved } = loadFleet(join(FLEETS_DIR, file), { offline: true });
    console.log(`  ${fleet.metadata?.name ?? file}  —  ${fleet.spec?.description ?? ""}`);
    console.log(`      ${(fleet.spec?.clusters ?? []).length} cluster(s), ${placements.length} component(s)${unresolved ? ` plus ${unresolved} published stack(s); cub fleet plan resolves them` : ""}`);
  }
  console.log("\ncub fleet up <name>   # build the whole fleet\n");
} else if (verb === "plan") {
  if (!name) fail("usage: cub fleet plan <name>");
  const fleet = loadFleet(name);
  console.log(`\nFleet ${fleet.name}: ${fleet.clusterNames.length} clusters, ${fleet.placements.length} placements after expanding stacks\n`);
  for (const placement of fleet.placements) {
    const source = placement.bundle ? `image ${placement.bundle.replace(/^.*@/, "@").slice(0, 20)}` : `path ${placement.authored}`;
    const waves = placement.waves ? `  waves ${wavesOf(fleet, placement).map(({ wave, spaces }) => `${wave} ${spaces.length}`).join(", ")}` : "";
    console.log(`  ${placement.app.padEnd(24)} ${String(placement.clusters.length).padStart(3)} cluster(s)  ${source}${waves}`);
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
      cub(["space", "create", cluster.name, "--label", `Owner=${fleet.owner}`]);
      cub(["worker", "create", "worker", "--space", cluster.name, "--is-server-worker"]);
      cub(["target", "create", "target", "{}", "worker", "--space", cluster.name, "-p", "OCI", "-t", "Any"]);
      console.log(`  ${cluster.name}: cluster space, worker, OCI target`);
    }
    for (const placement of fleet.placements) {
      if (!spaceExists(`${placement.app}-base`)) {
        const owner = placement.team ?? fleet.name;
        if (placement.bundle) {
          cub(["variant", "upload", "--component", placement.app, "--variant", "base", "--owner", owner, placement.bundle]);
        } else {
          cub(["variant", "upload", "--component", placement.app, "--variant", "base", "--owner", owner, placement.sourcePath ?? join(pluginRoot, placement.authored)]);
        }
        console.log(`  ${placement.app}-base uploaded (${placement.team ?? "fleet"})`);
      }
      let placed = 0;
      for (const cluster of placement.clusters) {
        if (spaceExists(`${placement.app}-${cluster}`)) continue;
        // The phase goes on the deployment Space, so a wave can be read back by label.
        const phase = fleet.phaseOf.get(cluster);
        cub(["variant", "create", cluster, `${placement.app}-base`, "--target", `${cluster}/target`, ...(phase ? ["--space-label", `Phase=${phase}`] : [])]);
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
      const value = `${base}-${new Date().toISOString().slice(0, 19).replace(/\D/g, "")}`;
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
      cub(["function", "do", "--space", `${op.component}-base`, "--where", op.where ?? "Slug = 'upstream'",
        "set-annotation", "meridian.example/rollout", "wave-1", "--change-desc", "Aging: the change the ChangeOrder rolls across the fleet"]);
      console.log(`  changeorder opened: ${op.name} (${op.scope.length} spaces in scope)`);
    } else if (op.kind === "rollout") {
      const plan = rolloutPlan(fleet, op.component, op.where);
      if (plan.done) { console.log(`  rollout already through every wave: ${op.component}`); continue; }
      if (plan.held) { console.log(`  rollout held: ${op.component} wave ${plan.next.wave} waits, ${plan.held.changeOrder} ${plan.heldBecause}`); continue; }
      for (const step of plan.steps) cub(step);
      console.log(`  rollout wave opened: ${plan.next.changeOrder} (${plan.next.spaces.length} spaces in scope)`);
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
  // Rollouts by wave count the deployment Spaces each opened wave ChangeOrder
  // takes in, across every waved placement, and name the waves still open.
  let changeOrders = 0;
  const reached = new Map(); const inFlight = [];
  for (const placement of fleet.placements) {
    const names = changeOrdersOn(`${placement.app}-base`);
    changeOrders += names.length;
    if (!placement.waves) continue;
    const open = names.some((slug) => slug.startsWith(`${placement.app}-rollout-`)) ? changeOrdersOn(`${placement.app}-base`, "State = 'InProgress'") : [];
    for (const { wave, changeOrder, spaces } of wavesOf(fleet, placement)) {
      reached.set(wave, (reached.get(wave) ?? 0) + (names.includes(changeOrder) ? spaces.length : 0));
      if (open.includes(changeOrder)) inFlight.push(`${placement.app} ${wave}`);
    }
  }
  console.log(`\nFleet ${fleet.name} attention tiles\n`);
  console.log(`  Blocking Gates:      ${gated.length} unit(s)`);
  console.log(`  Unreleased Changes:  ${unreleased.length} unit(s) pending deployment`);
  console.log(`  Upgrades Available:  ${upgrades.length} unit(s) behind their base`);
  console.log(`  Outstanding Rollouts: ${changeOrders} ChangeOrder(s) in flight`);
  if (reached.size) {
    console.log(`  Rollouts by wave:    ${[...reached].map(([wave, count]) => `${wave} ${count}`).join(", ")} Space(s) in opened waves${inFlight.length ? `; open: ${inFlight.join(", ")}` : ""}`);
  }
  console.log("\nThe same queries a components view renders; open the hub to see them drawn.\n");
} else if (verb === "down") {
  if (!name) fail("usage: cub fleet down <name>");
  const fleet = loadFleet(name);
  let deleted = 0; let kept = 0; let closed = 0;
  // Teardown removes only what up and age create. Something already gone reads
  // as absent; any other refusal stops here, because a Space left behind keeps
  // its cluster or base in use and a claim of completion would hide it.
  const stop = (what, error) => {
    console.error(`\nStopped: could not delete ${what}: ${lastLine(error)}`);
    console.error(`Removed ${deleted} space(s)${closed ? ` and ${closed} changeorder(s)` : ""} before stopping. Fix that, then re-run cub fleet down ${fleet.name}; what is already gone reads as absent.\n`);
    process.exit(1);
  };
  const deleteSpace = (space) => {
    try { cub(["space", "delete", space, "--recursive"]); deleted += 1; }
    catch (error) { if (!notFound(error, `space ${space}`)) stop(`space ${space}`, error); }
  };
  // The ChangeOrders aging and rollouts opened live on shared bases; they go
  // with the fleet, first, while the base that holds them is still there.
  const opened = [
    ...fleet.demoAging.filter((op) => op.kind === "changeorder").map((op) => ({ changeOrder: op.name, base: `${op.component}-base` })),
    ...fleet.placements.flatMap((placement) => wavesOf(fleet, placement).map(({ changeOrder }) => ({ changeOrder, base: `${placement.app}-base` }))),
  ];
  for (const { changeOrder, base } of opened) {
    try { cub(["changeorder", "delete", changeOrder, "--space", base]); closed += 1; }
    catch (error) { if (!notFound(error, `changeorder ${changeOrder}`, `space ${base}`)) stop(`changeorder ${changeOrder} in ${base}`, error); }
  }
  for (const placement of fleet.placements) for (const cluster of placement.clusters) deleteSpace(`${placement.app}-${cluster}`);
  for (const cluster of fleet.clusterNames) deleteSpace(cluster);
  // A base is shared by every fleet that places its component. It goes only
  // when no other variant of the component is left in the organization.
  for (const app of new Set(fleet.placements.map((placement) => placement.app))) {
    let others = [];
    try { others = cub(["space", "list", "--where", `Labels.Component = '${app}'`, "-o", "name"]).trim().split("\n").filter((row) => row && row !== `${app}-base`); }
    catch (error) { stop(`${app}-base, because its other variants could not be checked`, error); }
    if (others.length) { kept += 1; console.log(`  kept ${app}-base: ${others.length} other variant(s) still use it`); continue; }
    deleteSpace(`${app}-base`);
  }
  console.log(`fleet ${fleet.name} teardown complete: ${deleted} space(s) removed${kept ? `, ${kept} shared base(s) kept` : ""}${closed ? `, ${closed} changeorder(s) closed` : ""}`);
} else if (verb === "rollout") {
  const component = args[2];
  if (!name || !component || component.startsWith("--") || (args.includes("--where") && !WHERE)) fail("usage: cub fleet rollout <name> <component> [--where <unit expression>] [--run]");
  const fleet = loadFleet(name);
  const plan = rolloutPlan(fleet, component, WHERE);
  const order = plan.waves.map(({ wave }) => wave).join(" -> ");
  if (plan.done) {
    console.log(`\n${component}: every wave (${order}) already has its ChangeOrder. cub fleet status ${fleet.name} shows where they stand.\n`);
    process.exit(0);
  }
  if (plan.held) {
    console.error(`\nRefused: ${component} wave ${plan.next.wave} waits, because wave ${plan.held.wave}'s ChangeOrder ${plan.held.changeOrder} ${plan.heldBecause}.`);
    console.error(plan.heldBecause === "is still open"
      ? `Finish promoting it through its ${plan.held.spaces.length} Space(s) so it closes, then run cub fleet rollout ${fleet.name} ${component} again.\n`
      : `An aborted wave stops the rollout; put it back on its way (cub changeorder update ${plan.held.changeOrder} --space ${component}-base --aborted-reason "") or start a new one.\n`);
    process.exit(1);
  }
  console.log(`\n${component}: wave ${plan.index + 1} of ${plan.waves.length} (${order}): ${plan.next.wave}, ${plan.next.spaces.length} Space(s)\n`);
  console.log(RUN ? "Opening (live)\n" : "Rollout plan (dry run, no changes)\n");
  for (const step of plan.steps) console.log(`  ${shellLine(step)}`);
  console.log("");
  if (!RUN) { console.log("  Dry run. Add --run to execute.\n"); process.exit(0); }
  for (const step of plan.steps) { process.stdout.write(`  ${step[0]} ${step[1]}... `); cub(step); console.log("ok"); }
  const after = plan.waves[plan.index + 1];
  console.log(`\n  ChangeOrder ${plan.next.changeOrder} opened on ${plan.next.spaces.length} Space(s).${after ? ` Wave ${after.wave} opens once it closes: cub fleet rollout ${fleet.name} ${component}` : " This is the last wave."}\n`);
} else {
  console.log(`cub fleet — placement as data: which stacks and apps land on which clusters

Usage:
  cub fleet list
  cub fleet plan <name>      # the expanded placements, stacks included, without touching the server
  cub fleet up <name>
  cub fleet age <name>
  cub fleet status <name>    # the attention tiles, and rollouts by wave when a placement names waves
  cub fleet rollout <name> <component> [--where <unit expression>] [--run]
                             # dry run by default: the next wave's ChangeOrder, refused while the last is open
  cub fleet down <name>      # removes what up created and age opened; stops on any failure but not-found

A placement's stack names a shipped stack, a manifest path, or a published stack
index by digest (oci://<repo>@sha256:<digest>); a tag is refused. A placement's
waves: [canary, secondary, primary] names the phases it rolls out through, in
order; each of its clusters carries one as labels: {phase: canary}.

This is the prototype of the proposed fleet verb, packaged as a cub plugin.`);
  process.exit(verb ? 2 : 0);
}
