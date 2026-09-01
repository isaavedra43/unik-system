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
  assignRoles,
  changeUserStatus,
  createUser,
  resetUserPassword,
  updateUser,
  UserManagementError,
} from '@/modules/users/users-service';

const USERS_PATH = '/app/admin/users';

function errorMessage(error: unknown): string {
  if (error instanceof UserManagementError || error instanceof AuthorizationError) {
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

import { usernameSchema } from '@/modules/auth/username';

const createUserSchema = z.object({
  name: z.string().trim().min(1, 'El nombre es requerido').max(200),
  username: usernameSchema,
  email: z.union([z.literal(''), z.string().trim().email('Correo inválido')]).optional(),
  roleIds: z.array(z.string()).default([]),
});

export interface CreateUserFormState {
  error: string | null;
  created: { username: string; temporaryPassword: string } | null;
}

export async function createUserAction(
  _prevState: CreateUserFormState,
  formData: FormData
): Promise<CreateUserFormState> {
  try {
    const actor = await requireActor('users.create');

    const parsed = createUserSchema.safeParse({
      name: formData.get('name'),
      username: formData.get('username'),
      email: formData.get('email') ?? '',
      roleIds: formData.getAll('roleIds').map(String),
    });

    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? 'Datos inválidos', created: null };
    }

    const result = await createUser(actor, {
      name: parsed.data.name,
      username: parsed.data.username,
      email: parsed.data.email || null,
      roleIds: parsed.data.roleIds,
    });

    revalidatePath(USERS_PATH);
    return {
      error: null,
      created: {
        username: parsed.data.username.trim().toLowerCase(),
        temporaryPassword: result.temporaryPassword,
      },
    };
  } catch (error) {
    return { error: errorMessage(error), created: null };
  }
}

const updateUserSchema = z.object({
  userId: z.string().min(1),
  name: z.string().trim().min(1, 'El nombre es requerido').max(200),
  email: z.union([z.literal(''), z.string().trim().email('Correo inválido')]).optional(),
});

export interface SimpleFormState {
  error: string | null;
  success: boolean;
}

export async function updateUserAction(
  _prevState: SimpleFormState,
  formData: FormData
): Promise<SimpleFormState> {
  try {
    const actor = await requireActor('users.update');

    const parsed = updateUserSchema.safeParse({
      userId: formData.get('userId'),
      name: formData.get('name'),
      email: formData.get('email') ?? '',
    });

    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? 'Datos inválidos', success: false };
    }

    await updateUser(actor, parsed.data.userId, {
      name: parsed.data.name,
      email: parsed.data.email || null,
    });

    revalidatePath(USERS_PATH);
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

const changeStatusSchema = z.object({
  userId: z.string().min(1),
  isActive: z.enum(['true', 'false']),
});

export async function changeUserStatusAction(
  _prevState: SimpleFormState,
  formData: FormData
): Promise<SimpleFormState> {
  try {
    const actor = await requireActor('users.change_status');

    const parsed = changeStatusSchema.safeParse({
      userId: formData.get('userId'),
      isActive: formData.get('isActive'),
    });

    if (!parsed.success) {
      return { error: 'Datos inválidos', success: false };
    }

    await changeUserStatus(actor, parsed.data.userId, parsed.data.isActive === 'true');

    revalidatePath(USERS_PATH);
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

const assignRolesSchema = z.object({
  userId: z.string().min(1),
  roleIds: z.array(z.string()).default([]),
});

export async function assignRolesAction(
  _prevState: SimpleFormState,
  formData: FormData
): Promise<SimpleFormState> {
  try {
    const actor = await requireActor('users.assign_roles');

    const parsed = assignRolesSchema.safeParse({
      userId: formData.get('userId'),
      roleIds: formData.getAll('roleIds').map(String),
    });

    if (!parsed.success) {
      return { error: 'Datos inválidos', success: false };
    }

    await assignRoles(actor, parsed.data.userId, parsed.data.roleIds);

    revalidatePath(USERS_PATH);
    return { error: null, success: true };
  } catch (error) {
    return { error: errorMessage(error), success: false };
  }
}

const resetPasswordSchema = z.object({
  userId: z.string().min(1),
});

export interface ResetPasswordFormState {
  error: string | null;
  temporaryPassword: string | null;
}

export async function resetPasswordAction(
  _prevState: ResetPasswordFormState,
  formData: FormData
): Promise<ResetPasswordFormState> {
  try {
    const actor = await requireActor('users.reset_password');

    const parsed = resetPasswordSchema.safeParse({ userId: formData.get('userId') });
    if (!parsed.success) {
      return { error: 'Datos inválidos', temporaryPassword: null };
    }

    const result = await resetUserPassword(actor, parsed.data.userId);

    revalidatePath(USERS_PATH);
    return { error: null, temporaryPassword: result.temporaryPassword };
  } catch (error) {
    return { error: errorMessage(error), temporaryPassword: null };
  }
}
