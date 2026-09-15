import { prisma } from '@/lib/prisma';
import {
  registerFileAccessResolver,
  registerUploadTargetResolver,
} from '@/modules/storage/storage-access';
import { STORAGE_PURPOSES, type StoragePurpose } from '@/modules/storage/storage-keys';
import { StorageError } from '@/modules/storage/storage-service';
import { httpStatusForCode, isOperationsError } from './errors';
import {
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MIME_TYPES,
  EVIDENCE_STORAGE_PURPOSE,
  attachEvidence,
  canAttachEvidence,
  canReadEvidenceObject,
  defaultEvidenceKindForMime,
  evidenceKindAcceptsMime,
  parseEvidenceTargetId,
  resolveEvidenceTarget,
  type EvidenceTarget,
} from './evidence-service';

/**
 * Storage integration of the operations core.
 *
 * - Upload target `operations_evidence`: photos, signatures, documents and
 *   voice notes of operational work (image / PDF / audio, 15 MB, restricted
 *   downloads). The target id says where the evidence goes —
 *   `work_item:<id>`, `case_step:<id>` or `<objectType>:<objectId>`, with an
 *   optional `#<kind>` (otherwise image → photo, PDF → document, audio →
 *   note). Access is checked before the upload starts; `createReference`
 *   creates the `EvidenceLink` through the `evidence.attach` command.
 * - Access resolver for purpose `evidence`: `operations.view`, the uploader,
 *   or a participant of a target that references the file.
 *
 * The purpose must exist in `STORAGE_PURPOSES` (storage-keys.ts); until it is
 * registered there, uploads fail with a clear 503 instead of writing objects
 * under an unknown key prefix.
 */

export const EVIDENCE_UPLOAD_TARGET = 'operations_evidence';

type StorageErrorCode = ConstructorParameters<typeof StorageError>[1];

/** `evidence` as a storage purpose, or a 503 when storage-keys.ts does not know it yet. */
export function evidenceStoragePurpose(): StoragePurpose {
  if (!(STORAGE_PURPOSES as readonly string[]).includes(EVIDENCE_STORAGE_PURPOSE)) {
    throw new StorageError('El almacenamiento de evidencias aún no está habilitado', 'state', 503);
  }
  return EVIDENCE_STORAGE_PURPOSE as StoragePurpose;
}

function storageCodeFor(code: string | undefined): StorageErrorCode {
  switch (code) {
    case 'not_found':
      return 'not_found';
    case 'forbidden':
    case 'unauthenticated':
    case 'actor_mismatch':
      return 'forbidden';
    case 'invalid_payload':
    case 'invalid_request':
      return 'invalid';
    default:
      return 'state';
  }
}

function targetFields(
  target: EvidenceTarget
): { workItemId: string } | { stepId: string } | { objectType: string; objectId: string } {
  if ('workItemId' in target) return { workItemId: target.workItemId };
  if ('stepId' in target) return { stepId: target.stepId };
  return { objectType: target.objectType, objectId: target.objectId };
}

let registered = false;

export function registerOperationsStorageResolvers(): void {
  if (registered) return;
  registered = true;

  registerUploadTargetResolver(EVIDENCE_UPLOAD_TARGET, async (actor, targetId, declared) => {
    const purpose = evidenceStoragePurpose();
    const parsed = parseEvidenceTargetId(targetId);
    if (!parsed) throw new StorageError('Destino de evidencia inválido', 'invalid', 400);
    const kind = parsed.kind ?? defaultEvidenceKindForMime(declared.mimeType);
    if (!kind || !evidenceKindAcceptsMime(kind, declared.mimeType)) {
      throw new StorageError('Este tipo de archivo no sirve como evidencia', 'invalid', 415);
    }

    let target;
    try {
      target = await resolveEvidenceTarget(prisma, parsed.target);
    } catch (err) {
      if (isOperationsError(err)) {
        throw new StorageError(err.message, storageCodeFor(err.code), err.httpStatus);
      }
      throw err;
    }
    if (!(await canAttachEvidence(prisma, actor, 'user', target))) {
      throw new StorageError('No puedes adjuntar evidencia a este registro', 'forbidden', 403);
    }

    return {
      policy: {
        purpose,
        maxBytes: EVIDENCE_MAX_BYTES,
        allowedMimeTypes: [...EVIDENCE_MIME_TYPES],
        restricted: true,
      },
      async createReference(object) {
        const result = await attachEvidence(
          actor,
          { ...targetFields(parsed.target), kind, storageObjectId: object.id },
          { commandId: `evidence-upload:${object.id}` }
        );
        if (result.status === 'rejected' || !result.data) {
          throw new StorageError(
            result.message ?? 'No se pudo registrar la evidencia',
            storageCodeFor(result.errorCode),
            result.errorCode ? httpStatusForCode(result.errorCode) : 409
          );
        }
        return { referenceId: result.data.evidenceId };
      },
    };
  });

  registerFileAccessResolver(EVIDENCE_STORAGE_PURPOSE, (actor, object) =>
    canReadEvidenceObject(actor, object)
  );
}

registerOperationsStorageResolvers();
