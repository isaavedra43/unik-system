'use client';

import { useActionState } from 'react';
import { Alert, Button, FormField, Input } from '@/components/ui/primitives';
import { ChangePasswordFormState, forcedChangePasswordAction } from './actions';

const initialState: ChangePasswordFormState = { error: null };

export function ChangePasswordForm() {
  const [state, formAction, pending] = useActionState(forcedChangePasswordAction, initialState);

  return (
    <form action={formAction}>
      {state.error ? <Alert variant="error">{state.error}</Alert> : null}

      <FormField label="Contraseña actual" htmlFor="currentPassword">
        <Input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
        />
      </FormField>

      <FormField label="Nueva contraseña" htmlFor="newPassword" help="Mínimo 12 caracteres.">
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
      </FormField>

      <FormField label="Confirmar nueva contraseña" htmlFor="confirmNewPassword">
        <Input
          id="confirmNewPassword"
          name="confirmNewPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
        />
      </FormField>

      <Button type="submit" full isLoading={pending} style={{ marginTop: '0.5rem' }}>
        Cambiar contraseña
      </Button>
    </form>
  );
}
