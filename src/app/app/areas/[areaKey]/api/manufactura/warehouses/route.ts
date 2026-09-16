import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hasPermission } from '@/modules/auth/authorization';
import { manufacturaErrorResponse, resolveManufacturaRoute } from '../_http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Warehouses a production order can release its output into (`outputWarehouseId`
 * is mandatory when creating one). Only the active ones, and only for somebody
 * who may create or manage orders — this is a picker of the creation form, not
 * an inventory read.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveManufacturaRoute(areaKey);
  if (!context.ok) return context.response;
  if (!hasPermission(context.user, 'manufacturing.manage_orders')) {
    return NextResponse.json(
      { error: 'Sin permiso para gestionar órdenes de producción' },
      { status: 403 }
    );
  }

  try {
    const warehouses = await prisma.warehouse.findMany({
      where: { active: true },
      orderBy: [{ name: 'asc' }],
      select: { id: true, key: true, name: true },
    });
    return NextResponse.json({ data: warehouses });
  } catch (error) {
    return manufacturaErrorResponse(error);
  }
}
