import { prisma } from '@/lib/prisma';
import { recordUsage } from './usage-meter';

/**
 * Audit trail for external executions. Never contains secrets: only sizes,
 * status, duration and error codes/messages (which are redacted upstream).
 */
export interface ExtensionExecutionInput {
  extensionId: string | null;
  capabilityId: string | null;
  connectionId?: string | null;
  userId: string | null;
  toolName: string;
  status: 'success' | 'error' | 'denied' | 'timeout' | 'pending_review' | 'needs_approval';
  durationMs: number;
  requestBytes: number;
  responseBytes: number;
  errorCode?: string;
  errorMessage?: string;
  proposalId?: string;
}

export async function recordExtensionExecution(input: ExtensionExecutionInput): Promise<void> {
  await prisma.extensionExecution.create({
    data: {
      extensionId: input.extensionId,
      capabilityId: input.capabilityId,
      connectionId: input.connectionId ?? null,
      userId: input.userId,
      toolName: input.toolName,
      status: input.status,
      durationMs: input.durationMs,
      requestBytes: input.requestBytes,
      responseBytes: input.responseBytes,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ? input.errorMessage.slice(0, 1000) : null,
      proposalId: input.proposalId ?? null,
    },
  });
  if (input.extensionId) {
    await recordUsage('extension', input.extensionId, 'calls', 1).catch(() => undefined);
    await recordUsage(
      'extension',
      input.extensionId,
      'bytes',
      input.requestBytes + input.responseBytes
    ).catch(() => undefined);
  }
  if (input.userId) {
    await recordUsage('user', input.userId, 'extension_calls', 1).catch(() => undefined);
  }
}
