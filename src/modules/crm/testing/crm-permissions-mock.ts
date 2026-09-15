import { CRM_PERMISSIONS } from '../permissions';

/**
 * For `vi.mock('@/modules/auth/permissions', …)` in CRM unit tests: the real
 * code-first registry plus the CRM keys, so the tests do not depend on the shared
 * barrel already spreading `CRM_PERMISSIONS`.
 *
 *   vi.mock('@/modules/auth/permissions', async (importOriginal) => {
 *     const { withCrmPermissions } = await import('@/modules/crm/testing/crm-permissions-mock');
 *     return withCrmPermissions(await importOriginal());
 *   });
 */
export function withCrmPermissions(actual: {
  PERMISSION_REGISTRY: ReadonlyArray<{ key: string; group: string; label: string; description: string }>;
  isKnownPermission(key: string): boolean;
}): Record<string, unknown> {
  const registry = [
    ...actual.PERMISSION_REGISTRY,
    ...CRM_PERMISSIONS.filter((permission) => !actual.isKnownPermission(permission.key)),
  ];
  const keys = new Set(registry.map((permission) => permission.key));
  return {
    ...actual,
    PERMISSION_REGISTRY: registry,
    isKnownPermission: (key: string) => keys.has(key),
    assertKnownPermission: (key: string) => {
      if (!keys.has(key)) throw new Error(`Unknown permission key: ${key}`);
    },
    filterKnownPermissions: (list: string[]) => list.filter((key) => keys.has(key)),
  };
}
