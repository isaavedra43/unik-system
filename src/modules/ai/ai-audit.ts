import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';

type PrismaExecutor = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

interface AiApiCallInput {
  userId?: string | null;
  conversationId?: string | null;
  deployment: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  success?: boolean;
  errorCode?: string | null;
  finishReason?: string | null;
}

interface AiToolCallInput {
  messageId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  durationMs?: number;
  success?: boolean;
  errorCode?: string | null;
}

interface AiAuditEventInput {
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Records an AI-related audit event in the shared AuditLog table.
 * NEVER pass secrets, API keys, or session tokens inside metadata.
 */
export async function recordAiAuditEvent(
  event: AiAuditEventInput,
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

/** Records a single AI provider API call for consumption monitoring. */
export async function recordAiApiCall(
  call: AiApiCallInput,
  tx: PrismaExecutor = prisma
): Promise<void> {
  await tx.aiApiCall.create({
    data: {
      userId: call.userId ?? null,
      conversationId: call.conversationId ?? null,
      deployment: call.deployment,
      promptTokens: call.promptTokens ?? 0,
      completionTokens: call.completionTokens ?? 0,
      totalTokens: call.totalTokens ?? 0,
      durationMs: call.durationMs ?? 0,
      success: call.success ?? true,
      errorCode: call.errorCode ?? null,
      finishReason: call.finishReason ?? null,
    },
  });
}

/** Records a single tool call execution for audit and admin monitoring. */
export async function recordAiToolCall(
  call: AiToolCallInput,
  tx: PrismaExecutor = prisma
): Promise<void> {
  await tx.aiToolCall.create({
    data: {
      messageId: call.messageId,
      toolName: call.toolName,
      args: call.args as Prisma.InputJsonValue,
      result: call.result === undefined ? Prisma.JsonNull : (call.result as Prisma.InputJsonValue),
      durationMs: call.durationMs ?? 0,
      success: call.success ?? true,
      errorCode: call.errorCode ?? null,
    },
  });
}
