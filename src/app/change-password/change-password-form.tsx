'use client';

import { useActionState } from 'react';
import { ChangePasswordFormState, forcedChangePasswordAction } from './actions';

const initialState: ChangePasswordFormState = { error: null };

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(forcedChangePasswordAction, initialState);

  return (
    <form action={formAction}>
      {state.error ? <div className="alert alert-error">{state.error}</div> : null}

      <div className="form-field">
        <label htmlFor="currentPassword">Contraseña actual</label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          className="input"
          autoComplete="current-password"
          required
          autoFocus
        />
      </div>

      <div className="form-field">
        <label htmlFor="newPassword">Nueva contraseña</label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          className="input"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
        <p className="muted">Mínimo 12 caracteres.</p>
      </div>

      <div className="form-field">
        <label htmlFor="confirmNewPassword">Confirmar nueva contraseña</label>
        <input
          id="confirmNewPassword"
          name="confirmNewPassword"
          type="password"
          className="input"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
      </div>

      <button type="submit" className="btn btn-block" disabled={pending}>
        {pending ? 'Guardando…' : 'Cambiar contraseña'}
      </button>
    </form>
  );
}
