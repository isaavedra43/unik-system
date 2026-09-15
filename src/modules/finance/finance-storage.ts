import { prisma } from '@/lib/prisma';
import type { CurrentUser } from '@/modules/auth/authorization';
import { recordOperationalEvents } from '@/modules/operations/events-service';
import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MIME_TYPES,
  EVIDENCE_STORAGE_PURPOSE,
  defaultEvidenceKindForMime,
} from '@/modules/operations/evidence-service';
import { evidenceStoragePurpose } from '@/modules/operations/operations-storage';
import {
  registerFileAccessResolver,
  registerUploadTargetResolver,
} from '@/modules/storage/storage-access';
import { StorageError } from '@/modules/storage/storage-service';
import { updateExpense } from './finance-commands';
import { hasFinancePermission } from './finance-helpers';
import { FINANCE_AREA_KEY, FINANCE_EVENTS, FINANCE_OBJECT_TYPES } from './types';

/**
 * Storage integration of the internal accounting.
 *
 * - Upload target `expense_receipt` (id = the expense id): ticket, invoice
 *   PDF or voice note of a DRAFT expense, stored with the operational
 *   `evidence` purpose and its limits (image / PDF / audio, 15 MB, restricted
 *   downloads). `createReference` attaches the object through the
 *   `finance.expense.update` command (which re-checks duplicates and queues
 *   the proposal job) and links it as `EvidenceLink(expense)` for the
 *   timelines.
 * - Access resolver for purpose `evidence` (resolvers accumulate per purpose,
 *   so the operations core resolver still applies): the creator of an
 *   expense that references the file, or `finance.view` for files referenced
 *   by expenses, ledger entries or settlements.
 *
 * Client: `uploadFile(file, { target: { type: 'expense_receipt', id: expenseId } })`.
 */

export const EXPENSE_RECEIPT_UPLOAD_TARGET = 'expense_receipt';
export const MAX_RECEIPTS_PER_EXPENSE = 10;

export function canUploadReceipt(
  actor: CurrentUser,
  expense: { createdByUserId: string; status: string; receiptObjectIds: string[] }
): { ok: true } | { ok: false; status: number; code: 'forbidden' | 'invalid'; message: string } {
  const creator = expense.createdByUserId === actor.id;
  if (!creator && !hasFinancePermission(actor, 'finance.post')) {
    return { ok: false, status: 403, code: 'forbidden', message: 'Sólo quien capturó el gasto o Contabilidad adjunta comprobantes' };
  }
  if (!creator && !hasFinancePermission(actor, 'finance.capture_expense') && !hasFinancePermission(actor, 'finance.post')) {
    return { ok: false, status: 403, code: 'forbidden', message: 'Sin permiso para adjuntar comprobantes' };
  }
  if (expense.status !== 'draft') {
    return { ok: false, status: 409, code: 'invalid', message: 'Sólo se adjuntan comprobantes a un gasto en borrador' };
  }
  if (expense.receiptObjectIds.length >= MAX_RECEIPTS_PER_EXPENSE) {
    return { ok: false, status: 409, code: 'invalid', message: `Un gasto admite hasta ${MAX_RECEIPTS_PER_EXPENSE} comprobantes` };
  }
  return { ok: true };
}

export async function canReadFinanceEvidence(actor: CurrentUser, objectId: string): Promise<boolean> {
  const expense = await prisma.expense.findFirst({
    where: { receiptObjectIds: { has: objectId } },
    select: { createdByUserId: true },
  });
  if (expense && expense.createdByUserId === actor.id) return true;
  if (!hasFinancePermission(actor, 'finance.view')) return false;
  if (expense) return true;
  const [entry, settlement] = await Promise.all([
    prisma.ledgerEntry.findFirst({ where: { evidenceObjectIds: { has: objectId } }, select: { id: true } }),
    prisma.obligationSettlement.findFirst({ where: { evidenceObjectIds: { has: objectId } }, select: { id: true } }),
  ]);
  return Boolean(entry || settlement);
}

type GlobalWithFinanceStorage = typeof globalThis & { __unikFinanceStorageRegistered?: boolean };

export function registerFinanceStorageResolvers(): void {
  const scope = globalThis as GlobalWithFinanceStorage;
  if (scope.__unikFinanceStorageRegistered) return;
  scope.__unikFinanceStorageRegistered = true;

  registerUploadTargetResolver(EXPENSE_RECEIPT_UPLOAD_TARGET, async (actor, targetId, declared) => {
    const expenseId = targetId.trim();
    if (!expenseId || expenseId.length > 120) throw new StorageError('Gasto inválido', 'invalid', 400);
    if (!hasFinancePermission(actor, 'finance.capture_expense') && !hasFinancePermission(actor, 'finance.post')) {
      throw new StorageError('Sin permiso para adjuntar comprobantes', 'forbidden', 403);
    }
    const purpose = evidenceStoragePurpose();
    const mimeType = declared.mimeType.trim().toLowerCase();
    if (!(EVIDENCE_MIME_TYPES as readonly string[]).includes(mimeType) || !defaultEvidenceKindForMime(mimeType)) {
      throw new StorageError('El comprobante debe ser una foto, un PDF o una nota de voz', 'invalid', 415);
    }
    const expense = await prisma.expense.findUnique({
      where: { id: expenseId },
      select: { id: true, number: true, status: true, createdByUserId: true, receiptObjectIds: true, caseId: true },
    });
    if (!expense) throw new StorageError('No se encontró el gasto', 'not_found', 404);
    const allowed = canUploadReceipt(actor, expense);
    if (!allowed.ok) throw new StorageError(allowed.message, allowed.code, allowed.status);

    return {
      policy: {
        purpose,
        maxBytes: EVIDENCE_MAX_BYTES,
        allowedMimeTypes: [...EVIDENCE_MIME_TYPES],
        retentionPolicy: 'protected',
        restricted: true,
      },
      async createReference(object) {
        const result = await updateExpense(
          actor,
          { expenseId: expense.id, addReceiptObjectIds: [object.id] },
          { commandId: `expense-receipt:${object.id}` }
        );
        if (result.status === 'rejected') {
          throw new StorageError(result.message ?? 'No se pudo adjuntar el comprobante', 'invalid', 409);
        }
        const kind = defaultEvidenceKindForMime(mimeType) ?? 'document';
        try {
          await prisma.evidenceLink.create({
            data: {
              caseId: expense.caseId,
              objectType: FINANCE_OBJECT_TYPES.expense,
              objectId: expense.id,
              kind,
              storageObjectId: object.id,
              note: declared.fileName.slice(0, 200),
              createdBy: actor.id,
            },
          });
          await recordOperationalEvents([
            {
              type: FINANCE_EVENTS.expense.updated,
              actorType: 'user',
              actorId: actor.id,
              caseId: expense.caseId,
              areaKey: FINANCE_AREA_KEY,
              objectType: FINANCE_OBJECT_TYPES.expense,
              objectId: expense.id,
              payload: { expenseId: expense.id, number: expense.number, receiptObjectId: object.id, kind },
            },
          ]);
        } catch (error) {
          console.warn(
            JSON.stringify({
              component: 'finance-storage',
              event: 'receipt_link_failed',
              expenseId: expense.id,
              message: error instanceof Error ? error.message : String(error),
            })
          );
        }
        return { referenceId: expense.id };
      },
    };
  });

  registerFileAccessResolver(EVIDENCE_STORAGE_PURPOSE, (actor, object) => canReadFinanceEvidence(actor, object.id));
}

registerFinanceStorageResolvers();
