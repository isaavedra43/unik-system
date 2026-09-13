import { randomUUID } from 'node:crypto';
import { requirePermission } from '@/modules/auth/authorization';
import { QuoteForm } from '@/components/quotes/QuoteForm';
import { isZohoBooksMockEnabled } from '@/modules/integrations/zoho/config';
import { getCustomerForQuote } from '@/modules/quotes/quotes-service';
import type { QuoteFormInput } from '@/modules/quotes/quotes-form-schema';
import { createQuoteAction } from '../actions';

export const runtime = 'nodejs';

interface SearchParams { customer?: string }

export default async function NewQuotePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission('quotes.create');
  const params = await searchParams;
  const preselected = params.customer ? await getCustomerForQuote(params.customer) : null;

  const today = new Date().toISOString().slice(0, 10);
  const expiry = new Date(); expiry.setDate(expiry.getDate() + 15);

  const initialValues: QuoteFormInput = {
    requestKey: randomUUID(),
    customerId: preselected?.zohoContactId ?? '',
    date: today,
    expiryDate: expiry.toISOString().slice(0, 10),
    referenceNumber: null,
    salespersonName: null,
    notes: null,
    terms: null,
    discountMode: 'none',
    discountValue: null,
    discountIsPercent: true,
    isDiscountBeforeTax: true,
    shippingCharge: null,
    adjustment: null,
    adjustmentDescription: null,
    templateId: null,
    expectedRemoteModifiedAt: null,
    items: [],
  };

  return (
    <QuoteForm
      mode="create"
      basePath="/app/quotes"
      initialValues={initialValues}
      initialCustomer={preselected}
      isMockMode={isZohoBooksMockEnabled()}
      submitAction={createQuoteAction}
    />
  );
}
