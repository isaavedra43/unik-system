import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/modules/auth/authorization';

export const runtime = 'nodejs';

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  redirect('/app');
}
