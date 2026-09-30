import { sha256 } from "./common.mjs";

// A stack's declared bindings, turned into the links cub stack upload creates.
//
// A binding says which profile value feeds which part of which downstream
// resource. cub expresses that as a TransformPaths link from the Unit holding
// the resource to the Unit holding the profile: UpstreamPaths names the values
// it reads, DownstreamPaths the paths it writes, and DownstreamSetters the
// functions it runs. cub link create has no flags for those lists, so they go
// in as entity JSON on stdin (JSON, not YAML: YAML is accepted and discarded).
//
// One link per downstream Unit carries every binding into that Unit, as the
// eks-inference link-profile command does. Each value is named by its field and
// written with the template {{.Params.<field>}}; a bare {{ .<field> }} is
// accepted by the hub and writes nothing.
//
// The bindings do not name the upstream: the profile is the stack's one
// hub-plane component, and the object in it that carries the upstream path.
// A binding's own `unit` names the per-file Unit the producer ingested with
// before cub 0.5; variant upload now makes one Unit per resource, named after
// it (a workload keeps its bare name, anything else takes its kind as a
// suffix), so the Unit is derived from the resource. Upload confirms each Unit
// exists before it links, rather than trusting the name.
//
// An env binding sets a container's env var by name through set-env-var, so a
// chart that reorders its env list cannot redirect the write. It lands on the
// component's one Deployment whose container carries that env var; when there
// are several, the binding's old per-file Unit name picks the one whose name
// holds its first word (ec2-controller: ack-ec2-ec2-chart).

