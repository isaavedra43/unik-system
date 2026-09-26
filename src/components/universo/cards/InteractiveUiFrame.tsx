'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppWindow, Check, ExternalLink, Maximize2, MessageSquare, X } from 'lucide-react';
import { safeHttpUrl } from '@/modules/ai/generative-ui/build-ui';

/**
 * Renders an agent-authored interface (renderInteractiveUi) inside an iframe:
 *  - `sandbox="allow-scripts allow-popups"` — opaque origin: no cookies, no
 *    storage, no DOM of UNIK; links may open a new tab only.
 *  - CSP inside the doc: `connect-src 'none'` + `form-action 'none'` — the UI
 *    cannot call home; only inline code and allowlisted CDN libraries load.
 *  - Bridge: `window.unik.prompt/openLink/copy` inside the iframe postMessage to
 *    here; anything user-facing is confirmed in UNIK's own bar first, then a
 *    prompt becomes a normal chat message (same approvals as everything else).
 */

const CDN_SRC =
  'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://cdn.tailwindcss.com';

const DOC_CSP = [
  `default-src 'none'`,
  `script-src 'unsafe-inline' ${CDN_SRC}`,
  `style-src 'unsafe-inline' ${CDN_SRC} https://fonts.googleapis.com`,
  `font-src https://fonts.gstatic.com ${CDN_SRC}`,
  `img-src data: https:`,
  `connect-src 'none'`,
  `form-action 'none'`,
  `base-uri 'none'`,
].join('; ');

/** Helpers exposed to the generated interface. */
const BRIDGE_JS = `
window.unik = {
  prompt: function (text) { window.parent.postMessage({ unikUi: { action: 'prompt', text: String(text).slice(0, 1000) } }, '*'); },
  openLink: function (url) { window.parent.postMessage({ unikUi: { action: 'openLink', url: String(url).slice(0, 2000) } }, '*'); },
  copy: function (text) { window.parent.postMessage({ unikUi: { action: 'copy', text: String(text).slice(0, 10000) } }, '*'); },
  resize: function (px) { window.parent.postMessage({ unikUi: { action: 'resize', height: Number(px) || 0 } }, '*'); }
};
`;

type Pending = { kind: 'prompt'; text: string } | { kind: 'link'; url: string };

function buildDoc(spec: { html: string; css?: string; js?: string }): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${DOC_CSP}"><style>html,body{margin:0;padding:0;font-family:system-ui,-apple-system,sans-serif;background:transparent;color-scheme:light}</style><style>${spec.css ?? ''}</style></head><body>${spec.html}<script>${BRIDGE_JS}</script>${spec.js ? `<script>${spec.js}</script>` : ''}</body></html>`;
}

export function InteractiveUiFrame({
  title,
  html,
  css,
  js,
  height,
  onSendText,
}: {
  title?: string;
  html: string;
  css?: string;
  js?: string;
  height?: number | null;
  onSendText?: (text: string) => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [frameHeight, setFrameHeight] = useState<number>(height ?? 360);
  const [expanded, setExpanded] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const srcDoc = useMemo(() => buildDoc({ html, css, js }), [html, css, js]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Opaque-origin iframe posts with origin 'null'; only accept our shape.
      if (e.origin !== 'null' || e.source !== frameRef.current?.contentWindow) return;
      const msg = (
        e.data as { unikUi?: { action?: string; text?: unknown; url?: unknown; height?: unknown } }
      )?.unikUi;
      if (!msg || typeof msg.action !== 'string') return;
      switch (msg.action) {
        case 'prompt': {
          const text = String(msg.text ?? '').trim();
          if (text) setPending({ kind: 'prompt', text });
          break;
        }
        case 'openLink': {
          const url = safeHttpUrl(String(msg.url ?? ''));
          if (url) setPending({ kind: 'link', url });
          break;
        }
        case 'copy': {
          const text = String(msg.text ?? '');
          if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
          break;
        }
        case 'resize': {
          const px = Number(msg.height);
          if (Number.isFinite(px)) setFrameHeight(Math.min(1200, Math.max(120, px)));
          break;
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const confirm = () => {
    if (!pending) return;
    if (pending.kind === 'link') window.open(pending.url, '_blank', 'noopener,noreferrer');
    else onSendText?.(pending.text);
    setPending(null);
  };

  return (
    <section className="uv-card" aria-label={title ?? 'Interfaz interactiva'}>
      <div className="uv-card-head">
        <span className="uv-card-icon">
          <AppWindow size={16} />
        </span>
        <span className="uv-card-title">
          <strong>{title ?? 'Interfaz interactiva'}</strong>
          <span>Aislada · sin acceso a UNIK</span>
        </span>
        <button
          type="button"
          className="uv-icon-btn is-sm"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Reducir' : 'Expandir'}
          aria-pressed={expanded}
        >
          <Maximize2 size={14} />
        </button>
      </div>
      <iframe
        ref={frameRef}
        title={title ?? 'Interfaz interactiva del asistente'}
        sandbox="allow-scripts allow-popups"
        srcDoc={srcDoc}
        style={{
          display: 'block',
          width: '100%',
          border: 0,
          borderTop: '1px solid var(--uv-line)',
          background: 'var(--unik-surface)',
          height: expanded ? Math.min(1200, Math.max(480, frameHeight)) : frameHeight,
        }}
      />
      {pending && (
        <div className="uv-card-foot" role="alert">
          <span
            className="uv-grow"
            style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}
          >
            {pending.kind === 'prompt' ? (
              <>
                <MessageSquare size={13} /> La interfaz quiere enviar: «{pending.text.slice(0, 120)}
                »
              </>
            ) : (
              <>
                <ExternalLink size={13} /> La interfaz quiere abrir <b>{pending.url}</b>
              </>
            )}
          </span>
          <button type="button" className="uv-btn is-primary is-sm" onClick={confirm}>
            <Check size={13} /> {pending.kind === 'prompt' ? 'Enviar' : 'Abrir'}
          </button>
          <button type="button" className="uv-btn is-ghost is-sm" onClick={() => setPending(null)}>
            <X size={13} /> Descartar
          </button>
        </div>
      )}
    </section>
  );
}

export default InteractiveUiFrame;
