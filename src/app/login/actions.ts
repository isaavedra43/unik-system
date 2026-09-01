'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { login } from '@/modules/auth/auth-service';
import { AUTH_SESSION_TTL_HOURS, SESSION_COOKIE_NAME } from '@/modules/auth/constants';

const loginSchema = z.object({
  identifier: z.string().min(1).max(200),
  password: z.string().min(1).max(200),
});

export interface LoginFormState {
  error: string | null;
}

export async function loginAction(
  _prevState: LoginFormState,
  formData: FormData
): Promise<LoginFormState> {
  const parsed = loginSchema.safeParse({
    identifier: formData.get('identifier'),
    password: formData.get('password'),
  });

  if (!parsed.success) {
    return { error: 'Usuario o contraseña incorrectos' };
  }

  const result = await login(parsed.data.identifier, parsed.data.password);

  if (!result.ok) {
    return { error: result.error };
  }

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, result.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: AUTH_SESSION_TTL_HOURS * 60 * 60,
  });

  redirect(result.mustChangePassword ? '/change-password' : '/app');
}
