import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Upload target `delivery_evidence` and access resolver of purpose `evidence`. */

const mocks = await vi.hoisted(async () => {
  const { createLogisticsFake } = await import('./testing/logistics-fixtures');
  type Resolver = (...args: never[]) => Promise<unknown>;
  return {
    fake: createLogisticsFake(),
    purposes: ['chat', 'document', 'evidence'] as string[],
    uploadResolvers: new Map<string, Resolver>(),
    accessResolvers: new Map<string, Resolver>(),
    publishRealtime: vi.fn(async () => ({ id: '1' })),
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: mocks.fake.client }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: mocks.publishRealtime,
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}` },
}));
vi.mock('@/modules/storage/storage-access', () => ({
  registerUploadTargetResolver: (type: string, fn: never) => mocks.uploadResolvers.set(type, fn),
  registerFileAccessResolver: (purpose: string, fn: never) =>
    mocks.accessResolvers.set(purpose, fn),
}));
vi.mock('@/modules/storage/storage-keys', () => ({ STORAGE_PURPOSES: mocks.purposes }));
vi.mock('@/modules/storage/storage-service', () => {
  class StorageError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly status: number
    ) {
      super(message);
      this.name = 'StorageError';
    }
  }
  return { StorageError };
});

import type { CurrentUser } from '@/modules/auth/authorization';
import { makeCurrentUser } from '@/modules/operations/testing/fixtures';
import type { UploadTargetResolution } from '@/modules/storage/storage-access';
import {
  evidenceKindForUpload,
  isEvidencePurposeAvailable,
  parseEvidenceTarget,
} from './logistics-storage';
import { isActiveDriverOf } from './logistics-helpers';
import { seedFleet, seedLogisticsBase } from './testing/logistics-fixtures';

const { fake } = mocks;
const declared = { fileName: 'entrega.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 };

type UploadResolver = (
  actor: CurrentUser,
  targetId: string,
  input: typeof declared
) => Promise<UploadTargetResolution>;
type AccessResolver = (
  actor: CurrentUser,
  object: { id: string; createdBy: string | null }
) => Promise<boolean>;

const upload = () => mocks.uploadResolvers.get('delivery_evidence') as unknown as UploadResolver;
const access = () => mocks.accessResolvers.get('evidence') as unknown as AccessResolver;

beforeEach(() => {
  fake.tables.clear();
  if (!mocks.purposes.includes('evidence')) mocks.purposes.push('evidence');
  seedLogisticsBase(fake);
  seedFleet(fake);
  fake.seed('deliveryOrder', {
    id: 'do_1',
    caseId: 'case_1',
    allocationIds: ['alloc_1'],
    mode: 'own_fleet',
    status: 'dispatched',
    driverId: 'drv_1',
  });
});

describe('pure helpers', () => {
  it('parses the upload target id and the evidence kind', () => {
    expect(parseEvidenceTarget('do_1')).toEqual({ deliveryOrderId: 'do_1', kind: null });
    expect(parseEvidenceTarget('do_1:signature')).toEqual({
      deliveryOrderId: 'do_1',
      kind: 'signature',
    });
    expect(parseEvidenceTarget('do_1:selfie')).toBeNull();
    expect(parseEvidenceTarget('a:b:c')).toBeNull();
    expect(evidenceKindForUpload('image/png', null)).toBe('photo');
    expect(evidenceKindForUpload('application/pdf', null)).toBe('signature');
    expect(evidenceKindForUpload('image/png', 'signature')).toBe('signature');
    expect(isEvidencePurposeAvailable(['chat'])).toBe(false);
  });
});

describe('delivery_evidence upload target', () => {
  it('lets the assigned driver upload and records DeliveryEvidence + EvidenceLink', async () => {
    const driver = makeCurrentUser({ id: 'u_driver', permissionKeys: ['logistics.drive'] });
    const resolution = await upload()(driver, 'do_1', declared);
    expect(resolution.policy).toMatchObject({
      purpose: 'evidence',
      maxBytes: 15 * 1024 * 1024,
      retentionPolicy: 'protected',
      restricted: true,
    });
    const reference = await resolution.createReference!({ id: 'obj_1' } as never);
    const evidence = fake.rows('deliveryEvidence').find((e) => e.id === reference.referenceId);
    expect(evidence).toMatchObject({
      deliveryOrderId: 'do_1',
      kind: 'photo',
      storageObjectId: 'obj_1',
      createdBy: 'u_driver',
    });
    expect(fake.rows('evidenceLink')).toMatchObject([
      {
        caseId: 'case_1',
        objectType: 'delivery_order',
        objectId: 'do_1',
        kind: 'photo',
        storageObjectId: 'obj_1',
      },
    ]);
    expect(fake.rows('operationalEvent').map((e) => e.type)).toContain('delivery.evidence_added');
  });

  it('rejects other drivers, users without logistics permissions and a storage without the purpose', async () => {
    fake.seed('driver', { id: 'drv_2', name: 'Otro', userId: 'u_other' });
    const otherDriver = makeCurrentUser({ id: 'u_other', permissionKeys: ['logistics.drive'] });
    await expect(upload()(otherDriver, 'do_1', declared)).rejects.toMatchObject({ status: 403 });
    await expect(upload()(makeCurrentUser({ id: 'u_x' }), 'do_1', declared)).rejects.toMatchObject({
      status: 403,
    });

    mocks.purposes.splice(mocks.purposes.indexOf('evidence'), 1);
    const dispatcher = makeCurrentUser({
      id: 'u_dispatch',
      permissionKeys: ['logistics.dispatch'],
    });
    await expect(upload()(dispatcher, 'do_1', declared)).rejects.toMatchObject({ status: 503 });
  });
});

describe('driver rule shared by commands, files and the trip channel', () => {
  it('requires logistics.drive besides the active Driver linked to the user', async () => {
    const driver = makeCurrentUser({ id: 'u_driver', permissionKeys: ['logistics.drive'] });
    const revoked = makeCurrentUser({ id: 'u_driver', permissionKeys: [] });
    expect(await isActiveDriverOf(fake.client as never, driver, 'drv_1')).toBe(true);
    expect(await isActiveDriverOf(fake.client as never, revoked, 'drv_1')).toBe(false);
    expect(await isActiveDriverOf(fake.client as never, driver, null)).toBe(false);
    fake.rows('driver').find((d) => d.id === 'drv_1')!.active = false;
    expect(await isActiveDriverOf(fake.client as never, driver, 'drv_1')).toBe(false);
  });
});

describe('evidence access resolver', () => {
  it('authorizes through the delivery evidence references only', async () => {
    fake.seed('deliveryEvidence', {
      deliveryOrderId: 'do_1',
      kind: 'photo',
      storageObjectId: 'obj_1',
      createdBy: 'u_driver',
    });
    const object = { id: 'obj_1', createdBy: 'u_driver' };
    expect(
      await access()(makeCurrentUser({ id: 'u_view', permissionKeys: ['logistics.view'] }), object)
    ).toBe(true);
    expect(
      await access()(
        makeCurrentUser({ id: 'u_driver', permissionKeys: ['logistics.drive'] }),
        object
      )
    ).toBe(true);
    expect(await access()(makeCurrentUser({ id: 'u_sales' }), object)).toBe(false);
    expect(
      await access()(makeCurrentUser({ id: 'u_view', permissionKeys: ['logistics.view'] }), {
        id: 'obj_unknown',
        createdBy: null,
      })
    ).toBe(false);
  });
});
