import { prisma } from '@/lib/prisma';
import { isActiveDriverOf } from './logistics-helpers';
import { hasPermission, type CurrentUser } from '@/modules/auth/authorization';
import { recordOperationalEvents } from '@/modules/operations/events-service';
import {
  registerFileAccessResolver,
  registerUploadTargetResolver,
} from '@/modules/storage/storage-access';
import { STORAGE_PURPOSES, type StoragePurpose } from '@/modules/storage/storage-keys';
import { StorageError } from '@/modules/storage/storage-service';
import {
  DELIVERY_EVIDENCE_MAX_BYTES,
  DELIVERY_EVIDENCE_MIME_TYPES,
  DELIVERY_EVIDENCE_STORAGE_PURPOSE,
  DELIVERY_EVIDENCE_UPLOAD_TARGET,
  LOGISTICS_EVENTS,
  LOGISTICS_OBJECT_TYPES,
} from './types';

/**
 * Storage integration of logistics (plan section 4.4).
 *
 * - Upload target `delivery_evidence` (purpose `evidence`, 15 MB, image/PDF,
 *   protected retention, stream-only downloads). The target id is the delivery
 *   order id, optionally with the kind: `{deliveryOrderId}` (photo; PDF counts
 *   as a signed receipt) or `{deliveryOrderId}:signature`. `createReference`
 *   writes `DeliveryEvidence` + `EvidenceLink` when the upload starts; a
 *   delivery only counts it once the bytes reached storage (`validating` or
 *   `ready`, see delivery-rules.ts).
 * - Access resolver for purpose `evidence` authorizing only through
 *   `DeliveryEvidence` references. Resolvers accumulate per purpose, so this
 *   one coexists with any other module that also stores `evidence` objects
 *   (e.g. an EvidenceLink-based resolver of the operations core) without
 *   duplicating its logic.
 *
 * Client: `uploadFile(file, { target: { type: 'delivery_evidence', id } })`.
 */

type EvidenceUploadKind = 'photo' | 'signature';

export function parseEvidenceTarget(
  targetId: string
): { deliveryOrderId: string; kind: EvidenceUploadKind | null } | null {
  const parts = targetId.trim().split(':');
  if (parts.length > 2 || !parts[0]) return null;
  const kind = parts[1];
  if (kind !== undefined && kind !== 'photo' && kind !== 'signature') return null;
  return { deliveryOrderId: parts[0], kind: (kind as EvidenceUploadKind | undefined) ?? null };
}

/** Declared kind wins; otherwise images are photos and a PDF is a signed delivery receipt. */
export function evidenceKindForUpload(
  mimeType: string,
  declared: EvidenceUploadKind | null
): EvidenceUploadKind {
  if (declared) return declared;
  return mimeType.trim().toLowerCase() === 'application/pdf' ? 'signature' : 'photo';
}

/** The `evidence` purpose must exist in storage-keys.ts before objects can be stored under it. */
export function isEvidencePurposeAvailable(
  purposes: readonly string[] = STORAGE_PURPOSES
): boolean {
  return purposes.includes(DELIVERY_EVIDENCE_STORAGE_PURPOSE);
}

interface OrderAccessRef {
  driverId: string | null;
}

function isAssignedDriver(actor: CurrentUser, order: OrderAccessRef): Promise<boolean> {
  return isActiveDriverOf(prisma, actor, order.driverId);
}

export async function canUploadDeliveryEvidence(
  actor: CurrentUser,
  order: OrderAccessRef
): Promise<boolean> {
  if (hasPermission(actor, 'logistics.dispatch')) return true;
  return isAssignedDriver(actor, order);
}

export async function canViewDeliveryEvidence(
  actor: CurrentUser,
  order: OrderAccessRef
): Promise<boolean> {
  if (
    hasPermission(actor, 'logistics.view') ||
    hasPermission(actor, 'logistics.dispatch') ||
    hasPermission(actor, 'operations.view')
  ) {
    return true;
  }
  return isAssignedDriver(actor, order);
}

type GlobalWithLogisticsStorage = typeof globalThis & {
  __unikLogisticsStorageRegistered?: boolean;
};

