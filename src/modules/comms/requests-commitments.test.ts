import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CurrentUser } from '@/modules/auth/authorization';

/**
 * Internal requests (auto-assignment through the responsible directory,
 * dossier, timeline) and commitments (overdue sweep, heuristic suggestions).
 */

const { db, published } = await vi.hoisted(async () => {
  const { FakePrisma } = await import('./testing/fake-prisma');
  return {
    db: new FakePrisma(),
    published: [] as Array<{ channel: string; type: string; payload: unknown }>,
  };
});

vi.mock('@/lib/prisma', () => ({ prisma: db.client }));
vi.mock('@/modules/auth/authorization', () => ({
  hasPermission: (user: CurrentUser, key: string) =>
    user.isSuperAdmin || user.permissionKeys.includes(key as never),
}));
vi.mock('@/modules/auth/audit-service', () => ({ recordAuditEvent: vi.fn(async () => undefined) }));
vi.mock('@/modules/realtime/realtime-service', () => ({
  publishRealtime: vi.fn(async (channel: string, type: string, payload: unknown) => {
    published.push({ channel, type, payload });
    return {};
  }),
  REALTIME_CHANNELS: { user: (id: string) => `user:${id}`, inbox: (s: string) => `inbox:${s}` },
}));
vi.mock('@/modules/storage/storage-access', () => ({
  registerFileAccessResolver: () => undefined,
  registerUploadTargetResolver: () => undefined,
  resolveFileAccess: async (_actor: unknown, id: string) =>
    id === 'forbidden'
      ? { allowed: false, object: { id, status: 'ready' } }
      : { allowed: true, object: { id, status: 'ready' } },
}));
vi.mock('@/modules/storage/storage-service', () => ({ StorageError: class extends Error {} }));

import { createRequest, getRequest, updateRequest } from './requests-service';
import { createResponsible, resolveResponsible } from './responsibles-service';
import {
  createCommitment,
  markOverdueCommitments,
  parseRelativeDue,
  suggestCommitments,
} from './commitments-service';

const admin: CurrentUser = {
  id: 'u_admin',
  username: 'admin',
  name: 'Admin',
  email: null,
  mustChangePassword: false,
  roleKeys: ['super_admin'],
  permissionKeys: [] as never,
  isSuperAdmin: true,
};
const requester: CurrentUser = {
  ...admin,
  id: 'u_req',
  name: 'Solicitante',
  roleKeys: ['ventas'],
  permissionKeys: ['requests.use', 'inbox.use'] as never,
  isSuperAdmin: false,
};

beforeEach(() => {
  db.tables.clear();
  published.length = 0;
  db.seed('user', { id: 'u_admin', name: 'Admin', username: 'admin' });
  db.seed('user', { id: 'u_req', name: 'Solicitante', username: 'req' });
  db.seed('user', { id: 'u_inst', name: 'Instalador', username: 'inst' });
  db.seed('user', { id: 'u_backup', name: 'Respaldo', username: 'bk' });
});

describe('internal requests', () => {
  it('auto-assigns to the responsible of the area and records the timeline', async () => {
    await createResponsible(admin, {
      area: 'Instalaciones',
      label: 'Instalaciones',
      userId: 'u_inst',
      backupUserId: 'u_backup',
    });
    const request = await createRequest(requester, {
      type: 'instalaciones',
      title: 'Instalar pantalla en sucursal',
      priority: 'high',
      fileIds: ['file1'],
      facts: [{ key: 'Dirección', value: 'Av. Reforma 1', source: 'user' }],
    });
    expect(request.assigneeUserId).toBe('u_inst');
    expect(request.assigneeName).toBe('Instalador');
    expect(request.fileIds).toEqual(['file1']);
    expect(request.dossier.facts[0]).toMatchObject({ key: 'Dirección', addedBy: 'u_req' });
    const detail = await getRequest(requester, request.id);
    expect(detail.events?.map((e) => e.type)).toEqual(['created', 'assigned', 'file_added']);
    expect(published.some((p) => p.channel === 'user:u_inst' && p.type === 'request')).toBe(true);
  });

  it('falls back to the backup when the primary responsible is inactive', async () => {
    await createResponsible(admin, {
      area: 'cobranza',
      label: 'Cobranza',
      userId: 'u_inst',
      backupUserId: 'u_backup',
    });
    db.rows('user').find((u) => u.id === 'u_inst')!.isActive = false;
    const resolved = await resolveResponsible('Cobranza');
    expect(resolved).toMatchObject({ userId: 'u_backup', isBackup: true });
    const request = await createRequest(requester, {
      type: 'cobranza',
      title: 'Cobrar factura 123',
      priority: 'normal',
    });
    expect(request.assigneeUserId).toBe('u_backup');
  });

  it('rejects files the user cannot read and hides requests from strangers', async () => {
    await expect(
      createRequest(requester, {
        type: 'soporte',
        title: 'Con archivo ajeno',
        priority: 'normal',
        fileIds: ['forbidden'],
      })
    ).rejects.toThrow();
    const request = await createRequest(requester, {
      type: 'soporte',
      title: 'Sin responsable',
      priority: 'normal',
    });
    expect(request.assigneeUserId).toBeNull();
    const stranger: CurrentUser = { ...requester, id: 'u_backup' };
    await expect(getRequest(stranger, request.id)).rejects.toThrow();
    const updated = await updateRequest(requester, request.id, {
      status: 'in_progress',
      facts: [{ key: 'Equipo', value: 'Router', source: 'ai' }],
    });
    expect(updated.status).toBe('in_progress');
    expect(updated.events?.some((e) => e.type === 'ai_note')).toBe(true);
  });
});

describe('commitments', () => {
  it('marks due commitments overdue and notifies owners', async () => {
    await createCommitment(requester, {
      description: 'Enviar cotización',
      dueAt: new Date(Date.now() - 60_000).toISOString(),
      sourceType: 'manual',
    });
    await createCommitment(requester, {
      description: 'Llamar mañana',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      sourceType: 'manual',
    });
    const ids = await markOverdueCommitments();
    expect(ids).toHaveLength(1);
    expect(
      db
        .rows('commitment')
        .map((c) => c.status)
        .sort()
    ).toEqual(['overdue', 'pending']);
    expect(published.some((p) => p.channel === 'user:u_req' && p.type === 'commitment')).toBe(true);
    expect(await markOverdueCommitments()).toHaveLength(0);
  });

  it('suggests commitments from Spanish outbound text without persisting them', () => {
    const now = new Date('2026-09-09T10:00:00'); // Wednesday
    const suggestions = suggestCommitments(
      'Gracias por tu mensaje. Te envío la cotización mañana a las 3 pm. Que tengas buen día.',
      now
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].description).toContain('Te envío la cotización');
    expect(new Date(suggestions[0].dueAt!).getDate()).toBe(10);
    expect(new Date(suggestions[0].dueAt!).getHours()).toBe(15);
    expect(parseRelativeDue('lo reviso el lunes', now)!.getDay()).toBe(1);
    expect(parseRelativeDue('te aviso en 2 horas', now)!.getHours()).toBe(12);
    expect(suggestCommitments('Hola, ¿cómo estás?', now)).toHaveLength(0);
    expect(db.rows('commitment')).toHaveLength(0);
  });
});
