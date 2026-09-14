/**
 * Confidence labels: the assistant ends data answers with a "Confianza:" line
 * (verificado / estimación / suposición). This parser extracts and removes it
 * so the UI can show a badge instead of raw text. Pure and client-safe.
 */
export type ConfidenceLevel = 'verified' | 'estimate' | 'assumption';

export const CONFIDENCE_META: Record<ConfidenceLevel, { label: string; hint: string }> = {
  verified: { label: 'Datos verificados', hint: 'Cifras tomadas directamente del sistema en este turno.' },
  estimate: { label: 'Estimación', hint: 'Cálculo o proyección a partir de datos del sistema; puede variar.' },
  assumption: { label: 'Suposición', hint: 'Inferencia sin datos que la respalden; verifica antes de decidir.' },
};

const LINE_RE = /(?:^|\n)[ \t]*(?:[*_]{0,2})confianza(?:[*_]{0,2})[ \t]*:[ \t]*(?:[*_]{0,2})[ \t]*([^\n]*)$/i;

function levelFromText(text: string): ConfidenceLevel | null {
  const t = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  if (/verific|dato(s)? exact|confirmad|sistema/.test(t)) return 'verified';
  if (/estim|aprox|proyecc|calcul|parcial/.test(t)) return 'estimate';
  if (/supos|supuest|inferenc|creo|probable|sin datos|no verific/.test(t)) return 'assumption';
  return null;
}

export interface ParsedConfidence {
  level: ConfidenceLevel | null;
  /** Free text after the label ("— datos de querySalesOrders"). */
  note: string | null;
  /** Content without the trailing confidence line. */
  content: string;
}

export function parseConfidence(content: string | null | undefined): ParsedConfidence {
  const text = (content ?? '').replace(/\s+$/, '');
  const match = LINE_RE.exec(text);
  if (!match) return { level: null, note: null, content: text };
  const value = match[1] ?? '';
  const level = levelFromText(value);
  if (!level) return { level: null, note: null, content: text };
  const stripped = text.slice(0, match.index).replace(/\s+$/, '');
  const note = value
    .replace(/[*_]+/g, '')
    .replace(/^(datos?\s+)?(verificad\w*|estimaci[oó]n|estimad\w*|suposici[oó]n|supuest\w*|inferencia)\s*/i, '')
    .replace(/^[\s—:-]+/, '')
    .trim();
  return { level, note: note.length > 0 ? note : null, content: stripped };
}

/**
 * When the model forgot the label, derive one from what happened in the turn:
 * successful data tools ⇒ verified; failed tools ⇒ estimate; nothing ⇒ null.
 */
export function inferConfidence(input: { parsed: ConfidenceLevel | null; dataToolsSucceeded: number; toolsFailed: number; hasNumbers: boolean }): ConfidenceLevel | null {
  if (input.parsed) return input.parsed;
  if (input.dataToolsSucceeded > 0 && input.toolsFailed === 0) return 'verified';
  if (input.dataToolsSucceeded > 0) return 'estimate';
  if (input.toolsFailed > 0 && input.hasNumbers) return 'assumption';
  return null;
}
