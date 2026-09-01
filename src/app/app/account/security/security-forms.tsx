'use client';

import { useActionState } from 'react';
import { changeOwnPasswordAction, logoutAllDevicesAction, SecurityFormState } from './actions';

const initialState: SecurityFormState = { error: null, success: null };

export function ChangeOwnPasswordForm() {
  const [state, formAction, pending] = useActionState(changeOwnPasswordAction, initialState);

  return (
    <form action={formAction}>
      {state.error ? <div className="alert alert-error">{state.error}</div> : null}
      {state.success ? <div className="alert alert-success">{state.success}</div> : null}

      <div className="form-field">
        <label htmlFor="currentPassword">Contraseña actual</label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          className="input"
          autoComplete="current-password"
          required
        />
      </div>

      <div className="grid-2">
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
      </div>
      <p className="muted">Mínimo 12 caracteres.</p>

      <button type="submit" className="btn" disabled={pending}>
        {pending ? 'Guardando…' : 'Cambiar contraseña'}
      </button>
    </form>
  );
}

export function LogoutAllDevicesForm() {
  return (
    <form
      action={logoutAllDevicesAction}
      onSubmit={(event) => {
        if (
          !window.confirm(
            '¿Cerrar sesión en todos los dispositivos? Tendrás que volver a iniciar sesión.'
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <button type="submit" className="btn btn-danger">
        Cerrar sesión en todos los dispositivos
      </button>
    </form>
  );
}
