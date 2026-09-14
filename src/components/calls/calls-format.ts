import type {
  VoiceCallDTO,
  VoiceParticipantDTO,
  VoiceSupervisionDTO,
} from '@/modules/voice/voice-service';

export const STATUS_LABEL: Record<VoiceCallDTO['status'], { label: string; badge: string }> = {
  ringing: { label: 'Timbrando', badge: 'badge-warning' },
  active: { label: 'En curso', badge: 'badge-success' },
  ended: { label: 'Finalizada', badge: 'badge-weak' },
  failed: { label: 'Falló', badge: 'badge-danger' },
  missed: { label: 'Perdida', badge: 'badge-danger' },
};

export const TYPE_LABEL: Record<VoiceCallDTO['type'], string> = {
  internal: 'Interna',
  inbound: 'Entrante',
  outbound: 'Saliente',
};

export const ROLE_LABEL: Record<string, string> = {
  caller: 'Llamante',
  callee: 'Destinatario',
  agent: 'Agente',
  ai: 'Asistente de voz',
  supervisor: 'Supervisor',
};

export const SUPERVISION_LABEL: Record<VoiceSupervisionDTO['mode'], string> = {
  listen: 'Escuchando',
  whisper: 'Susurrando',
  barge: 'Interviniendo',
};

export type HistoryFilter = 'all' | 'missed' | 'ai' | 'recorded';

