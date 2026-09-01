import { redirect } from 'next/navigation';

export const runtime = 'nodejs';

interface RoleDetailRedirectPageProps {
  params: Promise<{ id: string }>;
}

export default async function RoleDetailRedirectPage({ params }: RoleDetailRedirectPageProps) {
  const { id } = await params;
  redirect(`/app/admin/access?tab=roles&role=${encodeURIComponent(id)}`);
}
