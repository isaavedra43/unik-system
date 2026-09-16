import { describe, expect, it } from 'vitest';
import {
  SYNC_ENTITY_LIMIT,
  SYNC_STALE_MINUTES,
  isFailedSyncRun,
  latestSyncRunsSql,
  syncRunLabels,
  toSyncHealthRows,
  type SyncRunRow,
} from './control-tower-service';

/**
 * Salud de la sincronización con Zoho del resumen de la Torre (plan 7.7:
 * «salud de sync Zoho desde el último `IntegrationSyncRun` por entidad»).
 *
 * EL HUECO QUE CIERRA. Antes se leían las 60 corridas más recientes y se
 * deduplicaba en memoria: con ~11 entidades corriendo cada 30 minutos eso es
 * una o dos horas de historia, así que la entidad que DEJA de sincronizar salía
 * de la ventana antes de cumplir los 120 minutos que la pintan en ámbar y su
 * fila desaparecía del panel —y del conteo de fallas— justo cuando había que
 * verla. Aquí se fija lo que debe cumplirse siempre: la consulta pide una fila
 * por entidad (`DISTINCT ON`) y el tope cuenta ENTIDADES, no corridas.
 */

const NOW = new Date('2026-09-15T18:00:00.000Z');

function run(overrides: Partial<SyncRunRow> = {}): SyncRunRow {
  return {
    source: 'zoho',
    entityType: 'salesorder',
    status: 'COMPLETED',
    startedAt: new Date('2026-09-15T17:50:00.000Z'),
    completedAt: new Date('2026-09-15T17:52:00.000Z'),
    errorCode: null,
    recordsSeen: 12,
    ...overrides,
  };
}

describe('latestSyncRunsSql', () => {
  it('pide UNA corrida por entidad y limita entidades, no corridas', () => {
    const sql = latestSyncRunsSql();
    const text = sql.sql.replace(/\s+/g, ' ');
    expect(text).toContain('DISTINCT ON (r."source", r."entityType")');
    // El orden del DISTINCT ON tiene que empezar por sus mismas columnas o
    // PostgreSQL rechaza la consulta; el DESC es lo que elige la ÚLTIMA.
    expect(text).toContain('ORDER BY r."source", r."entityType", r."startedAt" DESC');
    expect(text).toContain('LIMIT');
    // El tope viaja como parámetro (nunca concatenado) y cuenta pares ya deduplicados.
    expect(sql.values).toStrictEqual([SYNC_ENTITY_LIMIT]);
    expect(SYNC_ENTITY_LIMIT).toBeGreaterThan(20);
  });

  it('no vuelve a la ventana de corridas recientes', () => {
    // La regresión concreta: `ORDER BY startedAt DESC LIMIT 60` sin DISTINCT ON.
    expect(latestSyncRunsSql().sql).not.toMatch(/ORDER BY\s+r?\."?startedAt/);
  });
});

describe('toSyncHealthRows', () => {
  it('ordena por fuente y entidad y calcula la antigüedad contra el reloj recibido', () => {
    const rows = toSyncHealthRows(
      [
        run({ source: 'zoho', entityType: 'salesorder' }),
        run({ source: 'zoho', entityType: 'contact' }),
        run({ source: 'alpha', entityType: 'invoice' }),
      ],
      NOW
    );
    expect(rows.map((row) => `${row.source}/${row.entityType}`)).toStrictEqual([
      'alpha/invoice',
      'zoho/contact',
      'zoho/salesorder',
    ]);
    expect(rows[0].minutesAgo).toBe(8);
    expect(rows[0].stale).toBe(false);
  });

  it('una entidad sin noticias hace horas sigue en la lista y sale en ámbar', () => {
    const rows = toSyncHealthRows(
      [
        run({ entityType: 'contact', completedAt: new Date('2026-09-15T09:00:00.000Z') }),
        run({ entityType: 'salesorder' }),
      ],
      NOW
    );
    const contact = rows.find((row) => row.entityType === 'contact');
    expect(contact?.minutesAgo).toBe(540);
    expect(contact?.stale).toBe(true);
    // No falló: dejó de correr. Esa diferencia es la que separa las dos alertas.
    expect(isFailedSyncRun(contact!)).toBe(false);
  });

  it('una corrida en curso envejece desde que empezó (no espera un `completedAt`)', () => {
    const [row] = toSyncHealthRows(
      [
        run({
          status: 'RUNNING',
          startedAt: new Date('2026-09-15T14:00:00.000Z'),
          completedAt: null,
        }),
      ],
      NOW
    );
    expect(row.completedAt).toBeNull();
    expect(row.minutesAgo).toBe(240);
    expect(row.stale).toBe(true);
  });

  it('nunca da antigüedad negativa si el reloj de la base va por delante', () => {
    const [row] = toSyncHealthRows(
      [run({ completedAt: new Date('2026-09-15T18:05:00.000Z') })],
      NOW
    );
    expect(row.minutesAgo).toBe(0);
  });

  it('el umbral de frescura es el que publica el resumen', () => {
    const justUnder = toSyncHealthRows(
      [run({ completedAt: new Date(NOW.getTime() - SYNC_STALE_MINUTES * 60_000) })],
      NOW
    );
    const justOver = toSyncHealthRows(
      [run({ completedAt: new Date(NOW.getTime() - (SYNC_STALE_MINUTES + 1) * 60_000) })],
      NOW
    );
    expect(justUnder[0].stale).toBe(false);
    expect(justOver[0].stale).toBe(true);
  });
});

describe('isFailedSyncRun', () => {
  it('reconoce el estado que escribe el motor, que va en MAYÚSCULAS', () => {
    // `SYNC_STATUS.FAILED === 'FAILED'`: comparar con `'failed'` nunca coincidía.
    expect(isFailedSyncRun({ status: 'FAILED', errorCode: null })).toBe(true);
    expect(isFailedSyncRun({ status: 'failed', errorCode: null })).toBe(true);
    expect(isFailedSyncRun({ status: 'COMPLETED', errorCode: 'ZOHO_API_ERROR' })).toBe(true);
    expect(isFailedSyncRun({ status: 'COMPLETED', errorCode: null })).toBe(false);
    expect(isFailedSyncRun({ status: 'RUNNING', errorCode: null })).toBe(false);
  });
});

describe('syncRunLabels', () => {
  it('nombra las primeras `fuente/entidad` para el detalle de la alerta', () => {
    const rows = toSyncHealthRows(
      [
        run({ entityType: 'contact' }),
        run({ entityType: 'invoice' }),
        run({ entityType: 'item' }),
        run({ entityType: 'salesorder' }),
      ],
      NOW
    );
    expect(syncRunLabels(rows)).toStrictEqual(['zoho/contact', 'zoho/invoice', 'zoho/item']);
    expect(syncRunLabels(rows, 1)).toStrictEqual(['zoho/contact']);
    expect(syncRunLabels([])).toStrictEqual([]);
  });
});
