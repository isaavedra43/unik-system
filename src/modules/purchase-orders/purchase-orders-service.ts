import { prisma } from '@/lib/prisma';
import { toPurchaseOrderListRow, toPurchaseOrderDetail } from './purchase-orders-contract';
import type { PurchaseOrderListRow, PurchaseOrderDetail } from './purchase-orders-contract';

export type { PurchaseOrderListRow, PurchaseOrderDetail };

const MIN_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface PurchaseOrdersListResult {
  rows: PurchaseOrderListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function isPrismaTableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('does not exist') ||
      msg.includes('relation') ||
      msg.includes('p2021') ||
      msg.includes('the table') ||
      msg.includes('no such table')
    );
  }
  return false;
}

export async function getPurchaseOrdersWorkspace(options: {
  page?: number;
  pageSize?: number;
  search?: string;
}): Promise<PurchaseOrdersListResult> {
  const page = Math.max(MIN_PAGE, options.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE));
  const search = options.search?.trim();

  const where = search
    ? {
        OR: [
          { purchaseOrderNumber: { contains: search, mode: 'insensitive' as const } },
          { vendorName: { contains: search, mode: 'insensitive' as const } },
          { referenceNumber: { contains: search, mode: 'insensitive' as const } },
        ],
      }
    : {};

  try {
    const [rows, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        orderBy: { date: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.purchaseOrder.count({ where }),
    ]);

    return {
      rows: rows.map(toPurchaseOrderListRow),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  } catch (error) {
    if (isPrismaTableError(error)) {
      console.error('PurchaseOrder table not available — migration may not be applied:', error);
      return { rows: [], total: 0, page, pageSize, totalPages: 0 };
    }
    throw error;
  }
}

export async function getPurchaseOrderById(id: string): Promise<PurchaseOrderDetail | null> {
  try {
    const purchaseOrder = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: { items: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!purchaseOrder) return null;
    return toPurchaseOrderDetail(purchaseOrder);
  } catch (error) {
    if (isPrismaTableError(error)) {
      console.error('PurchaseOrder table not available — migration may not be applied:', error);
      return null;
    }
    throw error;
  }
}
