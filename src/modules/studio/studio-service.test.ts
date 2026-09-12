import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeActor, sampleContent } from './studio-test-utils';

/**
 * Documents, versions, approval and the preserved rule "content changed after
 * approval → back to draft + pending proposals invalidated", with an
 * in-memory Prisma stub. No storage, no AI provider.
 */

const db = await vi.hoisted(async () => {
  const { createPrismaStub } = await import('./studio-test-utils');
  return createPrismaStub();
});
vi.mock('@/lib/prisma', () => ({ prisma: db.prisma }));
vi.mock('@/modules/storage/storage-service', () => ({
  getStorageObject: async (id: string) =>
    id === 'obj-ready-u1'
      ? { id, status: 'ready', purpose: 'document', createdBy: 'u1' }
      : id === 'obj-ready-other'
        ? { id, status: 'ready', purpose: 'document', createdBy: 'u9' }
        : null,
}));

import { applySelectionEdit } from './studio-content';
import {
  approveDocument,
  archiveDocument,
  createDocument,
  createTemplate,
  deleteTemplate,
  getDocument,
  listDocuments,
  listTemplates,
  listVersions,
  restoreVersion,
  saveDocument,
  shareDocument,
} from './studio-service';
import { requestReplacementBlocks } from './studio-ai-edit';

const owner = makeActor();
const teammate = makeActor({ id: 'u2', name: 'Compañera' });
const approver = makeActor({
  id: 'u3',
  name: 'Aprobadora',
  permissionKeys: ['studio.use', 'studio.approve'] as never,
});
const outsider = makeActor({ id: 'u4', permissionKeys: [] as never });

beforeEach(async () => {
  db.reset();
  for (const u of [owner, teammate, approver])
    await db.prisma.user.create({ data: { id: u.id, name: u.name } });
});

