import { Prisma, type StorageObject, type UploadSession } from '@prisma/client';
import { prisma } from '@/lib/prisma';

/**
 * Data access for StorageObject / UploadSession. The service depends on this
 * interface so the upload/validation flows can be exercised in unit tests
 * with the in-memory implementation and the disk driver (local emulator).
 */

export type StorageObjectRecord = StorageObject;
export type UploadSessionRecord = UploadSession;

export interface StorageObjectCreate {
  id?: string;
  provider: string;
  bucketAlias: string;
  objectKey: string;
  versionId: string;
  parentObjectId?: string | null;
  originalName: string;
  declaredMimeType: string;
  detectedMimeType?: string | null;
  sizeBytes: bigint;
  sha256?: string | null;
  status: string;
  createdBy?: string | null;
  purpose: string;
  retentionPolicy?: string;
  metadata?: Record<string, unknown> | null;
  legacyPath?: string | null;
  expiresAt?: Date | null;
}

export interface UploadSessionCreate {
  objectId: string;
  userId: string;
  targetType: string;
  targetId: string;
  declaredSize: bigint;
  partSize: number;
  partCount: number;
  multipart: boolean;
  providerUploadId?: string | null;
  quarantineKey: string;
  expiresAt: Date;
}

export interface ReferenceCounts {
  aiAttachments: number;
  aiArtifacts: number;
  chatAttachments: number;
  total: number;
}

export interface StorageRepository {
  createObject(data: StorageObjectCreate): Promise<StorageObjectRecord>;
  getObject(id: string): Promise<StorageObjectRecord | null>;
  updateObject(
    id: string,
    data: Partial<Omit<StorageObjectCreate, 'id'>> & {
      deletedAt?: Date | null;
      rejectionReason?: string | null;
    }
  ): Promise<StorageObjectRecord>;
  createSession(data: UploadSessionCreate): Promise<UploadSessionRecord>;
  getSession(id: string): Promise<(UploadSessionRecord & { object: StorageObjectRecord }) | null>;
  getSessionByObject(objectId: string): Promise<UploadSessionRecord | null>;
  updateSession(
    id: string,
    data: Partial<Pick<UploadSessionRecord, 'status' | 'providerUploadId' | 'completedAt'>> & {
      parts?: unknown;
    }
  ): Promise<UploadSessionRecord>;
  sumBytesSince(since: Date, userId?: string): Promise<bigint>;
  countReferences(objectId: string): Promise<ReferenceCounts>;
  listExpiredSessions(
    before: Date,
    limit: number
  ): Promise<Array<UploadSessionRecord & { object: StorageObjectRecord }>>;
  listExpiredObjects(before: Date, limit: number): Promise<StorageObjectRecord[]>;
}

