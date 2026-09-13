import { notFound } from 'next/navigation';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getQuoteById, getCustomerForQuote } from '@/modules/quotes/quotes-service';
import { getQuoteChangeEvents } from '@/modules/quotes/quotes-change-events';
import { isEntityWatched } from '@/modules/sales/entity-watch-service';
import { QUOTE_ENTITY_TYPE } from '@/modules/quotes/permissions';
import { QuoteDetailPage } from '@/components/quotes/QuoteDetailPage';
import { getContactByZohoId } from '@/modules/cross-module/relationships-service';
import { isZohoBooksMockEnabled } from '@/modules/integrations/zoho/config';
import {
  watchAction, unwatchAction, changeQuoteStatusAction, emailQuoteAction, cloneQuoteAction, refreshQuoteAction,
} from '../actions';

export const runtime = 'nodejs';

export default async function QuoteDetailRoute({ params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session) notFound();
  const user = session!.user;
  if (!hasPermission(user, 'quotes.view')) notFound();
  const { id } = await params;
  const quote = await getQuoteById(id);
  if (!quote) notFound();

  const [isWatched, changeEvents, relatedContact, customer] = await Promise.all([
    isEntityWatched(user.id, QUOTE_ENTITY_TYPE, id),
    getQuoteChangeEvents(id, 50),
    quote!.zohoCustomerId ? getContactByZohoId(quote!.zohoCustomerId) : Promise.resolve(null),
    quote!.zohoCustomerId ? getCustomerForQuote(quote!.zohoCustomerId) : Promise.resolve(null),
  ]);

  return (
    <QuoteDetailPage
      quote={quote!}
      changeEvents={changeEvents}
      entityLabel="Cotización"
      entityLabelPlural="Cotizaciones"
      basePath="/app/quotes"
      isWatched={isWatched}
      canWatch={hasPermission(user, 'quotes.watch')}
      canEdit={hasPermission(user, 'quotes.edit')}
      canCreate={hasPermission(user, 'quotes.create')}
      canChangeStatus={hasPermission(user, 'quotes.change_status')}
      canSendEmail={hasPermission(user, 'quotes.send_email')}
      isMockMode={isZohoBooksMockEnabled()}
      relatedContact={relatedContact}
      customerEmail={customer?.primaryEmail ?? null}
      watchAction={watchAction}
      unwatchAction={unwatchAction}
      changeStatusAction={changeQuoteStatusAction}
      emailAction={emailQuoteAction}
      cloneAction={cloneQuoteAction}
      refreshAction={refreshQuoteAction}
    />
  );
}
