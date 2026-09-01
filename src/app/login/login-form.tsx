'use client';

import { useActionState, useState } from 'react';
import { Button, FormField, Input, Alert } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/icons';
import { loginAction, LoginFormState } from './actions';

const initialState: LoginFormState = { error: null };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={formAction}>
      {state.error ? (
        <Alert variant="error" title="No se pudo iniciar sesión">
          {state.error}
        </Alert>
      ) : null}

      <FormField label="Usuario o correo" htmlFor="identifier">
        <Input
          id="identifier"
          name="identifier"
          type="text"
          autoComplete="username"
          required
          autoFocus
          placeholder="usuario@empresa.com"
        />
      </FormField>

      <FormField label="Contraseña" htmlFor="password">
        <div style={{ position: 'relative' }}>
          <Input
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            required
            placeholder="••••••••"
            style={{ paddingRight: '2.75rem' }}
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className="icon-btn"
            style={{
              position: 'absolute',
              right: '0.4rem',
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--unik-text-muted)',
            }}
            aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
          >
            <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
          </button>
        </div>
      </FormField>

      <Button type="submit" full isLoading={pending} style={{ marginTop: '0.5rem' }}>
        Iniciar sesión
      </Button>
    </form>
  );
}
