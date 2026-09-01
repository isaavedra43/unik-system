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
          <h2 className="auth-hero-title">UNIK</h2>
          <p className="auth-hero-subtitle">Sistema de operación empresarial</p>
          <p className="auth-hero-blurb">
            Controla tu operación desde un solo lugar. Seguro, limpio y pensado para escalar.
          </p>
        </div>
      </div>

      <div className="auth-form-wrap">
        <div className="auth-card">
          <div className="auth-brand">
            <strong>UNIK System</strong>
            <p>Ingresa a tu cuenta</p>
          </div>
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
