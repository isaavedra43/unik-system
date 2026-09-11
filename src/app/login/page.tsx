import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/modules/auth/authorization';
import { Icon } from '@/components/ui/icons';
import { LoginForm } from './login-form';

export const runtime = 'nodejs';

const HERO_FEATURES = [
  { icon: 'layers', label: 'Toda tu operación en un solo panel' },
  { icon: 'shield', label: 'Accesos y permisos por rol' },
  { icon: 'refreshCw', label: 'Sincronización en tiempo real' },
] as const;

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
          <span className="auth-hero-mark">U</span>
          <h2 className="auth-hero-title">Bienvenido a UNIK</h2>
          <p className="auth-hero-subtitle">Sistema de operación empresarial</p>
          <p className="auth-hero-blurb">
            Controla tu operación desde un solo lugar. Seguro, limpio y pensado para escalar.
          </p>
          <ul className="auth-hero-features">
            {HERO_FEATURES.map((feature) => (
              <li key={feature.label}>
                <span className="auth-feature-dot">
                  <Icon name={feature.icon} size={13} />
                </span>
                {feature.label}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="auth-form-wrap">
        <div className="auth-card">
          <div className="auth-brand">
            <span className="auth-brand-mark">U</span>
            <strong>UNIK System</strong>
            <p>Ingresa a tu cuenta</p>
          </div>
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
