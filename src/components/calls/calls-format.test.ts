import { describe, expect, it } from 'vitest';
import type { VoiceCallDTO } from '@/modules/voice/voice-service';
import {
  aiHandled,
  callTitle,
  formatDuration,
  formatPhone,
  handlerLabel,
  matchesQuery,
  parseSummary,
} from './calls-format';

function call(overrides: Partial<VoiceCallDTO> = {}): VoiceCallDTO {
  return {
    id: 'vc1',
    type: 'inbound',
    status: 'ended',
    roomName: 'call-_vc1',
    fromIdentity: null,
    toIdentity: null,
    externalNumber: null,
    accountId: null,
    accountLabel: null,
    contactId: null,
    contactName: null,
    initiatedByUserId: null,
    aiState: 'active',
    aiMode: 'copilot',
    aiGeneration: 1,
    recordingState: 'off',
    recordingObjectId: null,
    transcriptObjectId: null,
    recordingExpiresAt: null,
    transcriptExpiresAt: null,
    summary: null,
    startedAt: null,
    endedAt: null,
    durationSec: 30,
    createdAt: '2026-09-14T16:00:00.000Z',
    participants: [],
    supervisions: [],
    segmentCount: 0,
    mock: false,
    ...overrides,
  };
}

describe('formatPhone', () => {
  it('formats Mexican numbers, including the legacy mobile 1', () => {
    expect(formatPhone('+524773790184')).toBe('+52 477 379 0184');
    expect(formatPhone('+5214773790184')).toBe('+52 477 379 0184');
  });

  it('accepts LiveKit SIP identities and rejects non-phone identities', () => {
    expect(formatPhone('sip_+524777270766')).toBe('+52 477 727 0766');
    expect(formatPhone('agent-AJ_QiBsg64H8Xb6')).toBeNull();
    expect(formatPhone(null)).toBeNull();
  });
});

describe('formatDuration', () => {
  it('uses m:ss and adds hours only when needed', () => {
    expect(formatDuration(77)).toBe('1:17');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatDuration(null)).toBe('—');
  });
});

describe('call labels', () => {
  it('never shows SIP or agent identities as the caller', () => {
    const inbound = call({
      participants: [
        {
          id: 'p1',
          identity: 'sip_+524775211021',
          userId: null,
          userName: null,
          role: 'caller',
          joinedAt: '2026-09-14T16:00:00.000Z',
          leftAt: null,
          muted: false,
        },
        {
          id: 'p2',
          identity: 'agent-AJ_QiBsg64H8Xb6',
          userId: null,
          userName: null,
          role: 'caller',
          joinedAt: '2026-09-14T16:00:01.000Z',
          leftAt: null,
          muted: false,
        },
        {
          id: 'p3',
          identity: 'user-u1',
          userId: 'u1',
          userName: 'Israel Saavedra',
          role: 'agent',
          joinedAt: '2026-09-14T16:00:20.000Z',
          leftAt: null,
          muted: false,
        },
      ],
    });
    expect(callTitle(inbound)).toBe('+52 477 521 1021');
    expect(aiHandled(inbound)).toBe(true);
    expect(handlerLabel(inbound)).toBe('IA → Israel Saavedra');
    expect(handlerLabel(inbound, 'u1')).toBe('IA → Tú');
  });

  it('prefers the contact name and searches without accents', () => {
    const known = call({ contactName: 'Ferretería Guadalupe', externalNumber: '+524773790184' });
    expect(callTitle(known)).toBe('Ferretería Guadalupe');
    expect(matchesQuery(known, 'ferreteria')).toBe(true);
    expect(matchesQuery(known, '379 01')).toBe(true);
    expect(matchesQuery(known, 'robles')).toBe(false);
  });
});

describe('parseSummary', () => {
  it('splits the text, commitments and follow-ups written by summarizeCall', () => {
    const parsed = parseSummary(
      'El cliente pide adelantar la entrega.\nCompromisos:\n- Confirmar con logística\nSeguimientos:\n- Llamar a Martín'
    );
    expect(parsed).toEqual({
      text: 'El cliente pide adelantar la entrega.',
      commitments: ['Confirmar con logística'],
      followUps: ['Llamar a Martín'],
    });
    expect(parseSummary('   ')).toBeNull();
  });
});