describe('documents and versions', () => {
  it('creates version 1 and increments on every content change (never overwrites)', async () => {
    const doc = await createDocument(owner, {
      title: 'Doc',
      kind: 'document',
      content: sampleContent(),
    });
    expect(doc.currentVersion).toBe(1);
    expect(doc.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const same = await saveDocument(owner, doc.id, {
      content: sampleContent(),
      title: 'Doc renombrado',
    });
    expect(same.versionCreated).toBe(false);
    expect(same.document.title).toBe('Doc renombrado');
    expect(same.document.currentVersion).toBe(1);

    const edited = applySelectionEdit(doc.content, ['b_p1'], {
      blocks: [{ id: 'b_p1', type: 'paragraph', text: 'Cambio' }],
    });
    const saved = await saveDocument(owner, doc.id, { content: edited });
    expect(saved.versionCreated).toBe(true);
    expect(saved.version).toBe(2);
    expect(saved.diff?.summary).toBe('Bloques: 1 modificado');

    const versions = await listVersions(owner, doc.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0].isCurrent).toBe(true);
    expect(versions[0].changeSummary).toBe('Bloques: 1 modificado');
    expect(versions[1].createdByName).toBe('Usuario Uno');
  });

  it('restores an old version as a new version', async () => {
    const doc = await createDocument(owner, {
      title: 'Doc',
      kind: 'document',
      content: sampleContent(),
    });
    const v1Hash = doc.contentHash;
    await saveDocument(owner, doc.id, {
      content: { version: 1, blocks: [{ id: 'x', type: 'divider' }] },
    });
    const versions = await listVersions(owner, doc.id);
    const restored = await restoreVersion(owner, doc.id, versions.find((v) => v.version === 1)!.id);
    expect(restored.version).toBe(3);
    expect(restored.document.contentHash).toBe(v1Hash);
    expect((await listVersions(owner, doc.id))[0].changeSummary).toBe('Restaurada la versión 1');
  });

  it('enforces visibility: private docs are invisible to teammates, team docs are editable', async () => {
    const doc = await createDocument(owner, {
      title: 'Privado',
      kind: 'document',
      content: sampleContent(),
    });
    await expect(getDocument(teammate, doc.id)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    await expect(getDocument(outsider, doc.id)).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    });
    expect(await listDocuments(teammate, { scope: 'team' })).toEqual([]);

    await approveDocument(approver, doc.id).catch(() => undefined); // approver cannot see a private doc
    await expect(approveDocument(approver, doc.id)).rejects.toMatchObject({ code: 'not_found' });

    await db.prisma.studioDocument.update({ where: { id: doc.id }, data: { visibility: 'team' } });
    const seen = await getDocument(teammate, doc.id);
    expect(seen.permissions).toEqual({ isOwner: false, canEdit: true, canApprove: false });
    expect((await listDocuments(teammate, { scope: 'team' })).map((d) => d.id)).toEqual([doc.id]);
    expect((await getDocument(approver, doc.id)).permissions.canApprove).toBe(true);
  });

  it('validates image objects: only ready "document" objects uploaded by the actor', async () => {
    const withImage = (id: string) => ({
      version: 1 as const,
      blocks: [{ id: 'i', type: 'image' as const, storageObjectId: id, alt: 'x' }],
    });
    await expect(
      createDocument(owner, { title: 'Img', kind: 'image', content: withImage('missing') })
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      createDocument(owner, { title: 'Img', kind: 'image', content: withImage('obj-ready-other') })
    ).rejects.toMatchObject({ code: 'forbidden' });
    const doc = await createDocument(owner, {
      title: 'Img',
      kind: 'image',
      content: withImage('obj-ready-u1'),
    });
    expect(doc.content.blocks[0].type).toBe('image');
    const saved = await saveDocument(owner, doc.id, { storageObjectId: 'obj-ready-u1' });
    expect(saved.versionCreated).toBe(true);
    expect(saved.document.storageObjectId).toBe('obj-ready-u1');
  });

  it('archives and blocks further edits', async () => {
    const doc = await createDocument(owner, {
      title: 'A',
      kind: 'document',
      content: sampleContent(),
    });
    await expect(archiveDocument(teammate, doc.id)).rejects.toMatchObject({ code: 'not_found' });
    const archived = await archiveDocument(owner, doc.id);
    expect(archived.status).toBe('archived');
    await expect(saveDocument(owner, doc.id, { title: 'B' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await listDocuments(owner)).toEqual([]);
    expect((await listDocuments(owner, { includeArchived: true })).length).toBe(1);
  });
});

describe('approval, sharing and the post-approval change rule', () => {
  it('approve → share → content change reverts to draft and invalidates pending proposals', async () => {
    const doc = await createDocument(owner, {
      title: 'Cotización',
      kind: 'document',
      content: sampleContent(),
    });
    await db.prisma.studioDocument.update({ where: { id: doc.id }, data: { visibility: 'team' } });
    await expect(approveDocument(owner, doc.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(shareDocument(approver, doc.id)).rejects.toMatchObject({ code: 'state' });

    const approved = await approveDocument(approver, doc.id);
    expect(approved.status).toBe('approved');
    expect(approved.approvedVersionId).toBe(approved.currentVersionId);
    const shared = await shareDocument(approver, doc.id);
    expect(shared.status).toBe('shared');
    expect(shared.visibility).toBe('team');
    expect(shared.sharedAt).not.toBeNull();

    // Proposals bound to the document, to one of its exports, and an unrelated one.
    const exp = await db.prisma.studioExport.create({
      data: {
        documentId: doc.id,
        versionId: doc.currentVersionId,
        format: 'pdf',
        status: 'ready',
        storageObjectId: 'obj-export',
        createdBy: owner.id,
      },
    });
    await db.prisma.aiProposal.create({
      data: { status: 'pending', fileIds: [doc.id], toolName: 'sendEmail' },
    });
    await db.prisma.aiProposal.create({
      data: { status: 'pending', fileIds: [exp.id as string], toolName: 'sendWhatsApp' },
    });
    await db.prisma.aiProposal.create({
      data: { status: 'pending', fileIds: ['obj-export'], toolName: 'sendFile' },
    });
    await db.prisma.aiProposal.create({
      data: { status: 'pending', fileIds: ['other-doc'], toolName: 'sendEmail' },
    });
    await db.prisma.aiProposal.create({
      data: { status: 'executed', fileIds: [doc.id], toolName: 'sendEmail' },
    });

    // Title-only edits do not touch the approval.
    const renamed = await saveDocument(owner, doc.id, { title: 'Cotización v2' });
    expect(renamed.revertedToDraft).toBe(false);
    expect(renamed.document.status).toBe('shared');

    const edited = applySelectionEdit(doc.content, ['b_kpi'], { blocks: [] });
    const result = await saveDocument(owner, doc.id, { content: edited });
    expect(result.revertedToDraft).toBe(true);
    expect(result.invalidatedProposals).toBe(3);
    expect(result.document.status).toBe('draft');
    expect(result.document.approvedVersionId).toBeNull();
    expect(result.document.approvedAt).toBeNull();
    expect(result.document.sharedAt).toBeNull();
    expect(result.document.visibility).toBe('team');

    const proposals = [...db.tables.aiProposal.values()];
    expect(proposals.filter((p) => p.status === 'invalidated').map((p) => p.error)).toEqual([
      'El documento cambió',
      'El documento cambió',
      'El documento cambió',
    ]);
    expect(proposals.find((p) => (p.fileIds as string[])[0] === 'other-doc')?.status).toBe(
      'pending'
    );
    expect(proposals.find((p) => p.status === 'executed')).toBeTruthy();
    expect(
      [...db.tables.auditLog.values()].some((a) => a.action === 'studio.document.reverted_to_draft')
    ).toBe(true);

    // Re-approving binds the NEW version.
    const reapproved = await approveDocument(approver, doc.id);
    expect(reapproved.approvedVersionId).toBe(result.document.currentVersionId);
  });

  it('cannot share when the current version is not the approved one', async () => {
    const doc = await createDocument(approver, {
      title: 'X',
      kind: 'document',
      content: sampleContent(),
    });
    await approveDocument(approver, doc.id);
    await saveDocument(approver, doc.id, { content: { version: 1, blocks: [] } });
    await expect(shareDocument(approver, doc.id)).rejects.toMatchObject({ code: 'state' });
  });
});

describe('templates', () => {
  it('personal templates are private; team templates need studio.approve and are visible to everyone', async () => {
    const personal = await createTemplate(owner, {
      name: 'Mi plantilla',
      kind: 'document',
      scope: 'personal',
      content: sampleContent(),
    });
    await expect(
      createTemplate(owner, {
        name: 'Equipo',
        kind: 'document',
        scope: 'team',
        content: sampleContent(),
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    const team = await createTemplate(approver, {
      name: 'Equipo',
      kind: 'document',
      scope: 'team',
      content: sampleContent(),
    });

    expect((await listTemplates(owner)).map((t) => t.name)).toEqual(['Mi plantilla', 'Equipo']);
    expect((await listTemplates(teammate)).map((t) => t.name)).toEqual(['Equipo']);

    const fromTemplate = await createDocument(teammate, {
      title: 'Desde plantilla',
      kind: 'document',
      templateId: team.id,
    });
    expect(fromTemplate.templateId).toBe(team.id);
    expect(fromTemplate.content.blocks.length).toBe(sampleContent().blocks.length);
    await expect(
      createDocument(teammate, { title: 'No', kind: 'document', templateId: personal.id })
    ).rejects.toMatchObject({ code: 'not_found' });

    await expect(deleteTemplate(teammate, team.id)).rejects.toMatchObject({ code: 'not_found' });
    await deleteTemplate(approver, team.id);
    expect((await listTemplates(teammate)).length).toBe(0);
  });
});

describe('AI selection edit — model output handling', () => {
  it('accepts fenced JSON, retries once on invalid output and fails after two attempts', async () => {
    const content = sampleContent();
    const selected = content.blocks.filter((b) => b.id === 'b_p1');
    let calls = 0;
    const flaky = async () => {
      calls++;
      return {
        content:
          calls === 1
            ? 'Claro, aquí está: {"blocks": [{"id":"b_p1","type":"paragraph"'
            : '```json\n{"blocks":[{"id":"b_p1","type":"paragraph","text":"Nuevo texto con 312 órdenes"}]}\n```',
        finishReason: 'stop',
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        model: 'test-model',
        durationMs: 1,
      };
    };
    const result = await requestReplacementBlocks(
      { title: 'T', content, selected, instruction: 'Resume' },
      flaky as never
    );
    expect(result.attempts).toBe(2);
    expect(result.blocks).toEqual([
      { id: 'b_p1', type: 'paragraph', text: 'Nuevo texto con 312 órdenes' },
    ]);

    const broken = async () => ({
      content: 'no json',
      finishReason: 'stop',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      model: 'm',
      durationMs: 0,
    });
    await expect(
      requestReplacementBlocks(
        { title: 'T', content, selected, instruction: 'Resume' },
        broken as never
      )
    ).rejects.toMatchObject({ code: 'invalid', status: 502 });
  });
});
