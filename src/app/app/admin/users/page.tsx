import { redirect } from 'next/navigation';

export const runtime = 'nodejs';

export default function AdminUsersRedirectPage() {
  redirect('/app/admin/access?tab=users');
}
