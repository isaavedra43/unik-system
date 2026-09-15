import type { PermissionDefinition } from '@/modules/auth/permissions';
import { FINANCE_PERMISSIONS } from '../permissions';

/**
 * Test helper: the code-first registry with the finance keys, for
 * `vi.mock('@/modules/auth/permissions', …)` while `FINANCE_PERMISSIONS` is
 * not yet spread into `PERMISSION_REGISTRY` (shared barrel owned by the
 * registry maintainer). When the barrel already lists them, the actual module
 * is returned untouched.
 *
 *   vi.mock('@/modules/auth/permissions', async (importOriginal) => {
 *     const actual = await importOriginal<typeof import('@/modules/auth/permissions')>();
 *     const { withFinancePermissions } = await import('./testing/finance-permissions');
 *     return withFinancePermissions(actual);
 *   });
 */

type PermissionsModule = typeof import('@/modules/auth/permissions');

export function withFinancePermissions(actual: PermissionsModule): PermissionsModule {
  if (actual.isKnownPermission('finance.view')) return actual;
  const registry: PermissionDefinition[] = [...actual.PERMISSION_REGISTRY, ...FINANCE_PERMISSIONS];
  const keys = new Set(registry.map((p) => p.key));
  return {
    ...actual,
    PERMISSION_REGISTRY: registry,
    isKnownPermission: ((key: string) => keys.has(key)) as PermissionsModule['isKnownPermission'],
    assertKnownPermission: ((key: string) => {
      if (!keys.has(key)) throw new Error(`Unknown permission key: ${key}`);
    }) as PermissionsModule['assertKnownPermission'],
    filterKnownPermissions: ((list: string[]) => list.filter((key) => keys.has(key))) as PermissionsModule['filterKnownPermissions'],
    getPermissionGroups: () => {
      const groups: Array<{ group: string; permissions: PermissionDefinition[] }> = [];
      for (const permission of registry) {
        let group = groups.find((g) => g.group === permission.group);
        if (!group) {
          group = { group: permission.group, permissions: [] };
          groups.push(group);
        }
        group.permissions.push(permission);
      }
      return groups;
    },
  };
}
