import { describe, expect, it } from 'vitest';
import {
  isBotTemplateMeta,
  isOperationsChannelType,
  agentRequestStatusUpdate,
  applyAgentRequestStatus,
  parseAgentProposalMeta,
  parseAgentRequestMeta,
} from './chat-events';

describe('isOperationsChannelType', () => {
  it('recognizes area channels and sales rooms only', () => {
    expect(isOperationsChannelType('area')).toBe(true);
    expect(isOperationsChannelType('case')).toBe(true);
    expect(isOperationsChannelType('group')).toBe(false);
    expect(isOperationsChannelType('dm')).toBe(false);
    expect(isOperationsChannelType(null)).toBe(false);
  });
});

describe('isBotTemplateMeta', () => {
  it('treats template kinds and explicit template flags as templates', () => {
    expect(isBotTemplateMeta({ kind: 'agent_request' })).toBe(true);
    expect(isBotTemplateMeta({ kind: 'agent_proposal' })).toBe(true);
    expect(isBotTemplateMeta({ kind: 'anything', template: true })).toBe(true);
  });

  it('does not treat free replies or malformed values as templates', () => {
    expect(isBotTemplateMeta({ kind: 'agent_reply' })).toBe(false);
    expect(isBotTemplateMeta({ template: 'yes' })).toBe(false);
    expect(isBotTemplateMeta(null)).toBe(false);
    expect(isBotTemplateMeta(['agent_request'])).toBe(false);
    expect(isBotTemplateMeta('agent_request')).toBe(false);
  });
});

describe('parseAgentRequestMeta', () => {
  it('defaults the quick actions and normalizes optional fields', () => {
    expect(parseAgentRequestMeta({ kind: 'agent_request', requestId: 'req_1' })).toEqual({
      kind: 'agent_request',
      requestId: 'req_1',
      caseId: null,
      areaKey: null,
      quickActions: ['accept', 'block', 'open_case'],
      actorUserIds: null,
      status: null,
      copyOf: null,
    });
  });

  it('keeps only known, unique quick actions and string actor ids', () => {
    expect(
      parseAgentRequestMeta({
        kind: 'agent_request',
        requestId: 'req_2',
        caseId: 'case_1',
        areaKey: 'compras',
        quickActions: ['block', 'delete', 'block', 7],
        actorUserIds: ['ana', 3, ''],
        status: 'acknowledged',
      })
    ).toMatchObject({
      caseId: 'case_1',
      areaKey: 'compras',
      quickActions: ['block'],
      actorUserIds: ['ana'],
      status: 'acknowledged',
    });
  });

  it('returns null when the meta is not a usable request', () => {
    expect(parseAgentRequestMeta({ kind: 'agent_request' })).toBeNull();
    expect(parseAgentRequestMeta({ kind: 'agent_proposal', requestId: 'req_1' })).toBeNull();
    expect(parseAgentRequestMeta(null)).toBeNull();
  });
});

describe('parseAgentProposalMeta', () => {
  it('maps the proposal fields for the approval card', () => {
    expect(
      parseAgentProposalMeta({
        kind: 'agent_proposal',
        proposalId: 'prop_1',
        caseId: 'case_1',
        toolName: 'reserveStock',
        summary: 'Reservar 15 m²',
        effect: 'business_write',
        expiresAt: '2026-09-16T00:00:00.000Z',
        args: { qty: 15 },
      })
    ).toEqual({
      kind: 'agent_proposal',
      proposalId: 'prop_1',
      caseId: 'case_1',
      toolName: 'reserveStock',
      summary: 'Reservar 15 m²',
      effect: 'business_write',
      expiresAt: '2026-09-16T00:00:00.000Z',
      args: { qty: 15 },
      status: null,
      approverUserIds: null,
      requiresSecondApproval: false,
    });
    expect(
      parseAgentProposalMeta({ kind: 'agent_proposal', proposalId: 'prop_2', approverUserIds: ['marta', 7, 'nico'], requiresSecondApproval: true })
    ).toMatchObject({ approverUserIds: ['marta', 'nico'], requiresSecondApproval: true });
  });

  it('keeps the earlier cards of a request current with the status of its updates', () => {
    const card = { id: 'm1', meta: { kind: 'agent_request', requestId: 'req_1', status: 'sent', actorUserIds: ['marta'] } };
    const copy = { id: 'm2', meta: { kind: 'agent_request', requestId: 'req_1', status: 'sent', copyOf: 'm1' } };
    const other = { id: 'm3', meta: { kind: 'agent_request', requestId: 'req_2', status: 'sent' } };
    const plain = { id: 'm4', meta: null };
    const update = agentRequestStatusUpdate({ meta: { kind: 'agent_update', requestId: 'req_1', status: 'resolved' } });
    expect(update).toEqual({ requestId: 'req_1', status: 'resolved' });
    const next = applyAgentRequestStatus([card, copy, other, plain], update!);
    expect(next.map((m) => m.meta?.status ?? null)).toEqual(['resolved', 'resolved', 'sent', null]);
    expect(next[0].meta).toMatchObject({ actorUserIds: ['marta'] });
    const same = [other, plain];
    expect(applyAgentRequestStatus(same, update!)).toBe(same);
    expect(agentRequestStatusUpdate({ meta: { kind: 'agent_request', requestId: 'req_1', status: 'sent' } })).toBeNull();
    expect(agentRequestStatusUpdate({ meta: { kind: 'agent_update', requestId: 'req_1' } })).toBeNull();
  });

  it('returns null without a proposal id', () => {
    expect(parseAgentProposalMeta({ kind: 'agent_proposal' })).toBeNull();
    expect(parseAgentProposalMeta({ kind: 'agent_request', proposalId: 'p' })).toBeNull();
  });
});
