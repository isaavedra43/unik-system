import { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { requireAuthenticatedUser } from '@/modules/auth/authorization';
import AppShell from '@/components/layout/AppShell';

export const runtime = 'nodejs';

/**
 * Protected application shell. Real access control happens HERE server-side
 * (and again in every nested page/action) — never rely on hidden links alone.
 */
export default async function AppLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const user = await requireAuthenticatedUser();

  if (user.mustChangePassword) {
    redirect('/change-password');
  }

  return <AppShell user={user}>{children}</AppShell>;
}
