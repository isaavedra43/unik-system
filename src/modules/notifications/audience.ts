import { prisma } from '@/lib/prisma';

/**
 * Audience helpers: who should receive a notification when the event is not
 * addressed to one specific user (a customer message on a shared inbox, a
 * ringing call on a team line...).
 */

export interface AudienceOptions {
  /** Restrict to users holding one of these role keys (team keys). Empty = everyone with the permission. */
  roleKeys?: string[];
  excludeUserIds?: Array<string | null | undefined>;
  limit?: number;
}

/** Active users holding `permissionKey` (super admins always qualify). */
export async function findUsersWithPermission(
  permissionKey: string,
  options: AudienceOptions = {}
): Promise<string[]> {
  const exclude = new Set((options.excludeUserIds ?? []).filter((id): id is string => Boolean(id)));
  const roleKeys = (options.roleKeys ?? []).filter(Boolean);
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      roles: {
        some: {
          role: {
            isActive: true,
            OR: [
              { key: 'super_admin' },
              {
                permissions: { some: { permissionKey } },
                ...(roleKeys.length > 0 ? { key: { in: roleKeys } } : {}),
              },
            ],
          },
        },
      },
    },
    select: { id: true },
    take: options.limit ?? 200,
  });
  return users.map((u) => u.id).filter((id) => !exclude.has(id));
}

/** Resolves a person by name/username/email among active users (for the AI tool). */
export async function findUsersByQuery(
  query: string,
  options: { excludeUserId?: string; limit?: number } = {}
): Promise<Array<{ id: string; name: string; username: string; email: string | null }>> {
  const q = query.trim();
  if (!q) return [];
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      ...(options.excludeUserId ? { id: { not: options.excludeUserId } } : {}),
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { username: { contains: q, mode: 'insensitive' } },
        { email: { equals: q, mode: 'insensitive' } },
      ],
    },
    select: { id: true, name: true, username: true, email: true },
    orderBy: { name: 'asc' },
    take: options.limit ?? 10,
  });
  // Exact username/name match wins when several people share a first name.
  const exact = users.filter(
    (u) => u.username.toLowerCase() === q.toLowerCase() || u.name.toLowerCase() === q.toLowerCase()
  );
  return exact.length === 1 ? exact : users;
}
