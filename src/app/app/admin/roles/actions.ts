'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  assertPermission,
  AuthorizationError,
  getCurrentSession,
} from '@/modules/auth/authorization';
import {
  createRole,
  deleteRole,
  RoleManagementError,
  saveRolePermissions,
  updateRole,
} from '@/modules/roles/roles-service';

const ROLES_PATH = '/app/admin/roles';

function errorMessage(error: unknown): string {
  if (error instanceof RoleManagementError || error instanceof AuthorizationError) {
    return error.message;
  }
  return 'Ocurrió un error inesperado';
}

async function requireActor(permission: string) {
  const session = await getCurrentSession();
  if (!session) {
    redirect('/login');
  }
  assertPermission(session.user, permission);
  return session.user;
}

export interface SimpleFormState {
  error: string | null;
  success: boolean;
}

const createRoleSchema = z.object({
  name: z.string().trim().min(2, 'El nombre debe tener al menos 2 caracteres').max(100),
  description: z.string().trim().max(300).optional(),
});

export async function createRoleAction(
  _prevState: SimpleFormState,
  formData: FormData
): Promise<SimpleFormState> {
  try {
    const actor = await requireActor('roles.create');

    const parsed = createRoleSchema.safeParse({
      name: formData.get('name'),
      description: formData.get('description') ?? '',
    });

    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? 'Datos inválidos', success: false };
    }

    await createRole(actor, {
      name: parsed.data.name,
      description: parsed.data.description || null,
    });

    revalidatePath(ROLES_PATH);
    revalidatePath('/app/admin/access');
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

const updateRoleSchema = z.object({
  roleId: z.string().min(1),
  name: z.string().trim().min(2, 'El nombre debe tener al menos 2 caracteres').max(100),
  description: z.string().trim().max(300).optional(),
});

export async function updateRoleAction(
  _prevState: SimpleFormState,
  formData: FormData
): Promise<SimpleFormState> {
  try {
    const actor = await requireActor('roles.update');

    const parsed = updateRoleSchema.safeParse({
      roleId: formData.get('roleId'),
      name: formData.get('name'),
      description: formData.get('description') ?? '',
    });

    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? 'Datos inválidos', success: false };
    }

    await updateRole(actor, parsed.data.roleId, {
      name: parsed.data.name,
      description: parsed.data.description || null,
    });

    revalidatePath(ROLES_PATH);
    revalidatePath('/app/admin/access');
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

const deleteRoleSchema = z.object({
  roleId: z.string().min(1),
});

export async function deleteRoleAction(
  _prevState: SimpleFormState,
  formData: FormData
): Promise<SimpleFormState> {
  try {
    const actor = await requireActor('roles.delete');

    const parsed = deleteRoleSchema.safeParse({ roleId: formData.get('roleId') });
    if (!parsed.success) {
      return { error: 'Datos inválidos', success: false };
    }

    await deleteRole(actor, parsed.data.roleId);

    revalidatePath(ROLES_PATH);
    revalidatePath('/app/admin/access');
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

const savePermissionsSchema = z.object({
  roleId: z.string().min(1),
  permissionKeys: z.array(z.string()).default([]),
});

export async function savePermissionsAction(
  _prevState: SimpleFormState,
  formData: FormData
): Promise<SimpleFormState> {
  try {
    const actor = await requireActor('roles.manage_permissions');

    const parsed = savePermissionsSchema.safeParse({
      roleId: formData.get('roleId'),
      permissionKeys: formData.getAll('permissionKeys').map(String),
    });

    if (!parsed.success) {
      return { error: 'Datos inválidos', success: false };
    }

    await saveRolePermissions(actor, parsed.data.roleId, parsed.data.permissionKeys);

    revalidatePath(ROLES_PATH);
    revalidatePath('/app/admin/access');
    revalidatePath(`${ROLES_PATH}/${parsed.data.roleId}`);
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}
