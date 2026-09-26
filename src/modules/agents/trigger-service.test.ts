import { describe, expect, it, vi } from 'vitest';

// trigger-service registra jobs y toca Prisma al importarse: se aíslan sus
// dependencias para probar solo el cálculo de la próxima corrida.
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/modules/jobs/job-queue', () => ({
  enqueueJob: vi.fn(async () => ({ id: 'job', status: 'pending', deduplicated: false })),
  registerJobHandler: () => undefined,
}));
vi.mock('@/modules/jobs/scheduled-jobs', () => ({ registerRecurringJob: () => undefined }));
vi.mock('@/modules/realtime/realtime-service', () => ({ publishRealtime: vi.fn() }));
vi.mock('@/modules/ai/tools/registry', () => ({ executeTool: vi.fn() }));

import { computeNextRun } from './trigger-service';

/** Reloj de pared de `date` en `tz` como "HH:MM". */
function wallClock(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

describe('computeNextRun', () => {
  it('everyMinutes suma el intervalo desde `from`', () => {
    const from = new Date('2026-09-26T12:00:00Z');
    expect(computeNextRun({ everyMinutes: 120 }, from)?.toISOString()).toBe(
      '2026-09-26T14:00:00.000Z'
    );
  });

  it('atHour con tz respeta la hora local del negocio aunque el servidor esté en UTC', () => {
    const tz = 'America/Mexico_City';
    // 2026-09-26 03:00 UTC = 21:00 del 25 en CDMX (UTC-6): las 7:30 locales aún no pasan.
    const from = new Date('2026-09-26T03:00:00Z');
    const next = computeNextRun({ atHour: 7, atMinute: 30, tz }, from);
    expect(next).not.toBeNull();
    expect(wallClock(next as Date, tz)).toBe('07:30');
    expect((next as Date).toISOString()).toBe('2026-09-26T13:30:00.000Z');
    expect((next as Date).getTime()).toBeGreaterThan(from.getTime());
  });

  it('atHour con tz pasa a mañana cuando la hora local ya ocurrió hoy', () => {
    const tz = 'America/Mexico_City';
    // 2026-09-26 20:00 UTC = 14:00 en CDMX: las 7:30 ya pasaron → 27 a las 7:30 (13:30Z).
    const from = new Date('2026-09-26T20:00:00Z');
    const next = computeNextRun({ atHour: 7, atMinute: 30, tz }, from);
    expect((next as Date).toISOString()).toBe('2026-09-27T13:30:00.000Z');
    expect(wallClock(next as Date, tz)).toBe('07:30');
  });

  it('una tz inválida cae a la hora del servidor sin lanzar', () => {
    const from = new Date('2026-09-26T03:00:00Z');
    const next = computeNextRun({ atHour: 7, atMinute: 30, tz: 'Marte/Olympus' }, from);
    expect(next).not.toBeNull();
    expect((next as Date).getTime()).toBeGreaterThan(from.getTime());
  });

  it('sin everyMinutes ni atHour no hay próxima corrida', () => {
    expect(computeNextRun({}, new Date())).toBeNull();
  });
});
