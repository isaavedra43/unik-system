import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/modules/auth/authorization';
import { ChangePasswordForm } from './change-password-form';

export const runtime = 'nodejs';

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
      <div className="auth-hero" aria-hidden="true">
        <div className="auth-hero-shape" style={{ width: 360, height: 360, top: -80, left: -80 }} />
        <div
          className="auth-hero-shape"
          style={{ width: 240, height: 240, bottom: 40, right: -40 }}
        />
        <div
          className="auth-hero-shape"
          style={{ width: 120, height: 120, top: '40%', right: '20%' }}
        />
        <div className="auth-hero-inner">
          <span className="auth-hero-mark">U</span>
          <h2 className="auth-hero-title">Actualiza tu acceso</h2>
          <p className="auth-hero-blurb">Es un paso único que mantiene tu cuenta protegida.</p>
        </div>
      </div>

      <div className="auth-form-wrap">
        <div className="auth-card">
          <div className="auth-brand">
            <span className="auth-brand-mark">U</span>
            <strong>UNIK System</strong>
            <p>Cambio de contraseña requerido</p>
          </div>
          <div className="alert alert-warning" style={{ marginBottom: '1.25rem' }}>
            Por seguridad debes establecer una nueva contraseña antes de continuar.
          </div>
          <ChangePasswordForm />
        </div>
      </div>
    </div>
  );
}
