import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PURCHASES_BOARD_CHANNEL,
  PURCHASES_REALTIME_TYPE,
} from '@/modules/purchases/purchases-types';

/**
 * `purchases:board` has to reach a screen (plan 6.6).
 *
 * The 35 `publishBoard(...)` calls of Compras were being thrown away: the
 * channel was authorized by the stream route and nobody in the browser was
 * listening, so the Sourcing Lab, the receipt capture and the RFQ review only
 * moved when the person reloaded. Vitest cannot mount these client components
 * (the unit project only takes `.test.ts`), so the guard reads the sources and
 * demands the subscription is still there — if somebody removes it, this test
 * says which screen went deaf instead of letting it rot silently again.
 */

const here = dirname(fileURLToPath(import.meta.url));
const componentsDir = resolve(here, '../../../components/areas/compras');

const SUBSCRIBERS = [
  ['el Laboratorio de Sourcing', 'SourcingLab.tsx'],
  ['la captura de recepción', 'ReceiptCapturePanel.tsx'],
  ['la revisión de cotizaciones', 'RfqReviewPanel.tsx'],
] as const;

function source(file: string): string {
  return readFileSync(resolve(componentsDir, file), 'utf8');
}

describe('suscripción a purchases:board', () => {
  it.each(SUBSCRIBERS)('%s escucha el canal del tablero de Compras', (_name, file) => {
    const code = source(file);
    expect(code).toContain('useOperationsRealtime');
    expect(code).toContain('PURCHASES_BOARD_CHANNEL');
    expect(code).toContain('PURCHASES_REALTIME_TYPE');
    // Filtra por lo que tiene en pantalla, nunca recarga con cualquier mensaje.
    expect(code).toContain('purchasesBoardTouches');
  });

  it('el canal y el tipo son los que publica el dominio', () => {
    expect(PURCHASES_BOARD_CHANNEL).toBe('purchases:board');
    expect(PURCHASES_REALTIME_TYPE).toBe('purchases.changed');
  });

  it('el publicador sigue existiendo y usando esas constantes', () => {
    const helpers = readFileSync(resolve(here, '../../purchases/purchases-helpers.ts'), 'utf8');
    expect(helpers).toContain('PURCHASES_BOARD_CHANNEL');
    expect(helpers).toContain('PURCHASES_REALTIME_TYPE');
  });
});
