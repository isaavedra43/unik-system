import { notFound } from 'next/navigation';
import { getCurrentSession } from '@/modules/auth/authorization';
import { getContactById } from '@/modules/contacts/contacts-service';
import { isEntityWatched } from '@/modules/sales/entity-watch-service';
import { CONTACT_ENTITY_TYPE_VENDOR } from '@/modules/contacts/permissions';
import { ContactDetailPage } from '@/components/contacts/ContactDetailPage';
import {
  getPurchaseOrdersByVendorZohoId,
  getBillsByVendorZohoId,
  getVendorCreditsByVendorZohoId,
  getProductsByVendorZohoId,
} from '@/modules/cross-module/relationships-service';
import { watchAction, unwatchAction } from '../actions';

export const runtime = 'nodejs';

export default async function VendorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getCurrentSession();
  if (!session) {
    notFound();
  }

  const { id } = await params;
  let contact;
  try {
    contact = await getContactById(id);
  } catch (error) {
    console.error('Error loading vendor contact:', error);
    notFound();
  }
  if (!contact) {
    notFound();
  }

  const isWatched = await isEntityWatched(session!.user.id, CONTACT_ENTITY_TYPE_VENDOR, id);
  const canWatch = session!.user.isSuperAdmin || session!.user.permissionKeys.includes('vendors.watch');

  let relatedPurchaseOrders: Awaited<ReturnType<typeof getPurchaseOrdersByVendorZohoId>> = [];
  let relatedBills: Awaited<ReturnType<typeof getBillsByVendorZohoId>> = [];
  let relatedVendorCredits: Awaited<ReturnType<typeof getVendorCreditsByVendorZohoId>> = [];
  let relatedProducts: Awaited<ReturnType<typeof getProductsByVendorZohoId>> = [];
  try {
    [relatedPurchaseOrders, relatedBills, relatedVendorCredits, relatedProducts] = await Promise.all([
      getPurchaseOrdersByVendorZohoId(contact!.zohoContactId),
      getBillsByVendorZohoId(contact!.zohoContactId),
      getVendorCreditsByVendorZohoId(contact!.zohoContactId),
      getProductsByVendorZohoId(contact!.zohoContactId),
    ]);
  } catch (error) {
    console.error('Error loading vendor relationships:', error);
  }

  return (
    <ContactDetailPage
      contact={contact!}
      entityLabel="Proveedor"
      entityLabelPlural="Proveedores"
      basePath="/app/contacts/vendors"
      isWatched={isWatched}
      canWatch={canWatch}
      watchAction={watchAction}
      unwatchAction={unwatchAction}
      relatedPurchaseOrders={relatedPurchaseOrders}
      relatedBills={relatedBills}
      relatedVendorCredits={relatedVendorCredits}
      relatedProducts={relatedProducts}
    />
  );
}
