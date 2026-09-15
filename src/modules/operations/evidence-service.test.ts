import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = await vi.hoisted(async () => {
  const { createOpsFake } = await import('./testing/fixtures');
  return {
    fake: createOpsFake(),
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

import type { Prisma } from '@prisma/client';
import { executeCommand } from './commands';
import {
  describeEvidenceKey,
  EVIDENCE_ATTACH_COMMAND,
  attachEvidence,
  attachEvidenceInTx,
  canReadEvidenceObject,
  defaultEvidenceKindForMime,
  evidenceKindAcceptsMime,
  formatEvidenceTargetId,
  listEvidence,
  missingEvidence,
  parseEvidenceTargetId,
  presentResultKeys,
  type AttachEvidenceInput,
} from './evidence-service';
import { invalidateOperationsConfigCache } from './operations-config';
import { seedUser } from './testing/fixtures';

const { fake } = mocks;
const NOW = new Date('2026-09-15T15:00:00.000Z');
type SessionUser = ReturnType<typeof seedUser>['currentUser'];
let users: Record<'owner' | 'backup' | 'stranger' | 'manager' | 'viewer' | 'seller', SessionUser>;

function seedStorage(id: string, overrides: Record<string, unknown> = {}) {
  return fake.seed('storageObject', {
    id,
    provider: 'disk',
    bucketAlias: 'files',
    objectKey: `evidence/${id}/v1`,
    versionId: 'v1',
    originalName: 'foto.jpg',
    declaredMimeType: 'image/jpeg',
    detectedMimeType: null,
    sizeBytes: BigInt(1024),
    status: 'ready',
    createdBy: 'owner',
    purpose: 'evidence',
    deletedAt: null,
    ...overrides,
  });
}

function seedWorkItem(overrides: Record<string, unknown> = {}) {
  return fake.seed('workItem', {
    id: 'wi1',
    areaKey: 'logistica',
    kind: 'action',
    title: 'Entregar pedido',
    ownerUserId: 'owner',
    backupUserId: 'backup',
    dueAt: new Date('2026-09-15T18:00:00.000Z'),
    caseId: 'case1',
    objectType: 'delivery_order',
    objectId: 'do1',
    createdAt: new Date('2026-09-15T10:00:00.000Z'),
    ...overrides,
  });
}

let seq = 0;
function attach(user: SessionUser, input: AttachEvidenceInput) {
  seq += 1;
  return attachEvidence(user, input, { commandId: `ev-${seq}`, now: NOW });
}

beforeEach(() => {
  fake.tables.clear();
  vi.clearAllMocks();
  invalidateOperationsConfigCache();
  users = {
    owner: seedUser(fake, { id: 'owner', name: 'Olga' }).currentUser,
    backup: seedUser(fake, { id: 'backup' }).currentUser,
    stranger: seedUser(fake, { id: 'stranger' }).currentUser,
    manager: seedUser(fake, { id: 'manager', permissions: ['operations.manage'] }).currentUser,
    viewer: seedUser(fake, { id: 'viewer', permissions: ['operations.view'] }).currentUser,
    seller: seedUser(fake, { id: 'seller' }).currentUser,
  };
  fake.seed('operationalCase', {
    id: 'case1',
    caseSeq: 1,
    caseNumber: 'EXP-000001',
    kind: 'sales_fulfillment',
    sourceType: 'sales_order',
    sourceId: 'so1',
    processVersionId: 'pv1',
    ownerUserId: 'seller',
  });
  seedWorkItem();
  seedStorage('obj1');
});

describe('evidence rules (pure)', () => {
  it('matches evidence kinds with file types', () => {
    expect(evidenceKindAcceptsMime('photo', 'image/jpeg')).toBe(true);
    expect(evidenceKindAcceptsMime('photo', 'application/pdf')).toBe(false);
    expect(evidenceKindAcceptsMime('signature', 'image/svg+xml')).toBe(false);
    expect(evidenceKindAcceptsMime('document', 'application/pdf')).toBe(true);
    expect(evidenceKindAcceptsMime('document', 'image/png')).toBe(true);
    expect(evidenceKindAcceptsMime('note', 'audio/webm;codecs=opus')).toBe(true);
    expect(evidenceKindAcceptsMime('count', 'application/pdf')).toBe(true);
    expect(defaultEvidenceKindForMime('image/png')).toBe('photo');
    expect(defaultEvidenceKindForMime('application/pdf')).toBe('document');
    expect(defaultEvidenceKindForMime('audio/ogg')).toBe('note');
    expect(defaultEvidenceKindForMime('text/plain')).toBeNull();
  });

  it('describes every required evidence key in Spanish (the 422 message of the core too)', () => {
    expect(describeEvidenceKey('signature')).toBe('Firma');
    expect(describeEvidenceKey('availability_result')).toBe('Resultado de disponibilidad');
    expect(describeEvidenceKey('allocation_plan')).toBe('Plan de abastecimiento');
    expect(describeEvidenceKey('issue_movements')).toBe('Salida del material');
    expect(describeEvidenceKey('custom_key')).toBe('custom key');
  });

  it('requires links for file kinds and accepts structured keys for the rest', () => {
    expect(
      missingEvidence(['photo', 'signature', 'delivery_order', 'note', 'count', ' ', 'photo'], {
        kinds: ['photo'],
        keys: ['delivery_order', 'count', 'signature'],
      })
    ).toEqual(['signature', 'note']);
    expect(missingEvidence([], { kinds: [], keys: [] })).toEqual([]);
    expect(presentResultKeys({ a: 'x', b: ' ', c: null, d: [], e: 0, f: false })).toEqual([
      'a',
      'e',
      'f',
    ]);
  });

  it('parses and formats upload target ids', () => {
    expect(parseEvidenceTargetId('work_item:wi1')).toEqual({
      target: { workItemId: 'wi1' },
      kind: null,
    });
    expect(parseEvidenceTargetId('case_step:st1#signature')).toEqual({
      target: { stepId: 'st1' },
      kind: 'signature',
    });
    expect(parseEvidenceTargetId('delivery_order:so:123#photo')).toEqual({
      target: { objectType: 'delivery_order', objectId: 'so:123' },
      kind: 'photo',
    });
    for (const invalid of ['', 'nocolon', 'Bad-Type:1', 'work_item:wi1#selfie', 'work_item:']) {
      expect(parseEvidenceTargetId(invalid)).toBeNull();
    }
    expect(formatEvidenceTargetId({ stepId: 'st1' }, 'photo')).toBe('case_step:st1#photo');
    expect(formatEvidenceTargetId({ objectType: 'goods_receipt', objectId: 'gr1' })).toBe(
      'goods_receipt:gr1'
    );
  });
});

describe('evidence.attach', () => {
  it('lets the owner attach a photo to a work item, inheriting its case and object', async () => {
    const result = await attach(users.owner, {
      workItemId: 'wi1',
      kind: 'photo',
      storageObjectId: 'obj1',
    });
    expect(result).toMatchObject({ status: 'completed', data: { created: true } });
    const [link] = fake.rows('evidenceLink');
    expect(link).toMatchObject({
      id: result.data!.evidenceId,
      caseId: 'case1',
      workItemId: 'wi1',
      objectType: 'delivery_order',
      objectId: 'do1',
      kind: 'photo',
      storageObjectId: 'obj1',
      createdBy: 'owner',
    });
    const [event] = fake.rows('operationalEvent');
    expect(event).toMatchObject({
      type: 'evidence.attached',
      caseId: 'case1',
      areaKey: 'logistica',
      objectType: 'delivery_order',
      objectId: 'do1',
    });
  });

  it('allows the backup and managers, and rejects anyone else', async () => {
    expect(
      (await attach(users.backup, { workItemId: 'wi1', kind: 'note', note: 'Cliente ausente' }))
        .status
    ).toBe('completed');
    expect(
      (await attach(users.manager, { workItemId: 'wi1', kind: 'photo', storageObjectId: 'obj1' }))
        .status
    ).toBe('completed');
    const denied = await attach(users.stranger, {
      workItemId: 'wi1',
      kind: 'note',
      note: 'Hola',
    });
    expect(denied).toMatchObject({ status: 'rejected', errorCode: 'forbidden' });
    expect(fake.rows('evidenceLink')).toHaveLength(2);
  });

  it('only attaches ready evidence files uploaded by the actor and matching the kind', async () => {
    seedStorage('byBackup', { createdBy: 'backup' });
    seedStorage('chatFile', { purpose: 'chat' });
    seedStorage('rejected', { status: 'rejected' });
    seedStorage('pdf', { declaredMimeType: 'application/pdf', originalName: 'remision.pdf' });

    const cases: Array<[AttachEvidenceInput, string]> = [
      [{ workItemId: 'wi1', kind: 'photo', storageObjectId: 'missing' }, 'not_found'],
      [{ workItemId: 'wi1', kind: 'photo', storageObjectId: 'chatFile' }, 'invalid_payload'],
      [{ workItemId: 'wi1', kind: 'photo', storageObjectId: 'rejected' }, 'invalid_state'],
      [{ workItemId: 'wi1', kind: 'photo', storageObjectId: 'pdf' }, 'invalid_payload'],
      [{ workItemId: 'wi1', kind: 'photo', storageObjectId: 'byBackup' }, 'forbidden'],
      [{ workItemId: 'wi1', kind: 'photo' }, 'invalid_payload'],
      [{ workItemId: 'nope', kind: 'note', note: 'x' }, 'not_found'],
    ];
    for (const [input, code] of cases) {
      expect(await attach(users.owner, input)).toMatchObject({
        status: 'rejected',
        errorCode: code,
      });
    }
    expect(fake.rows('evidenceLink')).toHaveLength(0);

    // A manager may attach a file uploaded by someone else.
    expect(
      (
        await attach(users.manager, {
          workItemId: 'wi1',
          kind: 'photo',
          storageObjectId: 'byBackup',
        })
      ).status
    ).toBe('completed');
  });

  it('returns the existing link when the same file is attached twice to the same target', async () => {
    const first = await attach(users.owner, {
      workItemId: 'wi1',
      kind: 'photo',
      storageObjectId: 'obj1',
    });
    const second = await attach(users.owner, {
      workItemId: 'wi1',
      kind: 'photo',
      storageObjectId: 'obj1',
    });
    expect(second.data).toMatchObject({ created: false, evidenceId: first.data!.evidenceId });
    expect(fake.rows('evidenceLink')).toHaveLength(1);
  });

  it('attaches to a case step for participants of the step work items', async () => {
    fake.seed('caseStep', {
      id: 'st1',
      caseId: 'case1',
      processVersionId: 'pv1',
      stepKey: 'preparar_pedido',
      areaKey: 'inventario',
      kind: 'action',
    });
    seedWorkItem({
      id: 'wi2',
      stepId: 'st1',
      objectType: null,
      objectId: null,
      ownerUserId: 'backup',
      backupUserId: null,
    });
    const ok = await attach(users.backup, { stepId: 'st1', kind: 'note', note: 'Tarimas listas' });
    expect(ok.status).toBe('completed');
    expect(fake.rows('evidenceLink')[0]).toMatchObject({
      stepId: 'st1',
      caseId: 'case1',
      objectType: 'case_step',
      objectId: 'st1',
      workItemId: null,
    });
    expect(
      (await attach(users.stranger, { stepId: 'st1', kind: 'note', note: 'x' })).errorCode
    ).toBe('forbidden');
  });

  it('lets the case owner attach to the case and system actors attach anywhere', async () => {
    const byOwner = await attach(users.seller, {
      objectType: 'operational_case',
      objectId: 'case1',
      kind: 'note',
      note: 'El cliente pidió factura',
    });
    expect(byOwner.status).toBe('completed');
    expect(fake.rows('evidenceLink')[0]).toMatchObject({ caseId: 'case1' });
    expect(
      (
        await attach(users.seller, {
          objectType: 'operational_case',
          objectId: 'nope',
          kind: 'note',
          note: 'x',
        })
      ).errorCode
    ).toBe('not_found');

    const bySystem = await executeCommand(
      {
        commandId: 'sys-ev',
        type: EVIDENCE_ATTACH_COMMAND,
        actor: { type: 'system', id: 'zoho-readback' },
        aggregate: { type: 'evidence_target', id: 'delivery_order:do9' },
        payload: {
          objectType: 'delivery_order',
          objectId: 'do9',
          kind: 'zoho_readback',
          note: '{"status":"shipped"}',
        },
      },
      null,
      { now: NOW }
    );
    expect(bySystem.status).toBe('completed');
  });

  it('never links the evidence of my work item to another record', async () => {
    seedWorkItem({
      id: 'wi-other',
      ownerUserId: 'stranger',
      backupUserId: null,
      objectType: 'area_request',
      objectId: 'req-other',
    });
    seedStorage('obj-mine', { createdBy: 'owner' });
    const result = await attach(users.owner, {
      workItemId: 'wi1',
      objectType: 'area_request',
      objectId: 'req-other',
      kind: 'signature',
      storageObjectId: 'obj-mine',
    });
    expect(result).toMatchObject({ status: 'rejected', errorCode: 'invalid_payload' });
    expect(fake.rows('evidenceLink').filter((e) => e.objectId === 'req-other')).toHaveLength(0);

    // Its own record may still be named explicitly.
    const own = await attach(users.owner, {
      workItemId: 'wi1',
      objectType: 'delivery_order',
      objectId: 'do1',
      kind: 'note',
      note: 'Entregado en recepción',
    });
    expect(own.status).toBe('completed');
  });

  it('refuses attachEvidenceInTx outside a command', async () => {
    await expect(
      attachEvidenceInTx(fake.client as unknown as Prisma.TransactionClient, {
        workItemId: 'wi1',
        kind: 'note',
        note: 'x',
      })
    ).rejects.toMatchObject({ code: 'outside_command' });
  });
});

describe('listEvidence and file access', () => {
  beforeEach(async () => {
    await attach(users.owner, { workItemId: 'wi1', kind: 'photo', storageObjectId: 'obj1' });
    // Evidence of the same object from before the work item existed does not count for it.
    fake.seed('evidenceLink', {
      id: 'old',
      objectType: 'delivery_order',
      objectId: 'do1',
      kind: 'photo',
      createdBy: 'owner',
      createdAt: new Date('2026-09-15T09:00:00.000Z'),
    });
    fake.seed('evidenceLink', {
      id: 'objectLater',
      objectType: 'delivery_order',
      objectId: 'do1',
      kind: 'signature',
      storageObjectId: null,
      note: 'Firma en papel',
      createdBy: 'backup',
      createdAt: new Date('2026-09-15T12:00:00.000Z'),
    });
  });

  it('lists the evidence that counts for a work item with file metadata', async () => {
    const list = await listEvidence(users.viewer, { workItemId: 'wi1' });
    expect(list.map((e) => e.id).sort()).toEqual(
      [fake.rows('evidenceLink')[0].id, 'objectLater'].sort()
    );
    const photo = list.find((e) => e.kind === 'photo')!;
    expect(photo).toMatchObject({
      kindLabel: 'Foto',
      createdByName: 'Olga',
      file: {
        objectId: 'obj1',
        name: 'foto.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: '1024',
        url: '/app/files/api/objects/obj1/content',
      },
    });
    expect(
      (await listEvidence(users.viewer, { objectType: 'delivery_order', objectId: 'do1' })).map(
        (e) => e.id
      )
    ).toContain('old');
  });

  it('restricts listing to viewers, participants and the case owner', async () => {
    await expect(listEvidence(users.owner, { workItemId: 'wi1' })).resolves.toHaveLength(2);
    await expect(listEvidence(users.seller, { caseId: 'case1' })).resolves.not.toHaveLength(0);
    await expect(listEvidence(users.stranger, { workItemId: 'wi1' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(listEvidence(users.viewer, { workItemId: 'nope' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('a person whose participation was cancelled no longer lists the evidence of the case', async () => {
    seedWorkItem({
      id: 'wi-cancelled',
      ownerUserId: 'stranger',
      backupUserId: null,
      status: 'cancelled',
      objectType: 'case_step',
      objectId: 'st-old',
    });
    await expect(listEvidence(users.stranger, { caseId: 'case1' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(listEvidence(users.backup, { caseId: 'case1' })).resolves.not.toHaveLength(0);
  });

  it('grants file access to viewers, the uploader and participants only', async () => {
    const object = { id: 'obj1', createdBy: 'someone_else' };
    expect(await canReadEvidenceObject(users.viewer, object)).toBe(true);
    expect(await canReadEvidenceObject(users.stranger, { id: 'obj1', createdBy: 'stranger' })).toBe(
      true
    );
    expect(await canReadEvidenceObject(users.backup, object)).toBe(true);
    expect(await canReadEvidenceObject(users.seller, object)).toBe(true);
    expect(await canReadEvidenceObject(users.stranger, object)).toBe(false);
  });
});
