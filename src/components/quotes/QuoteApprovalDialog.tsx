'use client';

import React, { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Modal } from '@/components/ui/composite';
import { money, type QuoteDTO } from './quotes-client';

/**
 * Explicit human confirmation before creating the official estimate. Shows
 * exactly what will be approved (customer, total, version, content hash)
 * and whether Books runs in mock or real mode.
 */
export function QuoteApprovalDialog({
  quote,
  mock,
  open,
  busy,
  onClose,
  onConfirm,
}: {
  quote: QuoteDTO;
  mock: boolean;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: (expectedContentHash: string) => void;
}) {
  const [ack, setAck] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Aprobar cotización oficial"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!ack || busy || !quote.contentHash}
            onClick={() => quote.contentHash && onConfirm(quote.contentHash)}
          >
            <ShieldCheck size={16} />{' '}
            {busy ? 'Creando en Books…' : mock ? 'Aprobar (simulado)' : 'Aprobar y crear en Books'}
          </button>
        </>
      }
    >
      <div className={`alert ${mock ? 'alert-warning' : 'alert-info'}`} role="status">
        {mock
          ? 'Zoho Books está en modo SIMULADO: se generará un identificador de prueba, no una cotización real.'
          : 'Se creará una cotización REAL en Zoho Books con el contenido exacto mostrado abajo.'}
      </div>
      <dl className="assistant-admin-config-grid" style={{ marginTop: '0.75rem' }}>
        <div className="assistant-admin-config-field">
          <dt className="assistant-admin-muted">Cliente</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{quote.customerName}</dd>
        </div>
        <div className="assistant-admin-config-field">
          <dt className="assistant-admin-muted">Total</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>{money(quote.total, quote.currency)}</dd>
        </div>
        <div className="assistant-admin-config-field">
          <dt className="assistant-admin-muted">Partidas / versión</dt>
          <dd style={{ margin: 0 }}>
            {quote.items.length} partidas · v{quote.version}
          </dd>
        </div>
        <div className="assistant-admin-config-field">
          <dt className="assistant-admin-muted">Hash de contenido</dt>
          <dd style={{ margin: 0, fontFamily: 'monospace' }}>{quote.contentHash?.slice(0, 16)}…</dd>
        </div>
      </dl>
      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.75rem' }}>
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        Revisé cliente, partidas y total; autorizo crear la cotización oficial.
      </label>
    </Modal>
  );
}
