// A bounded check for the fields Kubernetes defines on a container's
// ResourceRequirements. It deliberately does not validate a whole object or
// emulate admission. The authoritative field list is `claims`, `limits`, and
// `requests`: https://kubernetes.io/docs/reference/kubernetes-api/core/pod-v1/#ResourceRequirements

const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const RESOURCE_FIELDS = new Set(["claims", "limits", "requests"]);

const podSpecPaths = new Map([
  ["v1|Pod", [["spec"]]],
  ["v1|ReplicationController", [["spec", "template", "spec"]]],
  ["v1|PodTemplate", [["template", "spec"]]],
  ["apps/v1|Deployment", [["spec", "template", "spec"]]],
  ["apps/v1|StatefulSet", [["spec", "template", "spec"]]],
  ["apps/v1|DaemonSet", [["spec", "template", "spec"]]],
  ["apps/v1|ReplicaSet", [["spec", "template", "spec"]]],
  ["batch/v1|Job", [["spec", "template", "spec"]]],
  ["batch/v1|CronJob", [["spec", "jobTemplate", "spec", "template", "spec"]]],
]);

function atPath(object, path) {
  return path.reduce((node, part) => isMap(node) ? node[part] : undefined, object);
}

function pointer(path) {
  return `/${path.map((part) => String(part).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function objectIdentity(object) {
  return {
    apiVersion: object.apiVersion,
    kind: object.kind,
    namespace: object.metadata?.namespace ?? null,
    name: object.metadata?.name,
  };
}

// Find only errors that are unambiguous from this small Kubernetes built-in
// surface. Unknown/custom kinds are intentionally not inspected.
export function resourceRequirementsFindings(objects) {
  const findings = [];
  for (const object of objects) {
    if (!isMap(object)) continue;
    const paths = podSpecPaths.get(`${object.apiVersion}|${object.kind}`);
    if (!paths) continue;
    for (const podPath of paths) {
      const podSpec = atPath(object, podPath);
      if (!isMap(podSpec)) continue;
      for (const field of ["containers", "initContainers", "ephemeralContainers"]) {
        if (!Array.isArray(podSpec[field])) continue;
        for (const [index, container] of podSpec[field].entries()) {
          if (!isMap(container) || container.resources === undefined || container.resources === null) continue;
          const resourcePath = [...podPath, field, index, "resources"];
          const context = { object: objectIdentity(object), container: { type: field, name: container.name ?? null } };
          if (!isMap(container.resources)) {
            findings.push({ ...context, path: pointer(resourcePath), reason: "resources must be an object" });
            continue;
          }
          for (const key of Object.keys(container.resources)) {
            if (RESOURCE_FIELDS.has(key)) continue;
            findings.push({
              ...context,
              path: pointer([...resourcePath, key]),
              reason: `unknown resource field \"${key}\"`,
              ...(key === "limit" ? { suggestion: "limits" } : {}),
            });
          }
        }
      }
    }
  }
  return findings;
}

export const resourceValidationBoundary = "container-resource-fields; not full Kubernetes schema/admission validation";
