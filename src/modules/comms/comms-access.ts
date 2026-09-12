import type { CommAccount, Prisma } from '@prisma/client';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { CommsError } from './comms-errors';

/**
 * Team scoping for the inbox. An account belongs to teams (role keys). A user
 * sees an account when one of their active roles is in `teamKeys`, or when
 * they administer channels / are super admin. Identifiers never grant access.
 */

export function isInboxAdmin(user: CurrentUser): boolean {
  return user.isSuperAdmin || hasPermission(user, 'inbox.admin');
}

export function teamKeysOf(user: CurrentUser): string[] {
  return [...new Set(user.roleKeys)];
}

export function canAccessAccount(user: CurrentUser, account: Pick<CommAccount, 'teamKeys'>): boolean {
  if (!hasPermission(user, 'inbox.use') && !isInboxAdmin(user)) return false;
  if (isInboxAdmin(user)) return true;
  return account.teamKeys.some((key) => user.roleKeys.includes(key));
}

export function assertAccountAccess(user: CurrentUser, account: Pick<CommAccount, 'teamKeys'>): void {
  if (!canAccessAccount(user, account)) {
    throw new CommsError('No tienes acceso a este canal', 403, 'forbidden');
  }
}

/** Prisma filter for the accounts the user may see. */
export function visibleAccountsWhere(user: CurrentUser): Prisma.CommAccountWhereInput {
  if (isInboxAdmin(user)) return {};
  const keys = teamKeysOf(user);
  if (keys.length === 0) return { id: { in: [] } };
  return { teamKeys: { hasSome: keys } };
}

export function assertInboxUse(user: CurrentUser): void {
  if (!hasPermission(user, 'inbox.use') && !isInboxAdmin(user)) {
    throw new CommsError('Sin permiso para usar la bandeja', 403, 'forbidden');
  }
}

export function assertInboxAssign(user: CurrentUser): void {
  if (!hasPermission(user, 'inbox.assign') && !isInboxAdmin(user)) {
    throw new CommsError('Sin permiso para asignar conversaciones', 403, 'forbidden');
  }
}

export function assertInboxAdmin(user: CurrentUser): void {
  if (!isInboxAdmin(user)) {
    throw new CommsError('Sin permiso para administrar canales', 403, 'forbidden');
  }
}
