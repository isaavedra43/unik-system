import { redirect } from 'next/navigation';

export const runtime = 'nodejs';

export default function AdminRolesRedirectPage() {
  redirect('/app/admin/access?tab=roles');
}