export function isLiveCall(call: Pick<VoiceCallDTO, 'status'>): boolean {
  return call.status === 'ringing' || call.status === 'active';
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—';
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const SIP_PREFIX = /^sip[_:-]/i;

/** Human-readable phone number. LiveKit SIP identities (`sip_+52…`) are accepted. */
export function formatPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(SIP_PREFIX, '');
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 7) return null;
  const hasPlus = cleaned.startsWith('+');
  if (digits.startsWith('52') && (hasPlus || digits.length >= 12)) {
    let local = digits.slice(2);
    // Legacy Mexican mobile prefix: +52 1 XXX XXX XXXX.
    if (local.length === 11 && local.startsWith('1')) local = local.slice(1);
    if (local.length === 10) {
      return `+52 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
    }
  }
  if (!hasPlus && digits.length === 10) {
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  }
  return hasPlus ? `+${digits}` : digits;
}

export function isAiIdentity(identity: string): boolean {
  return identity.startsWith('ai-') || identity.startsWith('agent-');
}

function isAiParticipant(p: VoiceParticipantDTO): boolean {
  return p.role === 'ai' || isAiIdentity(p.identity);
}

function humanParticipants(call: VoiceCallDTO): VoiceParticipantDTO[] {
  return call.participants.filter((p) => p.userId && p.role !== 'supervisor');
}

export function externalNumberOf(call: VoiceCallDTO): string | null {
  if (call.type === 'internal') return null;
  if (call.externalNumber) return call.externalNumber;
  const sip = call.participants.find(
    (p) => !p.userId && SIP_PREFIX.test(p.identity) && formatPhone(p.identity) !== null
  );
  return sip ? sip.identity.replace(SIP_PREFIX, '') : null;
}

export function callNumberLabel(call: VoiceCallDTO): string | null {
  return formatPhone(externalNumberOf(call));
}

export function callTitle(call: VoiceCallDTO, userId?: string): string {
  if (call.type === 'internal') {
    const others = humanParticipants(call)
      .filter((p) => p.userId !== userId)
      .map((p) => p.userName)
      .filter((n): n is string => Boolean(n));
    const unique = [...new Set(others)];
    return unique.length > 0 ? unique.join(', ') : 'Llamada interna';
  }
  return call.contactName ?? callNumberLabel(call) ?? 'Número desconocido';
}

export function callSubtitle(call: VoiceCallDTO): string {
  if (call.type === 'internal') return 'Llamada interna';
  const number = callNumberLabel(call);
  if (call.contactName) return number ?? 'Sin número';
  return number ? 'Sin contacto registrado' : 'Sin número';
}

export function aiHandled(call: VoiceCallDTO): boolean {
  return call.participants.some(isAiParticipant);
}

/** Who took the call: last human agent, the voice assistant, or why nobody did. */
export function handlerLabel(call: VoiceCallDTO, userId?: string): string {
  if (call.type === 'internal') {
    const initiator = call.participants.find(
      (p) => p.userId && p.userId === call.initiatedByUserId
    );
    if (!initiator) return 'Interna';
    return initiator.userId === userId
      ? 'Iniciaste tú'
      : `Inició ${initiator.userName ?? 'un usuario'}`;
  }
  if (call.status === 'missed') return 'Nadie contestó';
  const people = humanParticipants(call);
  const last = people[people.length - 1];
  const ai = call.participants.find(isAiParticipant);
  const name = (p: VoiceParticipantDTO) => (p.userId === userId ? 'Tú' : (p.userName ?? 'Usuario'));
  if (last && ai && Date.parse(ai.joinedAt) <= Date.parse(last.joinedAt))
    return `IA → ${name(last)}`;
  if (last) return name(last);
  if (ai) return 'Asistente de voz';
  if (call.status === 'ringing') return 'Sin atender';
  if (call.status === 'failed') return 'No conectó';
  return '—';
}

export function participantName(p: VoiceParticipantDTO, call: VoiceCallDTO): string {
  if (isAiParticipant(p)) return 'Asistente de voz';
  if (p.userId) return p.userName ?? 'Usuario';
  return (
    call.contactName ?? formatPhone(p.identity) ?? formatPhone(call.externalNumber) ?? 'Cliente'
  );
}

export type SpeakerKind = 'ai' | 'agent' | 'client' | 'system';

export function speakerKind(identity: string): SpeakerKind {
  if (isAiIdentity(identity)) return 'ai';
  if (identity.startsWith('user-') || identity.startsWith('sup-')) return 'agent';
  if (identity === 'recording') return 'system';
  return 'client';
}

export function speakerLabel(identity: string, call: VoiceCallDTO): string {
  const kind = speakerKind(identity);
  if (kind === 'ai') return 'Asistente de voz';
  if (kind === 'system') return 'Grabación';
  const participant = call.participants.find((p) => p.identity === identity);
  if (kind === 'agent') {
    return participant?.userName ?? (identity.startsWith('sup-') ? 'Supervisor' : 'Agente');
  }
  return participant ? participantName(participant, call) : (call.contactName ?? 'Cliente');
}

/** Ringing calls count from creation; connected calls from the moment they connected. */
export function callStartMs(call: VoiceCallDTO): number {
  const iso = call.status === 'ringing' ? call.createdAt : (call.startedAt ?? call.createdAt);
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Date.parse(call.createdAt);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (isSameLocalDay(d, now)) return 'Hoy';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameLocalDay(d, yesterday)) return 'Ayer';
  const label = d.toLocaleDateString('es-MX', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function timeLabel(iso: string, withSeconds = false): string {
  return new Date(iso).toLocaleTimeString('es-MX', {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  });
}

export interface ParsedSummary {
  text: string;
  commitments: string[];
  followUps: string[];
}

/** Splits the stored summary ("texto\nCompromisos:\n- …\nSeguimientos:\n- …"). */
export function parseSummary(summary: string | null | undefined): ParsedSummary | null {
  if (!summary?.trim()) return null;
  const text: string[] = [];
  const commitments: string[] = [];
  const followUps: string[] = [];
  let bucket: 'text' | 'commitments' | 'followUps' = 'text';
  for (const raw of summary.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^compromisos:?$/i.test(line)) {
      bucket = 'commitments';
      continue;
    }
    if (/^seguimientos:?$/i.test(line)) {
      bucket = 'followUps';
      continue;
    }
    const item = line.replace(/^[-•*]\s*/, '');
    if (bucket === 'commitments') commitments.push(item);
    else if (bucket === 'followUps') followUps.push(item);
    else text.push(line);
  }
  return { text: text.join(' '), commitments, followUps };
}

export function summarySnippet(summary: string | null | undefined, max = 140): string | null {
  const text = parseSummary(summary)?.text;
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function matchesHistoryFilter(call: VoiceCallDTO, filter: HistoryFilter): boolean {
  switch (filter) {
    case 'missed':
      return call.status === 'missed';
    case 'ai':
      return aiHandled(call);
    case 'recorded':
      return Boolean(call.recordingObjectId);
    default:
      return true;
  }
}

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

/** Accent-insensitive search over contact, number, agents, line and summary. */
export function matchesQuery(call: VoiceCallDTO, query: string, userId?: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 3 && (externalNumberOf(call) ?? '').replace(/\D/g, '').includes(digits)) {
    return true;
  }
  const haystack = [
    callTitle(call, userId),
    handlerLabel(call, userId),
    call.accountLabel,
    call.summary,
    ...call.participants.map((p) => p.userName),
  ]
    .filter(Boolean)
    .join(' ');
  return fold(haystack).includes(q);
}

export interface ActivityEvent {
  at: string;
  text: string;
  tone: 'brand' | 'success' | 'warning' | 'danger' | 'muted';
}

/** Timeline built only from what the call record stores. */
export function buildActivity(call: VoiceCallDTO, userId?: string): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const number = callNumberLabel(call);
  const initiator = call.participants.find((p) => p.userId && p.userId === call.initiatedByUserId);
  const initiatedByMe = Boolean(initiator && initiator.userId === userId);
  const initiatorName = initiator?.userName ?? 'Alguien';

  if (call.type === 'inbound') {
    events.push({
      at: call.createdAt,
      text: `Entró la llamada${call.accountLabel ? ` por ${call.accountLabel}` : ''}`,
      tone: 'brand',
    });
  } else if (call.type === 'outbound') {
    events.push({
      at: call.createdAt,
      text: `${initiatedByMe ? 'Marcaste' : `${initiatorName} marcó`}${number ? ` al ${number}` : ''}`,
      tone: 'brand',
    });
  } else {
    events.push({
      at: call.createdAt,
      text: initiatedByMe
        ? 'Iniciaste la llamada interna'
        : `${initiatorName} inició la llamada interna`,
      tone: 'brand',
    });
  }
  if (call.startedAt)
    events.push({ at: call.startedAt, text: 'Llamada conectada', tone: 'success' });

  for (const p of call.participants) {
    const me = Boolean(p.userId && p.userId === userId);
    const name = participantName(p, call);
    events.push({
      at: p.joinedAt,
      text: `${me ? 'Entraste' : `${name} entró`}${p.role === 'supervisor' ? ' como supervisor' : ''}`,
      tone: 'muted',
    });
    if (p.leftAt)
      events.push({ at: p.leftAt, text: me ? 'Saliste' : `${name} salió`, tone: 'muted' });
  }
  for (const s of call.supervisions) {
    const supervisor = call.participants.find((p) => p.userId === s.supervisorUserId);
    events.push({
      at: s.startedAt,
      text: `${supervisor?.userName ?? 'Un supervisor'}: ${SUPERVISION_LABEL[s.mode].toLowerCase()}`,
      tone: 'warning',
    });
  }
  if (call.status === 'missed') {
    events.push({
      at: call.endedAt ?? call.createdAt,
      text: 'Nadie contestó · llamada perdida',
      tone: 'danger',
    });
  } else if (call.status === 'failed') {
    events.push({
      at: call.endedAt ?? call.createdAt,
      text: 'No se pudo conectar',
      tone: 'danger',
    });
  } else if (call.status === 'ended' && call.endedAt) {
    events.push({
      at: call.endedAt,
      text: `Terminó · duró ${formatDuration(call.durationSec)}`,
      tone: 'muted',
    });
  }
  return events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
