'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { changeOwnPassword, logoutAllDevices } from '@/modules/auth/auth-service';
import { getCurrentSession } from '@/modules/auth/authorization';
import { SESSION_COOKIE_NAME } from '@/modules/auth/constants';
import { passwordSchema } from '@/modules/auth/password';

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'La contraseña actual es requerida').max(200),
    newPassword: passwordSchema,
    confirmNewPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: 'Las contraseñas no coinciden',
    path: ['confirmNewPassword'],
  });

export interface SecurityFormState {
  error: string | null;
  success: string | null;
}

export async function changeOwnPasswordAction(
  _prevState: SecurityFormState,
  formData: FormData
): Promise<SecurityFormState> {
  const session = await getCurrentSession();
  if (!session) {
    redirect('/login');
  }

  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get('currentPassword'),
    newPassword: formData.get('newPassword'),
    confirmNewPassword: formData.get('confirmNewPassword'),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Datos inválidos', success: null };
  }

  const result = await changeOwnPassword(
    session.user.id,
    session.sessionId,
    parsed.data.currentPassword,
    parsed.data.newPassword
  );

  if (!result.ok) {
    return { error: result.error, success: null };
  }

  return {
    error: null,
    success: 'Contraseña actualizada. Se cerraron las sesiones en otros dispositivos.',
  };
}

export async function logoutAllDevicesAction(): Promise<void> {
  const session = await getCurrentSession();
  if (!session) {
    redirect('/login');
  }

  await logoutAllDevices(session.user.id);

  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
  redirect('/login');
}
