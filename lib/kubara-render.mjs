import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { identity, parseDocs, parseYaml, sha256 } from "./common.mjs";

// One renderer renders a platform the way Kubara delivers it: `cub kubara
// render`, from confighub/kubara-confighub. from-kubara reads what it writes
// and assembles the stack; it renders nothing itself.
export const KUBARA_RENDER_MINIMUM = "0.2.3";
export const KUBARA_INSTALL = "cub plugin install confighub/kubara-confighub";
const RENDER_API = "kubara.confighub.com/v1alpha1";

// Kubara's config.yaml names the clusters, which one is the hub, and which
// services each cluster enables. from-kubara reads it only to refuse a wrong
// --cluster before anything renders, and to name the clusters in its messages.
export function readKubaraConfig(workDir) {
  const path = join(workDir, "config.yaml");
  if (!existsSync(path)) throw new Error(`${workDir} has no config.yaml; from-kubara reads the clusters and the services each enables from Kubara's config`);
  const config = parseYaml(readFileSync(path));
  if (!Array.isArray(config?.clusters) || config.clusters.length === 0 || config.clusters.some((cluster) => !cluster?.name)) {
    throw new Error(`${path} names no clusters; is it a Kubara config.yaml?`);
  }
  return config;
}

const older = (version, minimum) => {
  const [a, b] = [version, minimum].map((text) => text.split(".").map(Number));
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index];
  return false;
};

const needs = `from-kubara needs cub kubara v${KUBARA_RENDER_MINIMUM} or later, whose render command renders each service the way Kubara delivers it`;

// The installed cub kubara, or a message that says how to get it. A release
// prints "cub kubara 0.2.3 (commit ...)"; a local build prints "dev" and is
// taken at its word, and a missing render command is caught when it runs.
export function cubKubaraVersion() {
  const result = spawnSync("cub", ["kubara", "version"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") throw new Error(`cub is not installed; ${needs}. Install cub, then run ${KUBARA_INSTALL}`);
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(`cub kubara is not installed; ${needs}. Run ${KUBARA_INSTALL}, then run the command again.`);
  const version = (text.match(/cub kubara v?(\d+\.\d+\.\d+)/) ?? [])[1];
  if (version && older(version, KUBARA_RENDER_MINIMUM)) {
    throw new Error(`cub kubara ${version} is installed; ${needs}. Run ${KUBARA_INSTALL} to install the latest release, then run the command again.`);
  }
  return (text.match(/cub kubara (\S+)/) ?? [])[1] ?? "unknown";
}

// `cub kubara render <work-dir> --out <dir>`: render.json and one objects.yaml
// per cluster and service. Its own error, such as a helm failure, is passed on.
export function runKubaraRender(workDir, out, clusters = []) {
  const args = ["kubara", "render", workDir, "--out", out, ...clusters.flatMap((cluster) => ["--cluster", cluster]), "--json"];
  const result = spawnSync("cub", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    const text = String(result.stderr || result.stdout || result.error?.message || "").trim();
    if (/unknown command "render"/.test(text)) throw new Error(`the installed cub kubara has no render command; ${needs}. Run ${KUBARA_INSTALL}, then run the command again.`);
    const detail = text.split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() && line.trim() !== ".").join("\n  ");
    throw new Error(`cub ${args.join(" ")} failed:\n  ${detail || `exit ${result.status}`}`);
  }
}

// render.json and the objects of each service, each file checked against the
// digest render.json records for it.
export function readKubaraRender(dir) {
  const path = join(dir, "render.json");
  if (!existsSync(path)) throw new Error(`cub kubara render wrote no render.json in ${dir}`);
  let render;
  try { render = JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`${path}: ${error.message}`); }
  if (render?.kind !== "KubaraRender" || render.apiVersion !== RENDER_API) {
    throw new Error(`${path} is not a ${RENDER_API} KubaraRender (it says ${render?.apiVersion ?? "no apiVersion"} ${render?.kind ?? "no kind"}); from-kubara reads that version only`);
  }
  if (!Array.isArray(render.clusters) || render.clusters.length === 0) throw new Error(`${path} names no clusters`);
  for (const cluster of render.clusters) {
    for (const service of cluster.services ?? []) {
      const file = join(dir, service.file ?? "");
      if (!service.file || !existsSync(file)) throw new Error(`${path} names ${service.file ?? "no file"} for ${service.name} on cluster ${cluster.name}, which is missing`);
      const bytes = readFileSync(file);
      if (service.sha256 && `sha256:${sha256(bytes)}` !== service.sha256) throw new Error(`${service.file} does not match the digest render.json records for it`);
      service.objectList = parseDocs(bytes.toString("utf8")).filter((doc) => doc?.kind && doc.metadata?.name);
    }
  }
  return render;
}

// Each objects.yaml holds every object its Application delivers, so an object
// two services render appears in both. One owner each: a shared object stays
// with the owner render.json names and leaves every other service. An object
// no rule owns stays everywhere, and stack check names the conflict.
export function ownedObjects(cluster, service) {
  const elsewhere = new Set((cluster.shared ?? []).filter((entry) => entry.owner && entry.owner !== service.name && (entry.services ?? []).includes(service.name)).map((entry) => entry.object));
  const objects = service.objectList.filter((obj) => !elsewhere.has(identity(obj)));
  return { objects, dropped: service.objectList.length - objects.length };
}
