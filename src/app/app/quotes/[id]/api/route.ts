import { NextResponse } from 'next/server';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getQuoteById } from '@/modules/quotes/quotes-service';
import { getQuoteChangeEvents } from '@/modules/quotes/quotes-change-events';
import { getContactByZohoId } from '@/modules/cross-module/relationships-service';
import { isEntityWatched } from '@/modules/sales/entity-watch-service';
import { QUOTE_ENTITY_TYPE } from '@/modules/quotes/permissions';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) return NextResponse.json({ error: 'No autenticado' }, { status: 401 });
  if (!session.user.isSuperAdmin && !session.user.permissionKeys.includes('quotes.view'))
    return NextResponse.json({ error: 'Sin permiso' }, { status: 403 });
  const { id } = await params;
  const quote = await getQuoteById(id);
  if (!quote) return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
  const [relatedContact, changeEvents, isWatched] = await Promise.all([
    quote.zohoCustomerId ? getContactByZohoId(quote.zohoCustomerId) : Promise.resolve(null),
    getQuoteChangeEvents(quote.id, 20),
    isEntityWatched(session.user.id, QUOTE_ENTITY_TYPE, quote.id),
  ]);
  return NextResponse.json({ ...quote, relatedContact, changeEvents, is_watched: isWatched });
}
