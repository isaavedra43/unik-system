import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/modules/auth/authorization';
import { LoginForm } from './login-form';

export const runtime = 'nodejs';

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) {
    redirect(user.mustChangePassword ? '/change-password' : '/app');
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <strong>UNIK</strong>
          <p className="muted">Acceso al sistema</p>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
