// What an app needs from the platform under it, read off its own objects, and
// what in a stack provides it. Shared by cub app check and cub stack certify.

export const DEPENDENCIES = [
  { when: (obj) => obj.kind === "Ingress", service: "an ingress controller", detail: (obj) => `Ingress ${obj.metadata?.name} (class ${obj.spec?.ingressClassName ?? "default"})`, className: (obj) => obj.spec?.ingressClassName ?? null },
  { when: (obj) => String(obj.apiVersion).startsWith("cert-manager.io/"), service: "cert-manager", detail: (obj) => `${obj.kind} ${obj.metadata?.name}` },
  { when: (obj) => String(obj.apiVersion).startsWith("monitoring.coreos.com/"), service: "a Prometheus operator (kube-prometheus-stack)", detail: (obj) => `${obj.kind} ${obj.metadata?.name}` },
  { when: (obj) => String(obj.apiVersion).startsWith("external-secrets.io/"), service: "external-secrets", detail: (obj) => `${obj.kind} ${obj.metadata?.name}` },
];

// The ingress controllers a stack can carry, by component name, and the class
// each one answers to.
const INGRESS_CONTROLLERS = [
  { match: /ingress-nginx|nginx-ingress/, className: "nginx" },
  { match: /traefik/, className: "traefik" },
  { match: /contour/, className: "contour" },
  { match: /haproxy/, className: "haproxy" },
];

export function appNeeds(objects) {
  const needs = [];
  for (const obj of objects) for (const dep of DEPENDENCIES) {
    if (dep.when(obj)) needs.push({ service: dep.service, detail: dep.detail(obj), className: dep.className ? dep.className(obj) : null });
  }
  return needs;
}

// For every authored component in a stack, each need and whether the stack
// meets it. A need is met by a component named for the service, or by the CRD
// group the stack delivers. An Ingress that names a class needs the controller
// that answers to that class.
export function checkNeeds(stack, crdGroups) {
  const names = stack.components.map((comp) => comp.name);
  const controllers = names.flatMap((name) => INGRESS_CONTROLLERS.filter((entry) => entry.match.test(name)).map((entry) => ({ name, className: entry.className })));
  const has = (pattern, group) => names.some((name) => pattern.test(name)) || (group ? crdGroups.has(group) : false);
  const results = [];
  for (const comp of stack.components.filter((entry) => entry.authored)) {
    for (const need of appNeeds(comp.objects)) {
      let met = false; let hint = "";
      if (need.service === "an ingress controller") {
        if (need.className) {
          met = controllers.some((entry) => entry.className === need.className);
          if (!met) hint = controllers.length
            ? `${need.detail} asks for class ${need.className}, and this stack's ingress controller is ${controllers.map((entry) => entry.name).join(", ")}; change the class or add a controller that answers to it`
            : `${need.detail} asks for class ${need.className}, and nothing in this stack is an ingress controller`;
        } else { met = controllers.length > 0; if (!met) hint = `${need.detail} needs an ingress controller, and nothing in this stack is one`; }
      } else if (need.service === "cert-manager") { met = has(/cert-manager/, "cert-manager.io"); hint = `${need.detail} needs cert-manager` ; }
      else if (need.service.startsWith("a Prometheus operator")) { met = has(/kube-prometheus-stack|prometheus-operator/, "monitoring.coreos.com"); hint = `${need.detail} needs a Prometheus operator; add kube-prometheus-stack`; }
      else if (need.service === "external-secrets") { met = has(/external-secrets/, "external-secrets.io"); hint = `${need.detail} needs external-secrets`; }
      results.push({ app: comp.name, service: need.service, met, hint: met ? "" : hint });
    }
  }
  return results;
}
