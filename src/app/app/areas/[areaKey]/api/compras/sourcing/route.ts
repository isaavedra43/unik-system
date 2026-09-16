import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  listSourcingCandidates,
  listSourcingSearches,
} from '@/modules/purchases/purchases-queries';
import { sourcingUnitsUsed } from '@/modules/purchases/sourcing-budget';
import { getSourcingConfig } from '@/modules/purchases/sourcing-config';
import { areaErrorResponse } from '../../../_area-http';
import { readPage, readText, resolveComprasRoute } from '../_compras-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * State of the Sourcing Lab (plan 7.6): the last searches (so the view can
 * follow the progress of the background job), the candidates found and how much
 * of the day's search budget is left.
 *
 * `?searchId=` narrows the candidates to one search, `?status=` and `?search=`
 * filter them, and `?excludeKnown=1` hides the ones that already are suppliers.
 * The queries check `purchases.view` / `purchases.sourcing` themselves.
 */
export async function GET(request: Request, { params }: { params: Promise<{ areaKey: string }> }) {
  const { areaKey } = await params;
  const context = await resolveComprasRoute(areaKey);
  if (!context.ok) return context.response;

  const search = new URL(request.url).searchParams;
  const { page, pageSize } = readPage(search);
  const searchId = readText(search, 'searchId', 120);
  const status = readText(search, 'status', 40);

  try {
    const [searches, candidates, config] = await Promise.all([
      listSourcingSearches(context.user, { page: 1, pageSize: 8 }),
      listSourcingCandidates(context.user, {
        page,
        pageSize,
        ...(searchId ? { searchId } : {}),
        ...(status ? { status } : {}),
        ...(readText(search, 'search') ? { search: readText(search, 'search') } : {}),
        excludeKnown: search.get('excludeKnown') === '1',
      }),
      getSourcingConfig(),
    ]);

    // The budget is a day counter (`UsageMeter`): the lab says what is left
    // before a person spends a search that would be refused.
    const used = await sourcingUnitsUsed(prisma, new Date());

    return NextResponse.json({
      searches: searches.rows,
      candidates: candidates.rows,
      pagination: {
        page: candidates.page,
        pageSize: candidates.pageSize,
        total: candidates.total,
        pageCount: candidates.pageCount,
      },
      config: {
        enabled: config.isEnabled,
        dailyBudgetUnits: config.dailyBudgetUnits,
        remainingBudget: Math.max(0, config.dailyBudgetUnits - used),
        allowedHosts: config.allowedHosts.length,
        cacheTtlDays: config.cacheTtlDays,
        rfqDefaultDueDays: config.rfqDefaultDueDays,
      },
    });
  } catch (error) {
    return areaErrorResponse(error);
  }
}
