import { prisma } from '@/lib/prisma';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { recordOperationalEvents } from '@/modules/operations/events-service';
import { registerFileAccessResolver, registerUploadTargetResolver } from '@/modules/storage/storage-access';
import type { StorageObjectRecord } from '@/modules/storage/storage-repository';
import { StorageError } from '@/modules/storage/storage-service';
import { PURCHASES_OBJECT_TYPES, RECEIPT_EVIDENCE_UPLOAD_TARGET, SOURCING_EVIDENCE_PURPOSE } from './purchases-types';

/**
 * Storage integration of Compras.
 *
 * - Access to `sourcing_evidence` (raw search results and fetched catalog
 *   pages): `purchases.view` or `purchases.sourcing`, and the object must
 *   belong to a Sourcing Lab search. While storage does not register that
 *   purpose the evidence lives under `evidence` with `metadata.kind =
 *   'sourcing_evidence'`, so the same rule is registered there too (resolvers
 *   accumulate per purpose and never widen the others).
 * - Access to receipt and direct delivery evidence (`evidence`): referenced by
 *   an `EvidenceLink` of a procurement order or by a `GoodsReceipt`.
 * - Access to the order PDFs (`document`) referenced by `ProcurementOrder.evidenceObjectIds`.
 * - Upload target `purchase_receipt_evidence` (id = procurement order): photos or
 *   PDF of a receipt / direct delivery, 15 MB, `purchases.receive`.
 */

export const RECEIPT_EVIDENCE_MAX_BYTES = 15 * 1024 * 1024;
export const RECEIPT_EVIDENCE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'] as const;

function metadataOf(object: StorageObjectRecord): Record<string, unknown> {
  const value = object.metadata;
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function canViewPurchases(actor: CurrentUser): boolean {
  return hasPermission(actor, 'purchases.view') || hasPermission(actor, 'purchases.sourcing');
}

export async function canReadSourcingEvidence(actor: CurrentUser, object: StorageObjectRecord): Promise<boolean> {
  const metadata = metadataOf(object);
  if (metadata.module !== 'purchases' || metadata.kind !== SOURCING_EVIDENCE_PURPOSE) return false;
  if (!canViewPurchases(actor)) return false;
  const searchId = typeof metadata.searchId === 'string' ? metadata.searchId : null;
  if (!searchId) return false;
  const search = await prisma.sourcingSearch.findUnique({ where: { id: searchId }, select: { id: true } });
  return Boolean(search);
}

export async function canReadReceiptEvidence(actor: CurrentUser, object: StorageObjectRecord): Promise<boolean> {
  if (!hasPermission(actor, 'purchases.view') && !hasPermission(actor, 'purchases.receive')) return false;
  const link = await prisma.evidenceLink.findFirst({
    where: { objectType: PURCHASES_OBJECT_TYPES.order, storageObjectId: object.id },
    select: { id: true },
  });
  if (link) return true;
  const receipt = await prisma.goodsReceipt.findFirst({ where: { evidenceObjectIds: { has: object.id } }, select: { id: true } });
  return Boolean(receipt);
}

export async function canReadOrderDocument(actor: CurrentUser, object: StorageObjectRecord): Promise<boolean> {
  if (!hasPermission(actor, 'purchases.view')) return false;
  const order = await prisma.procurementOrder.findFirst({ where: { evidenceObjectIds: { has: object.id } }, select: { id: true } });
  return Boolean(order);
}

type GlobalWithPurchasesStorage = typeof globalThis & { __unikPurchasesStorageRegistered?: boolean };

export function registerPurchasesStorageResolvers(): void {
  const scope = globalThis as GlobalWithPurchasesStorage;
  if (scope.__unikPurchasesStorageRegistered) return;
  scope.__unikPurchasesStorageRegistered = true;

  registerFileAccessResolver(SOURCING_EVIDENCE_PURPOSE, canReadSourcingEvidence);
  registerFileAccessResolver('evidence', async (actor, object) => {
    if (metadataOf(object).kind === SOURCING_EVIDENCE_PURPOSE) return canReadSourcingEvidence(actor, object);
    return canReadReceiptEvidence(actor, object);
  });
  registerFileAccessResolver('document', canReadOrderDocument);

  registerUploadTargetResolver(RECEIPT_EVIDENCE_UPLOAD_TARGET, async (actor, targetId, declared) => {
    if (!hasPermission(actor, 'purchases.receive')) {
      throw new StorageError('Sin permiso para subir evidencias de recepción', 'forbidden', 403);
    }
    const order = await prisma.procurementOrder.findUnique({
      where: { id: targetId.trim() },
      select: { id: true, number: true, status: true, directDeliveryCaseId: true },
    });
    if (!order) throw new StorageError('Orden de compra no encontrada', 'not_found', 404);
    if (order.status === 'cancelled' || order.status === 'closed') {
      throw new StorageError('La orden de compra está cerrada', 'invalid', 409);
    }
    const kind = declared.mimeType.trim().toLowerCase() === 'application/pdf' ? 'document' : 'photo';
    return {
      policy: {
        purpose: 'evidence',
        maxBytes: RECEIPT_EVIDENCE_MAX_BYTES,
        allowedMimeTypes: [...RECEIPT_EVIDENCE_MIME_TYPES],
        retentionPolicy: 'protected',
        restricted: true,
      },
      async createReference(object) {
        const link = await prisma.evidenceLink.create({
          data: {
            caseId: order.directDeliveryCaseId,
            objectType: PURCHASES_OBJECT_TYPES.order,
            objectId: order.id,
            kind,
            storageObjectId: object.id,
            note: declared.fileName.slice(0, 200),
            createdBy: actor.id,
          },
        });
        await recordOperationalEvents([
          {
            type: 'evidence.attached',
            actorType: 'user',
            actorId: actor.id,
            caseId: order.directDeliveryCaseId,
            areaKey: 'compras',
            objectType: PURCHASES_OBJECT_TYPES.order,
            objectId: order.id,
            payload: { evidenceId: link.id, kind, storageObjectId: object.id, orderNumber: order.number },
          },
        ]).catch((error) =>
          console.warn(
            JSON.stringify({
              component: 'purchases-storage',
              event: 'evidence_event_failed',
              orderId: order.id,
              message: error instanceof Error ? error.message : String(error),
            })
          )
        );
        return { referenceId: link.id };
      },
    };
  });
}

registerPurchasesStorageResolvers();
