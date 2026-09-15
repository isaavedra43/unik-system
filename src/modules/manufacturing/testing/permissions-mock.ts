import type * as PermissionsModule from '@/modules/auth/permissions';
import { MANUFACTURING_PERMISSIONS } from '../permissions';

/**
 * Test helper: the permission registry plus the manufacturing keys, for suites
 * that run before `MANUFACTURING_PERMISSIONS` is spread into
 * `PERMISSION_REGISTRY` (a no-op once it is).
 *
 *   vi.mock('@/modules/auth/permissions', async (importOriginal) => {
 *     const { withManufacturingPermissions } = await import('@/modules/manufacturing/testing/permissions-mock');
 *     return withManufacturingPermissions(await importOriginal());
 *   });
 */
export function withManufacturingPermissions(
  original: typeof PermissionsModule
): typeof PermissionsModule {
  const missing = MANUFACTURING_PERMISSIONS.filter((permission) => !original.isKnownPermission(permission.key));
  if (missing.length === 0) return original;
  const extra = new Set(missing.map((permission) => permission.key));
  const isKnownPermission = ((key: string) =>
    original.isKnownPermission(key) || extra.has(key)) as typeof original.isKnownPermission;
  const assertKnownPermission = ((key: string) => {
    if (!isKnownPermission(key)) original.assertKnownPermission(key);
  }) as typeof original.assertKnownPermission;
  const filterKnownPermissions = ((keys: string[]) =>
    keys.filter((key) => isKnownPermission(key))) as typeof original.filterKnownPermissions;
  return {
    ...original,
    PERMISSION_REGISTRY: [...original.PERMISSION_REGISTRY, ...missing],
    isKnownPermission,
    assertKnownPermission,
    filterKnownPermissions,
  };
}
