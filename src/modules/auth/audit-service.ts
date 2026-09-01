import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';

type PrismaExecutor = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export interface AuditEventInput {
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Records an administrative/security audit event.
 * NEVER pass passwords, password hashes, session tokens, cookies or other
 * secrets inside metadata.
 */
export async function recordAuditEvent(
  event: AuditEventInput,
  tx: PrismaExecutor = prisma
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorUserId: event.actorUserId ?? null,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId ?? null,
      metadata: event.metadata,
    },
  });
}
