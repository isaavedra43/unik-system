import { describe, expect, it, vi } from 'vitest';

// evidence-service is a server module: only its command name and schema are compared here.
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import {
  EVIDENCE_ATTACH_COMMAND as SERVER_ATTACH_COMMAND,
  attachEvidenceSchema,
} from '@/modules/operations/evidence-service';
import type { AreaWorkRow } from '@/modules/areas/area-work-row';
import {
  CAPTURE_KIND_LABELS,
  CAPTURE_NOTE_MAX,
  EVIDENCE_AGGREGATE_TYPE,
  EVIDENCE_ATTACH_COMMAND,
  MOBILE_VIEWS,
  MOBILE_VIEW_LABELS,
  buildEvidenceNoteCommand,
  evidenceUploadTargetId,
  isScanRequested,
  mobileCountLabel,
  parseEvidenceTarget,
  workCardSummary,
} from './area-mobile-model';

const NOW = new Date('2026-09-15T15:00:00.000Z');

function row(overrides: Partial<AreaWorkRow> = {}): AreaWorkRow {
  return {
    id: 'work_item:wi-1',
    rowKind: 'work_item',
    sourceId: 'wi-1',
    areaKey: 'inventario',
    caseId: 'case-1',
    caseNumber: 'EXP-7',
    customerName: 'Constructora del Norte',
    title: 'Verificar existencia',
    status: 'open',
    statusLabel: 'Abierto',
    statusTone: 'default',
    priority: 'normal',
    priorityLabel: 'Normal',
    ownerUserId: 'u-me',
    ownerName: 'Ana',
    dueAt: '2026-09-15T16:00:00.000Z',
    startedAt: null,
    lastActivityAt: '2026-09-15T14:00:00.000Z',
    escalationLevel: 0,
    waitReason: null,
    objectType: null,
    objectId: null,
    counterpartyName: null,
    locationCode: null,
    amount: null,
    quantity: null,
    version: 1,
    overdue: false,
    open: true,
    extra: {},
    ...overrides,
  };
}

describe('the mobile constants match the engine', () => {
  it('sends the same command the server registered', () => {
    expect(EVIDENCE_ATTACH_COMMAND).toBe(SERVER_ATTACH_COMMAND);
  });

  it('names every view and capture kind in Spanish', () => {
    for (const view of MOBILE_VIEWS) expect(MOBILE_VIEW_LABELS[view].length).toBeGreaterThan(2);
    expect(CAPTURE_KIND_LABELS.note).toBe('Nota');
    expect(CAPTURE_KIND_LABELS.photo).toBe('Foto');
  });
});

describe('parseEvidenceTarget', () => {
  it('reads the three target shapes', () => {
    expect(parseEvidenceTarget('work_item:wi-1')).toEqual({ workItemId: 'wi-1' });
    expect(parseEvidenceTarget('case_step:st-9')).toEqual({ stepId: 'st-9' });
    expect(parseEvidenceTarget('delivery_order:do-4')).toEqual({
      objectType: 'delivery_order',
      objectId: 'do-4',
    });
  });

  it('keeps ids that contain a colon', () => {
    expect(parseEvidenceTarget('work_item:wi:1')).toEqual({ workItemId: 'wi:1' });
  });

  it('rejects what the engine would reject', () => {
    expect(parseEvidenceTarget(null)).toBeNull();
    expect(parseEvidenceTarget('')).toBeNull();
    expect(parseEvidenceTarget('work_item')).toBeNull();
    expect(parseEvidenceTarget('work_item:')).toBeNull();
    expect(parseEvidenceTarget(':wi-1')).toBeNull();
    expect(parseEvidenceTarget('Delivery:do-1')).toBeNull();
    expect(parseEvidenceTarget(`obj:${'x'.repeat(121)}`)).toBeNull();
  });
});

