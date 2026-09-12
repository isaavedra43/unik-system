'use client';

import { useState } from 'react';
import { FlaskConical } from 'lucide-react';

/**
 * Local-only helper visible to super_admin in development: fills every
 * module with fake demo data (or wipes it) so the frontend can be reviewed
 * screen by screen without a live Zoho connection. The API route this calls
 * is hard-disabled in production regardless of who renders this button.
 */
export function SeedDemoDataButton() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function call(method: 'POST' | 'DELETE') {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/internal/dev/seed-demo-data', { method });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(json.error ?? 'Error al ejecutar el seed');
        return;
      }
      setMessage(method === 'POST' ? 'Datos demo creados. Recargando…' : 'Datos demo eliminados. Recargando…');
      setTimeout(() => window.location.reload(), 600);
    } catch {
      setMessage('Error de red al ejecutar el seed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <button
        type="button"
        onClick={() => call('POST')}
        disabled={busy}
        title="Pintar datos de prueba en todos los módulos (solo local)"
        aria-label="Pintar datos de prueba"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          borderRadius: 8,
          border: '1px solid var(--unik-border, #e5e7eb)',
          background: 'var(--unik-warning-bg, #fef3c7)',
          color: 'var(--unik-warning-text, #92400e)',
          fontSize: 12,
          fontWeight: 600,
          cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.6 : 1,
        }}
      >
        <FlaskConical size={14} />
        {busy ? 'Sembrando…' : 'Datos demo'}
      </button>
      <button
        type="button"
        onClick={() => call('DELETE')}
        disabled={busy}
        title="Borrar los datos de prueba (solo local)"
        aria-label="Borrar datos de prueba"
        style={{
          marginLeft: 4,
          padding: '6px 8px',
          borderRadius: 8,
          border: '1px solid var(--unik-border, #e5e7eb)',
          background: 'transparent',
          color: 'var(--unik-text-muted, #6b7280)',
          fontSize: 12,
          cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.6 : 1,
        }}
      >
        ✕
      </button>
      {message ? (
        <div
          role="status"
          style={{
            position: 'absolute',
            top: '110%',
            right: 0,
            whiteSpace: 'nowrap',
            background: 'var(--unik-surface, #111827)',
            color: 'var(--unik-surface-text, #fff)',
            padding: '6px 10px',
            borderRadius: 6,
            fontSize: 12,
            zIndex: 60,
          }}
        >
          {message}
        </div>
      ) : null}
    </div>
  );
}