export function registerLogisticsStorageResolvers(): void {
  const scope = globalThis as GlobalWithLogisticsStorage;
  if (scope.__unikLogisticsStorageRegistered) return;
  scope.__unikLogisticsStorageRegistered = true;

  registerUploadTargetResolver(
    DELIVERY_EVIDENCE_UPLOAD_TARGET,
    async (actor, targetId, declared) => {
      const target = parseEvidenceTarget(targetId);
      if (!target) throw new StorageError('Destino de evidencia inválido', 'invalid', 400);
      if (!hasPermission(actor, 'logistics.drive') && !hasPermission(actor, 'logistics.dispatch')) {
        throw new StorageError('Sin permiso para subir evidencias de entrega', 'forbidden', 403);
      }
      if (!isEvidencePurposeAvailable()) {
        throw new StorageError(
          'El almacenamiento aún no admite evidencias de entrega; avisa al administrador',
          'invalid',
          503
        );
      }
      const order = await prisma.deliveryOrder.findUnique({
        where: { id: target.deliveryOrderId },
        select: { id: true, caseId: true, status: true, driverId: true },
      });
      if (!order) throw new StorageError('Entrega no encontrada', 'not_found', 404);
      if (!(await canUploadDeliveryEvidence(actor, order))) {
        throw new StorageError(
          'Sólo el chofer asignado o despacho pueden subir evidencias',
          'forbidden',
          403
        );
      }
      if (order.status === 'cancelled') {
        throw new StorageError('La entrega está cancelada', 'invalid', 409);
      }
      const kind = evidenceKindForUpload(declared.mimeType, target.kind);
      return {
        policy: {
          purpose: DELIVERY_EVIDENCE_STORAGE_PURPOSE as StoragePurpose,
          maxBytes: DELIVERY_EVIDENCE_MAX_BYTES,
          allowedMimeTypes: [...DELIVERY_EVIDENCE_MIME_TYPES],
          retentionPolicy: 'protected',
          restricted: true,
        },
        async createReference(object) {
          const evidence = await prisma.$transaction(async (tx) => {
            const created = await tx.deliveryEvidence.create({
              data: {
                deliveryOrderId: order.id,
                kind,
                storageObjectId: object.id,
                createdBy: actor.id,
              },
            });
            await tx.evidenceLink.create({
              data: {
                caseId: order.caseId,
                objectType: LOGISTICS_OBJECT_TYPES.deliveryOrder,
                objectId: order.id,
                kind,
                storageObjectId: object.id,
                note: declared.fileName.slice(0, 200),
                createdBy: actor.id,
              },
            });
            return created;
          });
          try {
            await recordOperationalEvents([
              {
                type: LOGISTICS_EVENTS.delivery.evidenceAdded,
                actorType: 'user',
                actorId: actor.id,
                caseId: order.caseId,
                areaKey: 'logistica',
                objectType: LOGISTICS_OBJECT_TYPES.deliveryOrder,
                objectId: order.id,
                payload: { deliveryEvidenceId: evidence.id, kind, storageObjectId: object.id },
              },
            ]);
          } catch (error) {
            console.warn(
              JSON.stringify({
                component: 'logistics-storage',
                event: 'evidence_event_failed',
                deliveryOrderId: order.id,
                message: error instanceof Error ? error.message : String(error),
              })
            );
          }
          return { referenceId: evidence.id };
        },
      };
    }
  );

  registerFileAccessResolver(DELIVERY_EVIDENCE_STORAGE_PURPOSE, async (actor, object) => {
    const refs = await prisma.deliveryEvidence.findMany({
      where: { storageObjectId: object.id },
      select: { deliveryOrderId: true },
      take: 10,
    });
    if (refs.length === 0) return false;
    if (
      object.createdBy === actor.id &&
      (hasPermission(actor, 'logistics.drive') || hasPermission(actor, 'logistics.dispatch'))
    ) {
      return true;
    }
    const orders = await prisma.deliveryOrder.findMany({
      where: { id: { in: [...new Set(refs.map((r) => r.deliveryOrderId))] } },
      select: { driverId: true },
    });
    for (const order of orders) {
      if (await canViewDeliveryEvidence(actor, order)) return true;
    }
    return false;
  });
}

registerLogisticsStorageResolvers();