const WORKLOADS = new Set(["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod"]);
const resourceType = (object) => `${object.apiVersion}/${object.kind}`;
const resourceName = (object) => `${object.metadata?.namespace ?? ""}/${object.metadata?.name}`;
export const unitSlugFor = (object) => WORKLOADS.has(object.kind) ? object.metadata.name : `${object.metadata.name}-${String(object.kind).toLowerCase()}`;
const valueAt = (object, path) => path.split(".").reduce((value, key) => (value !== null && typeof value === "object" ? value[key] : undefined), object);
const dataType = (value) => typeof value === "string" ? "string" : typeof value === "boolean" ? "bool" : Number.isInteger(value) ? "int" : null;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function planBindingLinks(stack, spaceOf) {
  const pathBindings = stack.bindings?.pathBindings ?? [];
  const envBindings = stack.bindings?.envBindings ?? [];
  const unlinked = [];
  const skip = (kind, binding, reason) => unlinked.push({ kind, binding, reason });
  if (!pathBindings.length && !envBindings.length) return { links: [], unlinked };
  const hubs = stack.components.filter((comp) => comp.plane === "hub");
  if (hubs.length !== 1) {
    for (const binding of pathBindings) skip("path", binding, `bindings read from the stack's one hub-plane component, and this stack has ${hubs.length}`);
    for (const binding of envBindings) skip("env", binding, `bindings read from the stack's one hub-plane component, and this stack has ${hubs.length}`);
    return { links: [], unlinked };
  }
  const profile = hubs[0];
  const clashes = (comp, slug) => comp.objects.filter((object) => unitSlugFor(object) === slug).length > 1;
  // The profile value a binding reads: one object in the profile carries it.
  const upstreamFor = (kind, binding, path) => {
    if (!IDENTIFIER.test(binding.field)) { skip(kind, binding, `field "${binding.field}" is not an identifier a link expression can name`); return null; }
    const carriers = profile.objects.filter((object) => valueAt(object, path) !== undefined);
    if (carriers.length !== 1) { skip(kind, binding, `${carriers.length} objects in ${profile.name} carry ${path}`); return null; }
    const type = dataType(valueAt(carriers[0], path));
    if (!type) { skip(kind, binding, `${profile.name} ${path} is not a string, integer or boolean`); return null; }
    if (clashes(profile, unitSlugFor(carriers[0]))) { skip(kind, binding, `more than one resource would upload as Unit ${unitSlugFor(carriers[0])}`); return null; }
    return { object: carriers[0], path, type };
  };
  const groups = new Map();
  const groupFor = (component, object) => {
    const from = unitSlugFor(object);
    const key = `${component.name}\u0000${from}`;
    if (!groups.has(key)) groups.set(key, { component, from, upstreams: new Map(), paths: [], setters: [], bindings: [] });
    return groups.get(key);
  };
  const read = (group, binding, upstream) => {
    const known = group.upstreams.get(binding.field);
    if (known && known.path !== upstream.path) return false;
    group.upstreams.set(binding.field, upstream);
    return true;
  };

  for (const binding of pathBindings) {
    const component = stack.components.find((comp) => comp.name === binding.component);
    if (!component) { skip("path", binding, `the stack has no component "${binding.component}"`); continue; }
    const downstream = component.objects.filter((object) => resourceType(object) === binding.resourceType && resourceName(object) === binding.resourceName);
    if (downstream.length !== 1) { skip("path", binding, `component ${component.name} ships ${downstream.length} ${binding.resourceType} ${binding.resourceName}`); continue; }
    if (clashes(component, unitSlugFor(downstream[0]))) { skip("path", binding, `more than one resource would upload as Unit ${unitSlugFor(downstream[0])}`); continue; }
    const upstream = upstreamFor("path", binding, binding.upstream);
    if (!upstream) continue;
    const group = groupFor(component, downstream[0]);
    if (!read(group, binding, upstream)) { skip("path", binding, `field "${binding.field}" already reads another profile path for Unit ${group.from}`); continue; }
    group.paths.push({ Path: binding.pathEscaped, Resource: { ResourceType: binding.resourceType, ResourceName: binding.resourceName }, Expression: `{{.Params.${binding.field}}}`, Evaluator: "template", Parameters: [binding.field], DataType: upstream.type });
    group.bindings.push({ kind: "path", binding });
  }

  for (const binding of envBindings) {
    const component = stack.components.find((comp) => comp.name === binding.component);
    if (!component) { skip("env", binding, `the stack has no component "${binding.component}"`); continue; }
    const carries = (object) => object.kind === "Deployment" && (object.spec?.template?.spec?.containers ?? []).some((container) => container.name === binding.container && (container.env ?? []).some((env) => env.name === binding.envVar));
    let candidates = component.objects.filter(carries);
    if (candidates.length > 1) {
      const word = String(binding.unit ?? "").split("-")[0];
      candidates = candidates.filter((object) => word && object.metadata.name.split("-").includes(word));
    }
    if (candidates.length !== 1) { skip("env", binding, `component ${component.name} has ${candidates.length} Deployments whose ${binding.container} container sets ${binding.envVar} and match ${binding.unit}`); continue; }
    const upstream = upstreamFor("env", binding, `spec.${binding.field}`);
    if (!upstream) continue;
    const group = groupFor(component, candidates[0]);
    if (!read(group, binding, upstream)) { skip("env", binding, `field "${binding.field}" already reads another profile path for Unit ${group.from}`); continue; }
    group.setters.push({ Parameters: [binding.field], FunctionInvocation: { FunctionName: "set-env-var", WhereResource: "ConfigHub.ResourceType = 'apps/v1/Deployment'", Arguments: [{ Value: binding.container }, { Value: binding.envVar }, { Value: `{{.Params.${binding.field}}}`, Evaluator: "template" }] } });
    group.bindings.push({ kind: "env", binding });
  }

  const links = [...groups.values()].map((group) => {
    const space = spaceOf(group.component);
    const toSpace = spaceOf(profile);
    const to = unitSlugFor([...group.upstreams.values()][0].object);
    // The slug is derived from the downstream Unit, so a rerun finds the same
    // link and reconciles it rather than adding a second.
    const slug = `profile-${group.from}`.length <= 60 ? `profile-${group.from}` : `profile-${sha256(group.from).slice(0, 16)}`;
    const body = {
      UpstreamPaths: [...group.upstreams.entries()].map(([name, upstream]) => ({ Name: name, Path: upstream.path, Resource: { ResourceType: resourceType(upstream.object), ResourceName: resourceName(upstream.object) } })),
      ...(group.paths.length ? { DownstreamPaths: group.paths } : {}),
      ...(group.setters.length ? { DownstreamSetters: group.setters } : {}),
    };
    // --auto-update: a link made with an --update-type does not follow its
    // upstream otherwise. --protect: the link claims the paths it writes, so a
    // later promote or re-upload does not put the placeholder back.
    const create = ["link", "create", "--space", space, "--update-type", "TransformPaths", "--auto-update", "--protect", "--from-stdin", slug, group.from, to, ...(toSpace === space ? [] : [toSpace])];
    const update = ["link", "update", slug, "--space", space, "--patch", "--auto-update", "--protect", "--from-stdin"];
    return { slug, space, from: group.from, to, toSpace, body, create, update, bindings: group.bindings, count: group.bindings.length };
  });
  return { links, unlinked };
}

export const describeBinding = ({ kind, binding }) => kind === "env"
  ? `${binding.component}/${binding.unit} ${binding.container} env ${binding.envVar} <- ${binding.field}`
  : `${binding.component} ${binding.resourceType} ${binding.resourceName} ${binding.path} <- ${binding.field}`;
