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
}

export async function getPurchaseOrderById(id: string): Promise<PurchaseOrderDetail | null> {
  const purchaseOrder = await prisma.purchaseOrder.findUnique({
    where: { id },
    include: { items: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!purchaseOrder) return null;
  return toPurchaseOrderDetail(purchaseOrder);
}
