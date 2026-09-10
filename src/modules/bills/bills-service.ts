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

  try {
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
  } catch (error) {
    if (isPrismaTableError(error)) {
      console.error('Bill table not available — migration may not be applied:', error);
      return { rows: [], total: 0, page, pageSize, totalPages: 0 };
    }
    throw error;
  }
}

export async function getBillById(id: string): Promise<BillDetail | null> {
  try {
    const bill = await prisma.bill.findUnique({ where: { id } });
    if (!bill) return null;
    return toBillDetail(bill);
  } catch (error) {
    if (isPrismaTableError(error)) {
      console.error('Bill table not available — migration may not be applied:', error);
      return null;
    }
    throw error;
  }
}
