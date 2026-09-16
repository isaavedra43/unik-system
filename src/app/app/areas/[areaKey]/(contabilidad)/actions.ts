'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getCurrentSession, AuthorizationError } from '@/modules/auth/authorization';
import { CONTABILIDAD_BASE_PATH } from '@/modules/areas/contabilidad/contabilidad-model';
import {
  updateFinanceSettings,
  type FinanceSettings,
  type FinanceSettingsPatch,
} from '@/modules/finance/finance-config';
import { isOperationsError } from '@/modules/operations/errors';

/**
 * Server actions de las páginas de gestión de Contabilidad (plan 6.4).
 *
 * Aquí no se decide nada: `updateFinanceSettings` vuelve a exigir
 * `finance.manage_catalog`, valida el parche con su propio esquema Zod y deja
 * la entrada de auditoría. La puerta de la página no es un permiso para un
 * POST, así que la sesión se vuelve a pedir.
 */

function errorMessage(error: unknown): string {
  if (error instanceof AuthorizationError) return error.message;
  if (isOperationsError(error)) return error.message;
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return issue ? `${issue.path.join('.') || 'dato'}: ${issue.message}` : 'Datos inválidos';
  }
  if (error instanceof Error) return error.message;
  return 'Ocurrió un error inesperado';
}

export async function saveFinanceSettingsAction(
  patch: FinanceSettingsPatch
): Promise<{ success: boolean; error: string | null; settings: FinanceSettings | null }> {
  try {
    const session = await getCurrentSession();
    if (!session) redirect('/login');
    const settings = await updateFinanceSettings(session.user, patch);
    revalidatePath(`${CONTABILIDAD_BASE_PATH}/catalogos`);
    return { success: true, error: null, settings };
  } catch (error) {
    return { success: false, error: errorMessage(error), settings: null };
  }
}
