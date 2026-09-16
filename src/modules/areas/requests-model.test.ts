import { describe, expect, it, vi } from 'vitest';

/**
 * The transition table lives in the operations core, whose service reaches
 * Prisma at import time; the rules under test are pure, so the database and the
 * notification side of that module are stubbed away.
 */
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/modules/auth/authorization', () => ({
  hasPermission: () => false,
}));

import type { AreaRequestDTO } from '@/modules/operations/area-requests-service';
import {
  areaRequestActions,
  canDecideAreaRequest,
  noDecisionReason,
  type AreaRequestActor,
} from './requests-model';

type Request = Pick<AreaRequestDTO, 'ownerUserId' | 'backupUserId' | 'status'>;

const request = (overrides: Partial<Request> = {}): Request => ({
  ownerUserId: 'u-owner',
  backupUserId: 'u-backup',
  status: 'sent',
  ...overrides,
});

const actor = (overrides: Partial<AreaRequestActor> = {}): AreaRequestActor => ({
  userId: 'u-owner',
  canManage: false,
  areaResponsible: false,
  ...overrides,
});

const ids = (options: ReturnType<typeof areaRequestActions>) => options.map((option) => option.id);

describe('canDecideAreaRequest', () => {
  it('lets the owner, the backup, the area responsible and operations.manage decide', () => {
    expect(canDecideAreaRequest(request(), actor())).toBe(true);
    expect(canDecideAreaRequest(request(), actor({ userId: 'u-backup' }))).toBe(true);
    expect(
      canDecideAreaRequest(request(), actor({ userId: 'u-lead', areaResponsible: true }))
    ).toBe(true);
    expect(canDecideAreaRequest(request(), actor({ userId: 'u-admin', canManage: true }))).toBe(
      true
    );
  });

  it('does not let anybody else decide', () => {
    expect(canDecideAreaRequest(request(), actor({ userId: 'u-otro' }))).toBe(false);
  });

  it('does not confuse a request without backup with a person without id', () => {
    const noBackup = request({ backupUserId: null });
    expect(canDecideAreaRequest(noBackup, actor({ userId: 'u-otro' }))).toBe(false);
  });
});

describe('areaRequestActions', () => {
  it('offers accept, respond, block and reject on a request just received', () => {
    expect(ids(areaRequestActions(request(), actor(), { direction: 'in' }))).toEqual([
      'accept',
      'resolve',
      'block',
      'reject',
    ]);
  });

  it('drops accept once it is accepted and drops block once it is blocked', () => {
    expect(ids(areaRequestActions(request({ status: 'accepted' }), actor(), { direction: 'in' })));
    expect(
      ids(areaRequestActions(request({ status: 'accepted' }), actor(), { direction: 'in' }))
    ).toEqual(['resolve', 'block', 'reject']);
    expect(
      ids(areaRequestActions(request({ status: 'blocked' }), actor(), { direction: 'in' }))
    ).toEqual(['accept', 'resolve', 'reject']);
  });

  it('offers nothing on a closed request', () => {
    for (const status of ['resolved', 'rejected', 'cancelled', 'expired']) {
      expect(areaRequestActions(request({ status }), actor(), { direction: 'in' })).toEqual([]);
    }
  });

  it('offers nothing to somebody who is not responsible', () => {
    expect(areaRequestActions(request(), actor({ userId: 'u-otro' }), { direction: 'in' })).toEqual(
      []
    );
  });

  it('never offers a decision on a request the area sent', () => {
    expect(areaRequestActions(request(), actor({ canManage: true }), { direction: 'out' })).toEqual(
      []
    );
  });

  it('requires a text for responding, blocking and rejecting but not for accepting', () => {
    const options = areaRequestActions(request(), actor(), { direction: 'in' });
    const required = Object.fromEntries(options.map((option) => [option.id, option.required]));
    expect(required).toEqual({ accept: false, resolve: true, block: true, reject: true });
  });
});

describe('noDecisionReason', () => {
  it('explains why there are no buttons', () => {
    expect(noDecisionReason(request(), actor(), { direction: 'out' })).toBe(
      'La decide el área a la que se envió.'
    );
    expect(noDecisionReason(request(), actor({ userId: 'u-otro' }), { direction: 'in' })).toBe(
      'La responde el responsable del área o quien la tenga a cargo.'
    );
    expect(noDecisionReason(request({ status: 'resolved' }), actor(), { direction: 'in' })).toBe(
      'Ya está cerrada.'
    );
    expect(noDecisionReason(request(), actor(), { direction: 'in' })).toBeNull();
  });
});
