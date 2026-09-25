'use client';

import React, { useMemo } from 'react';

export const PERSONALIZATION_VARS = [
  { key: 'nombre', sample: 'María García' },
  { key: 'primer_nombre', sample: 'María' },
  { key: 'telefono', sample: '5215512345678' },
  { key: 'email', sample: 'maria@ejemplo.com' },
] as const;

const VAR_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export function splitByVariables(body: string): Array<{ text: string; variable?: string }> {
  const parts: Array<{ text: string; variable?: string }> = [];
  let last = 0;
  for (const m of body.matchAll(VAR_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push({ text: body.slice(last, idx) });
    parts.push({ text: m[0], variable: m[1] });
    last = idx + m[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last) });
  return parts;
}

export function renderWithVariables(
  body: string,
  variables: Record<string, string>,
  personalization?: Record<string, string>
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const samples =
    personalization ?? Object.fromEntries(PERSONALIZATION_VARS.map((v) => [v.key, v.sample]));
  const text = body.replace(VAR_RE, (_, key: string) => {
    const k = key.trim();
    if (k in variables) return variables[k];
    if (k in samples) return samples[k];
    if (!missing.includes(k)) missing.push(k);
    return '';
  });
  return { text, missing };
}

/** Rough SMS segment estimation: GSM-7 → 160/153, otherwise UCS-2 → 70/67. */
export function smsSegments(text: string): {
  segments: number;
  perSegment: number;
  charset: 'GSM-7' | 'UCS-2';
} {
  const gsm =
    /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\\[~\]€|]*$/;
  const ucs2 = !gsm.test(text);
  const per = ucs2 ? (text.length > 70 ? 67 : 70) : text.length > 160 ? 153 : 160;
  return {
    segments: Math.max(1, Math.ceil(text.length / per)),
    perSegment: per,
    charset: ucs2 ? 'UCS-2' : 'GSM-7',
  };
}

/**
 * Channel-styled message preview. `mode="highlight"` shows {{var}} chips inline
 * for editing; `mode="render"` substitutes variables like production does.
 */
export function MessageBubble({
  body,
  channel,
  mode = 'render',
  variables = {},
  timestamp,
}: {
  body: string;
  channel: 'whatsapp' | 'sms' | 'telegram';
  mode?: 'render' | 'highlight';
  variables?: Record<string, string>;
  timestamp?: string;
}) {
  const rendered = useMemo(() => {
    if (mode === 'highlight') return null;
    return renderWithVariables(body, variables);
  }, [body, mode, variables]);

  return (
    <div className={`camp-bubble camp-bubble-${channel}`} data-mode={mode}>
      <div className="camp-bubble-text">
        {mode === 'highlight'
          ? splitByVariables(body).map((p, i) =>
              p.variable ? (
                <code key={i} className="camp-var-chip">{`{{${p.variable}}}`}</code>
              ) : (
                <React.Fragment key={i}>{p.text}</React.Fragment>
              )
            )
          : rendered?.text}
      </div>
      <div className="camp-bubble-meta">
        <span>
          {timestamp ??
            new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })}
        </span>
        {channel === 'whatsapp' ? (
          <svg
            width="16"
            height="11"
            viewBox="0 0 16 11"
            aria-hidden="true"
            className="camp-bubble-ticks"
          >
            <path
              d="M11.07.65l-3.9 4.6-1.4-1.5-.8.8 2.2 2.3L11.9 1.45l-.83-.8zM15.1.65l-3.9 4.6-.4-.4-.85.8 1.25 1.3L15.93 1.45 15.1.65zM1.8 5.25l-.8.8 2.2 2.3.83-.8-2.23-2.3z"
              fill="currentColor"
            />
          </svg>
        ) : null}
      </div>
      {mode === 'render' && rendered && rendered.missing.length > 0 ? (
        <div className="camp-bubble-missing">Sin valor: {rendered.missing.join(', ')}</div>
      ) : null}
    </div>
  );
}