function toJson(
  value: Record<string, unknown> | null | undefined
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

export class PrismaStorageRepository implements StorageRepository {
  async createObject(data: StorageObjectCreate): Promise<StorageObjectRecord> {
    return prisma.storageObject.create({
      data: {
        id: data.id,
        provider: data.provider,
        bucketAlias: data.bucketAlias,
        objectKey: data.objectKey,
        versionId: data.versionId,
        parentObjectId: data.parentObjectId ?? null,
        originalName: data.originalName,
        declaredMimeType: data.declaredMimeType,
        detectedMimeType: data.detectedMimeType ?? null,
        sizeBytes: data.sizeBytes,
        sha256: data.sha256 ?? null,
        status: data.status,
        createdBy: data.createdBy ?? null,
        purpose: data.purpose,
        retentionPolicy: data.retentionPolicy ?? 'default',
        metadata: toJson(data.metadata),
        legacyPath: data.legacyPath ?? null,
        expiresAt: data.expiresAt ?? null,
      },
    });
  }

  getObject(id: string) {
    return prisma.storageObject.findUnique({ where: { id } });
  }

  updateObject(
    id: string,
    data: Partial<Omit<StorageObjectCreate, 'id'>> & {
      deletedAt?: Date | null;
      rejectionReason?: string | null;
    }
  ) {
    const { metadata, ...rest } = data;
    return prisma.storageObject.update({
      where: { id },
      data: { ...rest, metadata: toJson(metadata) },
    });
  }

  createSession(data: UploadSessionCreate) {
    return prisma.uploadSession.create({
      data: { ...data, providerUploadId: data.providerUploadId ?? null },
    });
  }

  getSession(id: string) {
    return prisma.uploadSession.findUnique({ where: { id }, include: { object: true } });
  }

  getSessionByObject(objectId: string) {
    return prisma.uploadSession.findUnique({ where: { objectId } });
  }

  updateSession(
    id: string,
    data: Partial<Pick<UploadSessionRecord, 'status' | 'providerUploadId' | 'completedAt'>> & {
      parts?: unknown;
    }
  ) {
    const { parts, ...rest } = data;
    return prisma.uploadSession.update({
      where: { id },
      data: { ...rest, ...(parts !== undefined ? { parts: parts as Prisma.InputJsonValue } : {}) },
    });
  }

  async sumBytesSince(since: Date, userId?: string): Promise<bigint> {
    const res = await prisma.storageObject.aggregate({
      _sum: { sizeBytes: true },
      where: {
        createdAt: { gte: since },
        status: { notIn: ['aborted', 'rejected', 'deleted'] },
        ...(userId ? { createdBy: userId } : {}),
      },
    });
    return res._sum.sizeBytes ?? BigInt(0);
  }

  async countReferences(objectId: string): Promise<ReferenceCounts> {
    const [aiAttachments, aiArtifacts, chatAttachments] = await Promise.all([
      prisma.aiAttachment.count({ where: { storageObjectId: objectId } }),
      prisma.aiArtifact.count({ where: { storageObjectId: objectId } }),
      prisma.internalChatAttachment.count({ where: { storageObjectId: objectId } }),
    ]);
    return {
      aiAttachments,
      aiArtifacts,
      chatAttachments,
      total: aiAttachments + aiArtifacts + chatAttachments,
    };
  }

  listExpiredSessions(before: Date, limit: number) {
    return prisma.uploadSession.findMany({
      where: {
        status: { in: ['initiated', 'uploading', 'completing'] },
        expiresAt: { lt: before },
      },
      include: { object: true },
      take: limit,
      orderBy: { expiresAt: 'asc' },
    });
  }

  listExpiredObjects(before: Date, limit: number) {
    return prisma.storageObject.findMany({
      where: {
        expiresAt: { lt: before },
        deletedAt: null,
        status: { in: ['ready', 'missing'] },
        retentionPolicy: 'default',
      },
      take: limit,
      orderBy: { expiresAt: 'asc' },
    });
  }
}

/** In-memory repository for tests and the local upload emulator. */
export class MemoryStorageRepository implements StorageRepository {
  objects = new Map<string, StorageObjectRecord>();
  sessions = new Map<string, UploadSessionRecord>();
  references = new Map<string, ReferenceCounts>();
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq++;
    return `${prefix}_${this.seq.toString(36).padStart(6, '0')}`;
  }

  async createObject(data: StorageObjectCreate): Promise<StorageObjectRecord> {
    const now = new Date();
    const record: StorageObjectRecord = {
      id: data.id ?? this.nextId('obj'),
      provider: data.provider,
      bucketAlias: data.bucketAlias,
      objectKey: data.objectKey,
      versionId: data.versionId,
      parentObjectId: data.parentObjectId ?? null,
      originalName: data.originalName,
      declaredMimeType: data.declaredMimeType,
      detectedMimeType: data.detectedMimeType ?? null,
      sizeBytes: data.sizeBytes,
      sha256: data.sha256 ?? null,
      status: data.status,
      rejectionReason: null,
      createdBy: data.createdBy ?? null,
      purpose: data.purpose,
      retentionPolicy: data.retentionPolicy ?? 'default',
      metadata: (data.metadata ?? null) as Prisma.JsonValue,
      legacyPath: data.legacyPath ?? null,
      expiresAt: data.expiresAt ?? null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.objects.set(record.id, record);
    return record;
  }

  async getObject(id: string) {
    return this.objects.get(id) ?? null;
  }

  async updateObject(
    id: string,
    data: Partial<Omit<StorageObjectCreate, 'id'>> & {
      deletedAt?: Date | null;
      rejectionReason?: string | null;
    }
  ) {
    const existing = this.objects.get(id);
    if (!existing) throw new Error('Object not found');
    const updated: StorageObjectRecord = {
      ...existing,
      ...(data as Partial<StorageObjectRecord>),
      metadata:
        data.metadata === undefined ? existing.metadata : (data.metadata as Prisma.JsonValue),
      updatedAt: new Date(),
    };
    this.objects.set(id, updated);
    return updated;
  }

  async createSession(data: UploadSessionCreate) {
    const now = new Date();
    const record: UploadSessionRecord = {
      id: this.nextId('up'),
      objectId: data.objectId,
      userId: data.userId,
      targetType: data.targetType,
      targetId: data.targetId,
      declaredSize: data.declaredSize,
      partSize: data.partSize,
      partCount: data.partCount,
      multipart: data.multipart,
      providerUploadId: data.providerUploadId ?? null,
      quarantineKey: data.quarantineKey,
      parts: null,
      status: 'initiated',
      expiresAt: data.expiresAt,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(record.id, record);
    return record;
  }

  async getSession(id: string) {
    const session = this.sessions.get(id);
    if (!session) return null;
    const object = this.objects.get(session.objectId);
    if (!object) return null;
    return { ...session, object };
  }

  async getSessionByObject(objectId: string) {
    for (const s of this.sessions.values()) if (s.objectId === objectId) return s;
    return null;
  }

  async updateSession(
    id: string,
    data: Partial<Pick<UploadSessionRecord, 'status' | 'providerUploadId' | 'completedAt'>> & {
      parts?: unknown;
    }
  ) {
    const existing = this.sessions.get(id);
    if (!existing) throw new Error('Session not found');
    const updated: UploadSessionRecord = {
      ...existing,
      ...(data as Partial<UploadSessionRecord>),
      parts: data.parts === undefined ? existing.parts : (data.parts as Prisma.JsonValue),
      updatedAt: new Date(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  async sumBytesSince(since: Date, userId?: string): Promise<bigint> {
    let total = BigInt(0);
    for (const o of this.objects.values()) {
      if (o.createdAt < since) continue;
      if (['aborted', 'rejected', 'deleted'].includes(o.status)) continue;
      if (userId && o.createdBy !== userId) continue;
      total += o.sizeBytes;
    }
    return total;
  }

  async countReferences(objectId: string): Promise<ReferenceCounts> {
    return (
      this.references.get(objectId) ?? {
        aiAttachments: 0,
        aiArtifacts: 0,
        chatAttachments: 0,
        total: 0,
      }
    );
  }

  async listExpiredSessions(before: Date, limit: number) {
    const out: Array<UploadSessionRecord & { object: StorageObjectRecord }> = [];
    for (const s of this.sessions.values()) {
      if (!['initiated', 'uploading', 'completing'].includes(s.status)) continue;
      if (s.expiresAt >= before) continue;
      const object = this.objects.get(s.objectId);
      if (object) out.push({ ...s, object });
      if (out.length >= limit) break;
    }
    return out;
  }

  async listExpiredObjects(before: Date, limit: number) {
    const out: StorageObjectRecord[] = [];
    for (const o of this.objects.values()) {
      if (!o.expiresAt || o.expiresAt >= before || o.deletedAt) continue;
      if (!['ready', 'missing'].includes(o.status) || o.retentionPolicy !== 'default') continue;
      out.push(o);
      if (out.length >= limit) break;
    }
    return out;
  }
}

let repository: StorageRepository | null = null;

export function getStorageRepository(): StorageRepository {
  repository ??= new PrismaStorageRepository();
  return repository;
}

export function setStorageRepositoryForTests(repo: StorageRepository | null): void {
  repository = repo;
}
