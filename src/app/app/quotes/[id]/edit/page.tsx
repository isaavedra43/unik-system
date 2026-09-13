import { randomUUID } from 'node:crypto';
import { notFound, redirect } from 'next/navigation';
import { requirePermission } from '@/modules/auth/authorization';
import { prisma } from '@/lib/prisma';
import { QuoteForm } from '@/components/quotes/QuoteForm';
import { isZohoBooksMockEnabled } from '@/modules/integrations/zoho/config';
import { getQuoteById, getCustomerForQuote } from '@/modules/quotes/quotes-service';
import { quoteToFormInput } from '@/modules/quotes/quotes-write-service';
import { getSalespersonsForQuote } from '@/modules/quotes/quotes-salespersons';
import { isQuoteEditable } from '@/modules/quotes/quotes-helpers';
import { updateQuoteAction } from '../../actions';

export const runtime = 'nodejs';

export default async function EditQuotePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('quotes.edit');
  const { id } = await params;
  const quote = await getQuoteById(id);
  if (!quote) notFound();
  if (!isQuoteEditable(quote!.status)) redirect(`/app/quotes/${id}`);

  const [customer, salespersons, products] = await Promise.all([
    quote!.zohoCustomerId ? getCustomerForQuote(quote!.zohoCustomerId) : Promise.resolve(null),
    getSalespersonsForQuote(),
    prisma.product.findMany({
      where: { zohoItemId: { in: quote!.items.map((i) => i.zohoItemId).filter((v): v is string => Boolean(v)) } },
      select: { zohoItemId: true, sku: true, taxName: true, taxPercentage: true },
    }),
  ]);
  const lineTaxes = Object.fromEntries(
    quote!.items.filter((i) => i.zohoItemId).map((i) => {
      const p = products.find((x) => x.zohoItemId === i.zohoItemId);
      return [i.zohoItemId as string, {
        taxName: i.taxName ?? p?.taxName ?? null,
        taxPercent: i.taxPercentage ? Number(i.taxPercentage) : p?.taxPercentage ? Number(p.taxPercentage) : null,
        sku: i.sku ?? p?.sku ?? null,
      }];
    })
  );

  const initialValues = quoteToFormInput(quote!, randomUUID());
  const boundUpdate = updateQuoteAction.bind(null, id);

  return (
    <QuoteForm
      mode="edit"
      basePath="/app/quotes"
      quoteId={id}
      initialValues={initialValues}
      initialCustomer={customer}
      salespersons={salespersons}
      initialLineTaxes={lineTaxes}
      estimateNumber={quote!.estimateNumber}
      isMockMode={isZohoBooksMockEnabled()}
      submitAction={boundUpdate}
    />
  );
}
