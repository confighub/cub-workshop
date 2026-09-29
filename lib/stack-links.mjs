import { sha256 } from "./common.mjs";

// A stack's declared bindings, turned into the links cub stack upload creates.
//
// A path binding says which profile value feeds which path of which downstream
// resource. cub expresses exactly that as a TransformPaths link from the Unit
// holding the resource to the Unit holding the profile: UpstreamPaths names
// the value it reads, DownstreamPaths the path it writes. cub link create has
// no flags for those two lists, so they go in as entity JSON on stdin.
//
// The bindings do not name the upstream: the profile is the stack's one
// hub-plane component, and the object in it that carries the upstream path.
// A binding's own `unit` names the per-file Unit the producer ingested with
// before cub 0.5; variant upload now makes one Unit per resource, named after
// it (a workload keeps its bare name, anything else takes its kind as a
// suffix), so the Unit is derived from the resource the binding names. Upload
// confirms each Unit exists before it links, rather than trusting the name.
//
// An env binding names only that per-file Unit, a container and a field: no
// resource and no profile path. Linking it would mean guessing both, so it is
// reported as not linked, with the reason, instead.

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod"]);
const resourceType = (object) => `${object.apiVersion}/${object.kind}`;
const resourceName = (object) => `${object.metadata?.namespace ?? ""}/${object.metadata?.name}`;
export const unitSlugFor = (object) => WORKLOADS.has(object.kind) ? object.metadata.name : `${object.metadata.name}-${String(object.kind).toLowerCase()}`;
const valueAt = (object, path) => path.split(".").reduce((value, key) => (value !== null && typeof value === "object" ? value[key] : undefined), object);
const dataType = (value) => typeof value === "string" ? "string" : typeof value === "boolean" ? "bool" : Number.isInteger(value) ? "int" : null;

export function planBindingLinks(stack, spaceOf) {
  const pathBindings = stack.bindings?.pathBindings ?? [];
  const envBindings = stack.bindings?.envBindings ?? [];
  const links = [];
  const unlinked = [];
  const skip = (kind, binding, reason) => unlinked.push({ kind, binding, reason });
  for (const binding of envBindings) skip("env", binding, "an env binding names no resource and no profile path, only a per-file Unit and a field, so it has no link form without guessing; declare it as a path binding to link it");
  if (!pathBindings.length) return { links, unlinked };
  const hubs = stack.components.filter((comp) => comp.plane === "hub");
  if (hubs.length !== 1) {
    for (const binding of pathBindings) skip("path", binding, `bindings read from the stack's one hub-plane component, and this stack has ${hubs.length}`);
    return { links, unlinked };
  }
  const profile = hubs[0];
  for (const binding of pathBindings) {
    const component = stack.components.find((comp) => comp.name === binding.component);
    if (!component) { skip("path", binding, `the stack has no component "${binding.component}"`); continue; }
    const downstream = component.objects.filter((object) => resourceType(object) === binding.resourceType && resourceName(object) === binding.resourceName);
    if (downstream.length !== 1) { skip("path", binding, `component ${component.name} ships ${downstream.length} ${binding.resourceType} ${binding.resourceName}`); continue; }
    const upstream = profile.objects.filter((object) => valueAt(object, binding.upstream) !== undefined);
    if (upstream.length !== 1) { skip("path", binding, `${upstream.length} objects in ${profile.name} carry ${binding.upstream}`); continue; }
    const type = dataType(valueAt(upstream[0], binding.upstream));
    if (!type) { skip("path", binding, `${profile.name} ${binding.upstream} is not a string, integer or boolean`); continue; }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.field)) { skip("path", binding, `field "${binding.field}" is not an identifier a link expression can name`); continue; }
    const from = unitSlugFor(downstream[0]);
    const to = unitSlugFor(upstream[0]);
    const clashes = (comp, slug) => comp.objects.filter((object) => unitSlugFor(object) === slug).length > 1;
    if (clashes(component, from) || clashes(profile, to)) { skip("path", binding, `more than one resource would upload as Unit ${clashes(component, from) ? from : to}`); continue; }
    // The slug is derived from the binding itself, so a rerun looks up the
    // same link and two bindings on one resource never collide.
    const slug = `bind-${binding.field.toLowerCase()}-${sha256(JSON.stringify([binding.component, binding.resourceType, binding.resourceName, binding.pathEscaped, binding.upstream])).slice(0, 10)}`;
    const space = spaceOf(component);
    const toSpace = spaceOf(profile);
    const body = {
      UpstreamPaths: [{ Name: binding.field, Path: binding.upstream, Resource: { ResourceType: resourceType(upstream[0]), ResourceName: resourceName(upstream[0]) } }],
      DownstreamPaths: [{ Path: binding.pathEscaped, Resource: { ResourceType: binding.resourceType, ResourceName: binding.resourceName }, Evaluator: "template", Expression: `{{ .${binding.field} }}`, Parameters: [binding.field], DataType: type }],
    };
    const args = ["link", "create", "--space", space, "--update-type", "TransformPaths", "--from-stdin", slug, from, to, ...(toSpace === space ? [] : [toSpace])];
    links.push({ binding, slug, space, from, to, toSpace, body, args });
  }
  return { links, unlinked };
}

export const describeBinding = ({ kind, binding }) => kind === "env"
  ? `${binding.component}/${binding.unit} ${binding.container} env ${binding.envVar} <- ${binding.field}`
  : `${binding.component} ${binding.resourceType} ${binding.resourceName} ${binding.path} <- ${binding.field}`;
