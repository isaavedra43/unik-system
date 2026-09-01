'use client';

import { useActionState, useState } from 'react';
import { Alert, Button, FormField, Input, Modal, Toast } from '@/components/ui';
import { changeOwnPasswordAction, logoutAllDevicesAction, SecurityFormState } from './actions';

const initialState: SecurityFormState = { error: null, success: null };

export function ChangeOwnPasswordForm() {
  const [state, formAction, pending] = useActionState(changeOwnPasswordAction, initialState);

  return (
    <form action={formAction}>
      {state.error ? <Alert variant="error">{state.error}</Alert> : null}
      {state.success ? <Alert variant="success">{state.success}</Alert> : null}

      <FormField label="Contraseña actual" htmlFor="currentPassword">
        <Input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
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

      <Button type="submit" isLoading={pending}>
        Cambiar contraseña
      </Button>
    </form>
  );
}

export function LogoutAllDevicesForm() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  return (
    <>
      <p className="text-muted" style={{ marginBottom: '1rem' }}>
        Revoca todas las sesiones activas de tu cuenta en todos los dispositivos.
      </p>
      <Button variant="danger" onClick={() => setConfirmOpen(true)}>
        Cerrar sesión en todos los dispositivos
      </Button>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Cerrar sesión en todos los dispositivos"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancelar
            </Button>
            <form action={logoutAllDevicesAction}>
              <Button type="submit" variant="danger" onClick={() => setConfirmOpen(false)}>
                Confirmar
              </Button>
            </form>
          </>
        }
      >
        <p>
          Tendrás que volver a iniciar sesión en este y todos los demás dispositivos. ¿Continuar?
        </p>
      </Modal>

      <Toast
        visible={showSuccess}
        message="Sesiones cerradas correctamente"
        onClose={() => setShowSuccess(false)}
      />
    </>
  );
}
