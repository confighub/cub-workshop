import { toYaml } from './common.mjs';
import { buildReceipt } from './receipt.mjs';

export const renderStack = (stack) => stack.components.flatMap(comp => comp.objects).map(toYaml).join('---\n');

export function certificationResult(stack, result, path = `${stack.name}.yaml`) {
  const receipt = buildReceipt({ name: stack.name, source: { kind: 'stack', name: stack.name },
    files: [{ path, content: renderStack(stack) }], checks: result.findings });
  return {
    apiVersion: 'evidence.confighub.com/v1alpha1', kind: 'StackCertificationResult',
    name: stack.name, certified: result.certified, objectCount: result.objectCount,
    producer: receipt.spec.producer,
    scope: { mode: 'static-composition', targetAvailability: 'not-checked', applicationHealth: 'not-checked' },
    prerequisites: result.prerequisites,
    checks: receipt.spec.checks, renderedFile: receipt.spec.bundle.files[0],
    components: stack.components.map(comp => ({ name: comp.name, plane: comp.plane ?? null,
      source: comp.bundle ?? comp.render ?? comp.authored, objects: comp.objects.length })),
  };
}
