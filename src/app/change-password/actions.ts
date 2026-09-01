'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { changeOwnPassword } from '@/modules/auth/auth-service';
import { getCurrentSession } from '@/modules/auth/authorization';
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

export interface ChangePasswordFormState {
  error: string | null;
}

export async function forcedChangePasswordAction(
  _prevState: ChangePasswordFormState,
  formData: FormData
): Promise<ChangePasswordFormState> {
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
    return { error: parsed.error.issues[0]?.message ?? 'Datos inválidos' };
  }

  const result = await changeOwnPassword(
    session.user.id,
    session.sessionId,
    parsed.data.currentPassword,
    parsed.data.newPassword
  );

  if (!result.ok) {
    return { error: result.error };
  }

  redirect('/app');
}
