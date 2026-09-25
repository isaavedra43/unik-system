import { prisma } from '@/lib/prisma';

/**
 * Tenancy — UNIVERSO multiempresa.
 *
 * Hoy todo vive en el tenant semilla 'unik'. `resolveTenantId` consulta
 * TenantMembership cuando exista; si la tabla aún no está migrada en producción
 * (o no hay membresía), responde DEFAULT_TENANT — nunca rompe un request por
 * una capa de aislamiento que aún no aplica.
 */
export const DEFAULT_TENANT_ID = 'unik';

let tableMissing = false;

export async function resolveTenantId(userId: string): Promise<string> {
  if (tableMissing) return DEFAULT_TENANT_ID;
  try {
    const membership = await prisma.tenantMembership.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { tenantId: true },
    });
    return membership?.tenantId ?? DEFAULT_TENANT_ID;
  } catch {
    // P2021 = table does not exist (migración aún no aplicada): fail-soft.
    tableMissing = true;
    return DEFAULT_TENANT_ID;
  }
}
