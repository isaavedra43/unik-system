import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { hasPermission } from '@/modules/auth/authorization';
import { intParam, manufacturaErrorResponse, resolveManufacturaRoute } from '../_http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_TERM = 100;

/**
 * Product lookup for the manufacturing forms (the output of an order, its
 * inputs, the lines of a bill of materials). Reads the catalogue synced from
 * Zoho: `?q=` matches the SKU or the name, and an exact `zohoItemId` also
 * resolves, which is what the scanner and the AI drafts send.
 *
 * `manufacturing.view` is required — the same permission that opens the orders
 * these items end up in.
 */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveManufacturaRoute(areaKey);
  if (!context.ok) return context.response;
  if (!hasPermission(context.user, 'manufacturing.view')) {
    return NextResponse.json({ error: 'Sin permiso para ver manufactura' }, { status: 403 });
  }

  const search = new URL(request.url).searchParams;
  const term = (search.get('q') ?? '').trim().slice(0, MAX_TERM);
  const take = intParam(search.get('limit'), 20, 1, 50);

  try {
    const products = await prisma.product.findMany({
      where: term
        ? {
            OR: [
              { zohoItemId: term },
              { sku: { contains: term, mode: 'insensitive' } },
              { name: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {},
      orderBy: [{ name: 'asc' }, { zohoItemId: 'asc' }],
      take,
      select: { zohoItemId: true, sku: true, name: true, unit: true, status: true },
    });
    return NextResponse.json({
      data: products.map((product) => ({
        zohoItemId: product.zohoItemId,
        sku: product.sku,
        name: product.name ?? product.sku ?? product.zohoItemId,
        unit: product.unit,
        status: product.status,
      })),
    });
  } catch (error) {
    return manufacturaErrorResponse(error);
  }
}
