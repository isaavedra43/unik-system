'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Send } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A live frame of the agent's browser or of the virtual desktop. In control
 * mode the user clicks, scrolls and types on it: coordinates are mapped from
 * the drawn image (object-fit: contain) to the real viewport / screen size.
 */

export interface ScreenInput {
  onClick: (
    x: number,
    y: number,
    opts: { button: 'left' | 'right'; clickCount: number }
  ) => unknown;
  onType: (text: string) => unknown;
  onKey: (key: string) => unknown;
  onWheel: (deltaX: number, deltaY: number) => unknown;
}

const SPECIAL_KEYS = new Set([
  'Enter',
  'Backspace',
  'Tab',
  'Escape',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

export function LiveScreen({
  frame,
  alt,
  width,
  height,
  control,
  input,
  desktop = false,
  top,
  children,
}: {
  frame?: string | null;
  alt: string;
  /** Coordinate space of the target (viewport or screen). */
  width?: number | null;
  height?: number | null;
  control: boolean;
  input?: ScreenInput;
  desktop?: boolean;
  /** Overlay row on top of the frame (badges, actions). */
  top?: React.ReactNode;
  /** State screens (off, booting, paused) drawn over the frame area. */
  children?: React.ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number }>>([]);
  const [typing, setTyping] = useState('');
  const [showTyper, setShowTyper] = useState(false);
  const buffer = useRef('');
  const flushTimer = useRef<number | null>(null);
  const wheelAcc = useRef({ x: 0, y: 0 });
  const wheelTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (flushTimer.current) window.clearTimeout(flushTimer.current);
      if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
    },
    []
  );

  /** Client point → target coordinates (null when outside the drawn image). */
  const mapPoint = useCallback(
    (clientX: number, clientY: number): { x: number; y: number; px: number; py: number } | null => {
      const img = imgRef.current;
      const box = boxRef.current;
      if (!img || !box || !img.naturalWidth) return null;
      const rect = img.getBoundingClientRect();
      const scale = Math.min(rect.width / img.naturalWidth, rect.height / img.naturalHeight);
      const drawnW = img.naturalWidth * scale;
      const drawnH = img.naturalHeight * scale;
      const offX = (rect.width - drawnW) / 2;
      const offY = (rect.height - drawnH) / 2;
      const rx = clientX - rect.left - offX;
      const ry = clientY - rect.top - offY;
      if (rx < 0 || ry < 0 || rx > drawnW || ry > drawnH) return null;
      const tw = width || img.naturalWidth;
      const th = height || img.naturalHeight;
      const boxRect = box.getBoundingClientRect();
      return {
        x: Math.round((rx / drawnW) * tw),
        y: Math.round((ry / drawnH) * th),
        px: clientX - boxRect.left,
        py: clientY - boxRect.top,
      };
    },
    [width, height]
  );

  const flushTyping = useCallback(() => {
    const text = buffer.current;
    buffer.current = '';
    if (text && input) void input.onType(text);
  }, [input]);

  const onPointer = (e: React.MouseEvent, button: 'left' | 'right', clickCount = 1) => {
    if (!control || !input) return;
    e.preventDefault();
    const p = mapPoint(e.clientX, e.clientY);
    if (!p) return;
    boxRef.current?.focus();
    flushTyping();
    const id = Date.now() + Math.random();
    setRipples((r) => [...r, { id, x: p.px, y: p.py }]);
    window.setTimeout(() => setRipples((r) => r.filter((x) => x.id !== id)), 650);
    void input.onClick(p.x, p.y, { button, clickCount });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!control || !input) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (SPECIAL_KEYS.has(e.key)) {
      e.preventDefault();
      flushTyping();
      void input.onKey(e.key);
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      buffer.current += e.key;
      if (flushTimer.current) window.clearTimeout(flushTimer.current);
      flushTimer.current = window.setTimeout(flushTyping, 380);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!control || !input) return;
    wheelAcc.current.x += e.deltaX;
    wheelAcc.current.y += e.deltaY;
    if (wheelTimer.current) return;
    wheelTimer.current = window.setTimeout(() => {
      const { x, y } = wheelAcc.current;
      wheelAcc.current = { x: 0, y: 0 };
      wheelTimer.current = null;
      if (Math.abs(x) + Math.abs(y) > 2) void input.onWheel(Math.round(x), Math.round(y));
    }, 400);
  };

  return (
    <div
      ref={boxRef}
      className={cn('uv-screen', desktop && 'is-desktop', control && 'is-control')}
      tabIndex={control ? 0 : -1}
      role={control ? 'application' : undefined}
      aria-label={
        control ? `${alt} — control manual activo: haz clic y escribe sobre la pantalla` : alt
      }
      onKeyDown={onKeyDown}
      onWheel={onWheel}
    >
      {frame && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imgRef}
          src={frame}
          alt={alt}
          draggable={false}
          onClick={(e) => onPointer(e, 'left', e.detail >= 2 ? 2 : 1)}
          onContextMenu={(e) => onPointer(e, 'right')}
        />
      )}
      {ripples.map((r) => (
        <span key={r.id} className="uv-screen-ripple" style={{ left: r.x, top: r.y }} />
      ))}
      {top && <div className="uv-screen-top">{top}</div>}
      {control && input && (
        <>
          {!showTyper && (
            <button
              type="button"
              className="uv-screen-typer-toggle"
              onClick={() => setShowTyper(true)}
              aria-label="Escribir texto"
            >
              <Keyboard size={14} /> Escribir
            </button>
          )}
          {showTyper && (
            <form
              className="uv-screen-type"
              onSubmit={(e) => {
                e.preventDefault();
                if (!typing) return;
                void input.onType(typing);
                setTyping('');
              }}
            >
              <input
                value={typing}
                autoFocus
                onChange={(e) => setTyping(e.target.value)}
                placeholder="Texto para escribir donde está el cursor"
                aria-label="Texto para escribir en la pantalla"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setShowTyper(false);
                }}
              />
              <button type="submit" aria-label="Escribir">
                <Send size={13} />
              </button>
              <button type="button" onClick={() => void input.onKey('Enter')}>
                Enter
              </button>
            </form>
          )}
        </>
      )}
      {children}
    </div>
  );
}
