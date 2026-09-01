'use client';

import { useActionState, useState } from 'react';
import { loginAction, LoginFormState } from './actions';

const initialState: LoginFormState = { error: null };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={formAction}>
      {state.error ? <div className="alert alert-error">{state.error}</div> : null}

      <div className="form-field">
        <label htmlFor="identifier">Usuario o correo</label>
        <input
          id="identifier"
          name="identifier"
          type="text"
          className="input"
          autoComplete="username"
          required
          autoFocus
        />
      </div>

      <div className="form-field">
        <label htmlFor="password">Contraseña</label>
        <input
          id="password"
          name="password"
          type={showPassword ? 'text' : 'password'}
          className="input"
          autoComplete="current-password"
          required
        />
        <label className="checkbox-row muted" style={{ marginTop: '0.35rem' }}>
          <input
            type="checkbox"
            checked={showPassword}
            onChange={(event) => setShowPassword(event.target.checked)}
          />
          Mostrar contraseña
        </label>
      </div>

      <button type="submit" className="btn btn-block" disabled={pending}>
        {pending ? 'Verificando…' : 'Iniciar sesión'}
      </button>
    </form>
  );
}
