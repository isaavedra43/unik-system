'use client';

import React, { useState } from 'react';
import { Copy, Headphones, Info } from 'lucide-react';
import type { IssuedToken } from '@/modules/voice/livekit-service';

/**
 * Stand-in for the WebRTC room while `livekit-client` is not installed.
 * Shows the room, identity and grants of the issued token so an external
 * client (LiveKit Meet, a LiveKit Agents worker or the SDK once installed)
 * can join with it. The token is a credential: it is never logged and only
 * copied on explicit user action.
 */
export function CallRoomPlaceholder({ token }: { token: IssuedToken | null }) {
  const [copied, setCopied] = useState(false);
  if (!token) {
    return (
      <div className="card card-compact" role="status">
        <div className="card-header">
          <h3 className="card-title">Sala de audio</h3>
        </div>
        <p className="text-muted">Únete a la llamada para obtener el token de la sala.</p>
      </div>
    );
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(token!.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="card card-compact">
      <div className="card-header">
        <h3 className="card-title">
          <Headphones size={16} aria-hidden="true" /> Sala de audio
        </h3>
        <span className={`badge ${token.mock ? 'badge-warning' : 'badge-info'}`}>
          {token.mock ? 'Modo simulado' : 'LiveKit'}
        </span>
      </div>
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '0.25rem 0.75rem',
          margin: 0,
        }}
      >
        <dt className="text-muted">Sala</dt>
        <dd style={{ margin: 0 }}>{token.roomName}</dd>
        <dt className="text-muted">Identidad</dt>
        <dd style={{ margin: 0 }}>{token.identity}</dd>
        <dt className="text-muted">Rol</dt>
        <dd style={{ margin: 0 }}>{token.role}</dd>
        <dt className="text-muted">Permisos</dt>
        <dd style={{ margin: 0 }}>
          {token.grants.canPublish ? 'publica' : 'no publica'} ·{' '}
          {token.grants.canSubscribe ? 'escucha' : 'no escucha'}
          {token.grants.hidden ? ' · oculto' : ''}
        </dd>
        {token.url ? (
          <>
            <dt className="text-muted">Servidor</dt>
            <dd style={{ margin: 0 }}>{token.url}</dd>
          </>
        ) : null}
      </dl>
      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          alignItems: 'center',
          marginTop: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={copy}
          aria-label="Copiar token de la sala"
        >
          <Copy size={14} aria-hidden="true" /> {copied ? 'Copiado' : 'Copiar token'}
        </button>
        <span
          className="text-muted"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.25rem',
            fontSize: '0.75rem',
          }}
        >
          <Info size={14} aria-hidden="true" />
          La conexión WebRTC desde el navegador requiere instalar <code>livekit-client</code>;
          mientras tanto usa este token en un cliente LiveKit.
        </span>
      </div>
    </div>
  );
}
