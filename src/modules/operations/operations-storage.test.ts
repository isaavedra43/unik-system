import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('./testing/fixtures');
  return {
    fake: createOpsFake(),
    purposes: ['chat', 'comm_media', 'evidence'] as string[],
    uploadResolvers: new Map<string, unknown>(),
    accessResolvers: new Map<string, unknown>(),
    notifyUser: vi.fn(async () => ({ id: 'n', inApp: true, push: false, suppressed: false })),
    publishRealtime: vi.fn(async () => ({
      id: '1',
      channel: '',
      type: '',
      payload: {},
      createdAt: '',
    })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/notifications/notification-service', () => ({ notifyUser: mocks.notifyUser }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));
vi.mock('@/modules/storage/storage-keys', () => ({ STORAGE_PURPOSES: mocks.purposes }));
vi.mock('@/modules/storage/storage-access', () => ({
  registerUploadTargetResolver: (type: string, resolver: unknown) =>
    mocks.uploadResolvers.set(type, resolver),
  registerFileAccessResolver: (purpose: string, resolver: unknown) =>
    mocks.accessResolvers.set(purpose, resolver),
}));
vi.mock('@/modules/storage/storage-service', () => ({
  StorageError: class StorageError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(message: string, code: string, status: number) {
      super(message);
      this.name = 'StorageError';
      this.code = code;
      this.status = status;
    }
  },
}));

import type { StorageObject } from '@prisma/client';
import type { FileAccessResolver, UploadTargetResolver } from '@/modules/storage/storage-access';
import { EVIDENCE_MAX_BYTES } from './evidence-service';
import { invalidateOperationsConfigCache } from './operations-config';
import { EVIDENCE_UPLOAD_TARGET, registerOperationsStorageResolvers } from './operations-storage';
import { seedUser } from './testing/fixtures';

const { fake } = mocks;
type SessionUser = ReturnType<typeof seedUser>['currentUser'];
let users: Record<'owner' | 'stranger' | 'viewer', SessionUser>;

const uploadResolver = () =>
  mocks.uploadResolvers.get(EVIDENCE_UPLOAD_TARGET) as UploadTargetResolver;
const accessResolver = () => mocks.accessResolvers.get('evidence') as FileAccessResolver;
const declared = (mimeType: string) => ({ fileName: 'archivo', mimeType, sizeBytes: 2048 });

function seedStorage(id: string, overrides: Record<string, unknown> = {}): StorageObject {
  return fake.seed('storageObject', {
    id,
    provider: 'disk',
    bucketAlias: 'files',
    objectKey: `evidence/${id}/v1`,
    versionId: 'v1',
    originalName: 'foto.jpg',
    declaredMimeType: 'image/jpeg',
    detectedMimeType: null,
    sizeBytes: BigInt(2048),
    status: 'initiated',
    createdBy: 'owner',
    purpose: 'evidence',
    deletedAt: null,
    ...overrides,
  }) as StorageObject;
}

beforeEach(() => {
  fake.tables.clear();
  vi.clearAllMocks();
  invalidateOperationsConfigCache();
  if (!mocks.purposes.includes('evidence')) mocks.purposes.push('evidence');
  users = {
    owner: seedUser(fake, { id: 'owner' }).currentUser,
    stranger: seedUser(fake, { id: 'stranger' }).currentUser,
    viewer: seedUser(fake, { id: 'viewer', permissions: ['operations.view'] }).currentUser,
  };
  fake.seed('workItem', {
    id: 'wi1',
    areaKey: 'logistica',
    kind: 'action',
    title: 'Entregar pedido',
    ownerUserId: 'owner',
    dueAt: new Date('2026-09-15T18:00:00.000Z'),
    objectType: 'delivery_order',
    objectId: 'do1',
  });
});

describe('operations storage resolvers', () => {
  it('registers the evidence upload target and access resolver once', () => {
    registerOperationsStorageResolvers();
    expect([...mocks.uploadResolvers.keys()]).toEqual([EVIDENCE_UPLOAD_TARGET]);
    expect([...mocks.accessResolvers.keys()]).toEqual(['evidence']);
  });

  it('authorizes the upload before it starts and links the file as evidence', async () => {
    const resolution = await uploadResolver()(users.owner, 'work_item:wi1', declared('image/jpeg'));
    expect(resolution.policy).toMatchObject({
      purpose: 'evidence',
      maxBytes: EVIDENCE_MAX_BYTES,
      restricted: true,
    });
    expect(resolution.policy.allowedMimeTypes).toEqual(
      expect.arrayContaining(['image/jpeg', 'application/pdf', 'audio/webm'])
    );

    const object = seedStorage('obj1');
    const { referenceId } = await resolution.createReference!(object);
    const [link] = fake.rows('evidenceLink');
    expect(link).toMatchObject({
      id: referenceId,
      workItemId: 'wi1',
      objectType: 'delivery_order',
      objectId: 'do1',
      kind: 'photo',
      storageObjectId: 'obj1',
      createdBy: 'owner',
    });
    // Replaying the same upload never creates a second link.
    expect(await resolution.createReference!(object)).toEqual({ referenceId });
    expect(fake.rows('evidenceLink')).toHaveLength(1);
  });

  it('uses the kind in the target id when present', async () => {
    const resolution = await uploadResolver()(
      users.owner,
      'work_item:wi1#signature',
      declared('image/png')
    );
    const object = seedStorage('sig', { declaredMimeType: 'image/png' });
    await resolution.createReference!(object);
    expect(fake.rows('evidenceLink')[0]).toMatchObject({ kind: 'signature' });
  });

  it('rejects invalid targets, types, outsiders and a storage without the purpose', async () => {
    const cases: Array<[SessionUser, string, string, { code: string; status: number }]> = [
      [users.owner, 'sin-formato', 'image/jpeg', { code: 'invalid', status: 400 }],
      [users.owner, 'work_item:wi1#signature', 'application/pdf', { code: 'invalid', status: 415 }],
      [users.owner, 'work_item:wi1', 'text/plain', { code: 'invalid', status: 415 }],
      [users.owner, 'work_item:nope', 'image/jpeg', { code: 'not_found', status: 404 }],
      [users.stranger, 'work_item:wi1', 'image/jpeg', { code: 'forbidden', status: 403 }],
    ];
    for (const [actor, target, mime, expected] of cases) {
      await expect(uploadResolver()(actor, target, declared(mime))).rejects.toMatchObject(expected);
    }

    mocks.purposes.splice(mocks.purposes.indexOf('evidence'), 1);
    await expect(
      uploadResolver()(users.owner, 'work_item:wi1', declared('image/jpeg'))
    ).rejects.toMatchObject({ code: 'state', status: 503 });
  });

  it('turns a rejected link into a storage error', async () => {
    const resolution = await uploadResolver()(users.owner, 'work_item:wi1', declared('image/jpeg'));
    const chatObject = seedStorage('chat1', { purpose: 'chat' });
    await expect(resolution.createReference!(chatObject)).rejects.toMatchObject({
      code: 'invalid',
      status: 422,
    });
    expect(fake.rows('evidenceLink')).toHaveLength(0);
  });

  it('lets viewers, uploaders and participants read evidence files', async () => {
    const object = seedStorage('obj2', { createdBy: 'someone' });
    fake.seed('evidenceLink', {
      workItemId: 'wi1',
      objectType: 'delivery_order',
      objectId: 'do1',
      kind: 'photo',
      storageObjectId: 'obj2',
      createdBy: 'someone',
    });
    expect(await accessResolver()(users.viewer, object)).toBe(true);
    expect(await accessResolver()(users.owner, object)).toBe(true);
    expect(await accessResolver()(users.stranger, object)).toBe(false);
    expect(await accessResolver()(users.stranger, { ...object, createdBy: 'stranger' })).toBe(true);
  });
});
