import { notFound } from 'next/navigation';
import { getCurrentSession, hasPermission } from '@/modules/auth/authorization';
import { getContactById } from '@/modules/contacts/contacts-service';
import { isEntityWatched } from '@/modules/sales/entity-watch-service';
import { CONTACT_ENTITY_TYPE_VENDOR } from '@/modules/contacts/permissions';
import { getVendorProfile } from '@/modules/contacts/vendor-profile-service';
import { VendorDetailView } from '@/components/contacts/vendor/VendorDetailView';
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

  const user = session!.user;
  const isWatched = await isEntityWatched(user.id, CONTACT_ENTITY_TYPE_VENDOR, id);
  const canWatch = user.isSuperAdmin || user.permissionKeys.includes('vendors.watch');

  // Every document is linked by the Zoho vendor id; sections the user can't see are omitted.
  const profile = await getVendorProfile(contact!, {
    recent: 8,
    access: {
      purchaseOrders: hasPermission(user, 'purchase_orders.view'),
      bills: hasPermission(user, 'bills.view'),
      vendorCredits: hasPermission(user, 'vendor_credits.view'),
    },
  });

  return (
    <VendorDetailView
      contact={contact!}
      profile={profile}
      isWatched={isWatched}
      canWatch={canWatch}
      watchAction={watchAction}
      unwatchAction={unwatchAction}
    />
  );
}
