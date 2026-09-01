import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/modules/auth/authorization';
import { ChangePasswordForm } from './change-password-form';

export const runtime = 'nodejs';

/**
 * Forced password change (first login / after admin reset).
 * Regular password changes live in /app/account/security.
 */
export default async function ChangePasswordPage() {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (!user.mustChangePassword) {
    redirect('/app/account/security');
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <strong>UNIK</strong>
          <p className="muted">Cambio de contraseña requerido</p>
        </div>
        <div className="alert alert-warning">
          Debes establecer una nueva contraseña antes de continuar.
        </div>
        <ChangePasswordForm />
      </div>
    </div>
  );
}
