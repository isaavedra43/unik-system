'use client';

import '@/styles/operations/inventario.css';
import { useMemo } from 'react';
import { Printer } from 'lucide-react';
import { Alert, Button } from '@/components/ui/primitives';
import { encodeQr, qrPath } from './qr-code';

/**
 * Printable labels of a warehouse (plan 7.6): a QR with the payload
 * `resolveScan` understands (`unik:loc:<id>`, `unik:stock:<id>`) plus the human
 * code, so a phone can scan it and a person can read it.
 *
 * The QR is drawn as a single SVG path (no image, no dependency), so it prints
 * crisply at any size. A payload that cannot be encoded shows its text instead
 * of a symbol nobody could scan.
 */

export interface LabelSheetItem {
  id: string;
  code: string;
  qr: string;
  title: string;
  subtitle: string;
  lines: string[];
}

export interface LabelSheetProps {
  labels: LabelSheetItem[];
  /** Sentence shown when the warehouse has nothing to print. */
  emptyText: string;
}

function QrTag({ payload, code }: { payload: string; code: string }) {
  const symbol = useMemo(() => encodeQr(payload), [payload]);
  if (!symbol) {
    return (
      <span className="inv-label-fallback" role="img" aria-label={`Código ${code}`}>
        {payload}
      </span>
    );
  }
  return (
    <svg
      className="inv-label-qr"
      viewBox={`-1 -1 ${symbol.size + 2} ${symbol.size + 2}`}
      role="img"
      aria-label={`Código QR de ${code}`}
      shapeRendering="crispEdges"
    >
      <rect x={-1} y={-1} width={symbol.size + 2} height={symbol.size + 2} fill="transparent" />
      <path d={qrPath(symbol)} fill="currentColor" />
    </svg>
  );
}

export function LabelSheet({ labels, emptyText }: LabelSheetProps) {
  if (labels.length === 0) {
    return <Alert variant="info">{emptyText}</Alert>;
  }

  return (
    <div className="inv-card">
      <div className="inv-card-title inv-no-print">
        <span>
          {labels.length === 1 ? '1 etiqueta lista' : `${labels.length} etiquetas listas`}
        </span>
        <Button variant="secondary" size="sm" onClick={() => window.print()}>
          <Printer size={14} aria-hidden="true" />
          Imprimir
        </Button>
      </div>
      <div className="inv-labels">
        {labels.map((label) => (
          <article key={label.id} className="inv-label">
            <QrTag payload={label.qr} code={label.code} />
            <div className="inv-label-body">
              <span className="inv-label-code">{label.code}</span>
              <span className="inv-label-title">{label.title}</span>
              {label.subtitle ? <span className="inv-label-line">{label.subtitle}</span> : null}
              {label.lines.map((line) => (
                <span key={line} className="inv-label-line">
                  {line}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