describe('buildEvidenceNoteCommand', () => {
  it('builds a command the engine schema accepts', () => {
    const built = buildEvidenceNoteCommand('work_item:wi-1', '  Llegó el material  ');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.command.type).toBe(EVIDENCE_ATTACH_COMMAND);
    expect(built.command.aggregate).toEqual({
      type: EVIDENCE_AGGREGATE_TYPE,
      id: 'work_item:wi-1',
    });
    expect(built.command.payload).toEqual({
      workItemId: 'wi-1',
      kind: 'note',
      note: 'Llegó el material',
    });
    expect(attachEvidenceSchema.safeParse(built.command.payload).success).toBe(true);
  });

  it('works for a case step and for a domain object', () => {
    for (const target of ['case_step:st-1', 'delivery_order:do-1']) {
      const built = buildEvidenceNoteCommand(target, 'Entregado en obra');
      expect(built.ok).toBe(true);
      if (!built.ok) continue;
      expect(attachEvidenceSchema.safeParse(built.command.payload).success).toBe(true);
    }
  });

  it('refuses a row without an evidence target', () => {
    const built = buildEvidenceNoteCommand(null, 'Nota');
    expect(built).toEqual({ ok: false, error: 'Este trabajo todavía no admite evidencia.' });
  });

  it('refuses an empty note and one over the limit', () => {
    expect(buildEvidenceNoteCommand('work_item:wi-1', '   ')).toEqual({
      ok: false,
      error: 'Escribe la nota antes de guardarla.',
    });
    const long = buildEvidenceNoteCommand('work_item:wi-1', 'x'.repeat(CAPTURE_NOTE_MAX + 1));
    expect(long.ok).toBe(false);
    // The engine agrees with the limit shown to the person.
    expect(
      attachEvidenceSchema.safeParse({
        workItemId: 'wi-1',
        kind: 'note',
        note: 'x'.repeat(CAPTURE_NOTE_MAX + 1),
      }).success
    ).toBe(false);
  });
});

describe('evidenceUploadTargetId', () => {
  it('appends the kind the storage target reads', () => {
    expect(evidenceUploadTargetId('work_item:wi-1', 'photo')).toBe('work_item:wi-1#photo');
    expect(evidenceUploadTargetId('case_step:st-1', 'document')).toBe('case_step:st-1#document');
  });
});

describe('workCardSummary', () => {
  it('formats what a card shows', () => {
    const summary = workCardSummary(row(), NOW);
    expect(summary.kindLabel).toBe('Trabajo');
    expect(summary.statusLabel).toBe('Abierto');
    expect(summary.ownerLabel).toBe('Ana');
    expect(summary.context).toBe('EXP-7 · Constructora del Norte');
    expect(summary.due?.tone).toBe('warning');
  });

  it('says when nobody owns the row and when there is no date', () => {
    const summary = workCardSummary(
      row({ ownerName: null, dueAt: null, caseNumber: null, customerName: null }),
      NOW
    );
    expect(summary.ownerLabel).toBe('Sin asignar');
    expect(summary.due).toBeNull();
    expect(summary.context).toBeNull();
  });

  it('shows a closed row with its plain date, never as overdue', () => {
    const summary = workCardSummary(
      row({
        open: false,
        status: 'done',
        statusLabel: 'Terminado',
        dueAt: '2026-09-01T15:00:00.000Z',
      }),
      NOW
    );
    expect(summary.due?.tone).toBe('default');
  });
});

describe('mobileCountLabel', () => {
  it('counts what the phone shows', () => {
    expect(mobileCountLabel(0, 0)).toBe('Sin filas');
    expect(mobileCountLabel(1, 1)).toBe('1 fila');
    expect(mobileCountLabel(12, 12)).toBe('12 filas');
    expect(mobileCountLabel(20, 143)).toBe('20 de 143');
  });

  it('never shows more than the total', () => {
    expect(mobileCountLabel(30, 10)).toBe('30 filas');
    expect(mobileCountLabel(-5, -2)).toBe('Sin filas');
  });
});

describe('isScanRequested', () => {
  it('only reacts to the PWA shortcut', () => {
    expect(isScanRequested({ scan: '1' })).toBe(true);
    expect(isScanRequested({ scan: '0' })).toBe(false);
    expect(isScanRequested({})).toBe(false);
    expect(isScanRequested(null)).toBe(false);
  });
});
