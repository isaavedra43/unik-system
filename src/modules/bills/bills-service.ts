import { prisma } from '@/lib/prisma';
import { toBillListRow, toBillDetail } from './bills-contract';
import type { BillListRow, BillDetail } from './bills-contract';

export type { BillListRow, BillDetail };

const MIN_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export interface BillsListResult {
  rows: BillListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function getBillsWorkspace(options: {
  page?: number;
  pageSize?: number;
  search?: string;
}): Promise<BillsListResult> {
  const page = Math.max(MIN_PAGE, options.page ?? 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE));
  const search = options.search?.trim();

  const where = search
    ? {
        OR: [
          { billNumber: { contains: search, mode: 'insensitive' as const } },
          { vendorName: { contains: search, mode: 'insensitive' as const } },
        ],
      }
    : {};

  const [rows, total] = await Promise.all([
    prisma.bill.findMany({
      where,
      orderBy: { date: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.bill.count({ where }),
  ]);

  return {
    rows: rows.map(toBillListRow),
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  };
}

export async function getBillById(id: string): Promise<BillDetail | null> {
  const bill = await prisma.bill.findUnique({ where: { id } });
  if (!bill) return null;
  return toBillDetail(bill);
}
