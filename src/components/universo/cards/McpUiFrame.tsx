'use client';

import React, { useState } from 'react';
import { UIResourceRenderer, type UIActionResult } from '@mcp-ui/client';
import { Check, ExternalLink, MessageSquare, Plug, X } from 'lucide-react';
import type { UiMcpResource } from '@/modules/ai/generative-ui/types';
import { safeHttpUrl } from '@/modules/ai/generative-ui/build-ui';

/**
 * Draws an MCP server's own `ui://` component with the official MCP-UI
 * renderer. Safety model:
 *  - HTML runs in an iframe with `sandbox="allow-scripts"` only (opaque origin:
 *    no cookies, storage, DOM or network identity of UNIK);
 *  - only `text/html` and https `text/uri-list` resources get here (see
 *    `extractMcpUiResources`);
 *  - the frame can ASK for things (send a prompt, open a link, call a tool) but
 *    nothing happens until the user confirms in UNIK's own UI, and tool requests
 *    become a normal chat message so they still go through approvals.
 */

type Pending =
  | { kind: 'prompt'; text: string }
  | { kind: 'link'; url: string }
  | { kind: 'tool'; text: string; label: string };

function toPending(result: UIActionResult): Pending | null {
  switch (result.type) {
    case 'prompt': {
      const text = String(result.payload?.prompt ?? '')
        .trim()
        .slice(0, 1000);
      return text ? { kind: 'prompt', text } : null;
    }
    case 'link': {
      const url = safeHttpUrl(result.payload?.url);
      return url ? { kind: 'link', url } : null;
    }
    case 'tool': {
      const name = String(result.payload?.toolName ?? '')
        .trim()
        .slice(0, 80);
      if (!name) return null;
      const params = JSON.stringify(result.payload?.params ?? {}).slice(0, 600);
      return {
        kind: 'tool',
        label: name,
        text: `Desde el componente que me mostraste pedí ejecutar la herramienta "${name}" con estos parámetros: ${params}. Hazlo con la herramienta correspondiente.`,
      };
    }
    default:
      return null;
  }
}

export function McpUiFrame({
  resource,
  title,
  onSendText,
}: {
  resource: UiMcpResource;
  title?: string;
  onSendText?: (text: string) => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);

  const handleAction = async (result: UIActionResult) => {
    const next = toPending(result);
    if (next) setPending(next);
    return { status: 'handled' };
  };

  const confirm = () => {
    if (!pending) return;
    if (pending.kind === 'link') window.open(pending.url, '_blank', 'noopener,noreferrer');
    else onSendText?.(pending.text);
    setPending(null);
  };

  return (
    <section className="uv-card" aria-label={title ?? 'Componente interactivo'}>
      <div className="uv-card-head">
        <span className="uv-card-icon">
          <Plug size={16} />
        </span>
        <span className="uv-card-title">
          <strong>{title ?? 'Componente interactivo'}</strong>
          <span>Aislado · sin acceso a UNIK</span>
        </span>
      </div>
      <div style={{ borderTop: '1px solid var(--uv-line)' }}>
        <UIResourceRenderer
          resource={{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }}
          supportedContentTypes={['rawHtml', 'externalUrl']}
          onUIAction={handleAction}
          htmlProps={{
            autoResizeIframe: { height: true },
            style: {
              width: '100%',
              minHeight: 120,
              maxHeight: 640,
              border: 0,
              background: 'transparent',
            },
            iframeProps: { title: title ?? 'Componente interactivo' },
          }}
        />
      </div>
      {pending && (
        <div className="uv-card-foot" role="alert">
          <span
            className="uv-grow"
            style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}
          >
            {pending.kind === 'link' ? <ExternalLink size={13} /> : <MessageSquare size={13} />}
            {pending.kind === 'link' && (
              <>
                El componente quiere abrir <b>{new URL(pending.url).hostname}</b>
              </>
            )}
            {pending.kind === 'prompt' && <>El componente quiere enviar: «{pending.text}»</>}
            {pending.kind === 'tool' && (
              <>
                El componente pide ejecutar <b>{pending.label}</b>
              </>
            )}
          </span>
          <button type="button" className="uv-btn is-primary is-sm" onClick={confirm}>
            <Check size={13} /> {pending.kind === 'link' ? 'Abrir' : 'Enviar'}
          </button>
          <button type="button" className="uv-btn is-ghost is-sm" onClick={() => setPending(null)}>
            <X size={13} /> Descartar
          </button>
        </div>
      )}
    </section>
  );
}

export default McpUiFrame;
