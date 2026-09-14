'use client';

import React, { useState } from 'react';
import { Loader2, ThumbsDown, ThumbsUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MessageFeedbackData } from './copilot-types';

/**
 * 👍 / 👎 on an assistant message. A 👎 opens a one-line "¿qué faltó?" box.
 * Same endpoint for every surface (the message belongs to the user's thread).
 */
export function MessageFeedback({ messageId, initial, compact = false }: { messageId: string; initial?: MessageFeedbackData | null; compact?: boolean }) {
  const [rating, setRating] = useState<number | null>(initial?.rating ?? null);
  const [comment, setComment] = useState(initial?.comment ?? '');
  const [askComment, setAskComment] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  if (messageId.startsWith('temp-')) return null;

  const submit = async (next: 1 | -1 | null, text?: string) => {
    setBusy(true);
    setSaved(null);
    try {
      if (next === null) {
        await fetch(`/app/assistant/api/messages/${messageId}/feedback`, { method: 'DELETE' });
        setRating(null);
        setAskComment(false);
      } else {
        const res = await fetch(`/app/assistant/api/messages/${messageId}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rating: next, comment: text ?? null }),
        });
        if (!res.ok) throw new Error('No se pudo guardar');
        setRating(next);
        if (next === -1 && text === undefined) setAskComment(true);
        else {
          setAskComment(false);
          setSaved(next === 1 ? 'Gracias' : 'Anotado');
          setTimeout(() => setSaved(null), 1600);
        }
      }
    } catch {
      setSaved('Error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('msg-feedback', compact && 'is-compact')}>
      <button
        type="button"
        className={cn('msg-feedback-btn', rating === 1 && 'is-active is-up')}
        aria-label="Respuesta útil"
        aria-pressed={rating === 1}
        title="Útil"
        disabled={busy}
        onClick={() => submit(rating === 1 ? null : 1)}
      >
        <ThumbsUp size={13} />
      </button>
      <button
        type="button"
        className={cn('msg-feedback-btn', rating === -1 && 'is-active is-down')}
        aria-label="Respuesta no útil"
        aria-pressed={rating === -1}
        title="No útil"
        disabled={busy}
        onClick={() => submit(rating === -1 ? null : -1)}
      >
        <ThumbsDown size={13} />
      </button>
      {busy && <Loader2 size={12} className="copilot-spin msg-feedback-spin" />}
      {saved && <span className="msg-feedback-saved">{saved}</span>}
      {askComment && (
        <form
          className="msg-feedback-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(-1, comment);
          }}
        >
          <input
            className="msg-feedback-input"
            value={comment}
            maxLength={1000}
            placeholder="¿Qué faltó o qué estuvo mal? (opcional)"
            onChange={(e) => setComment(e.target.value)}
            autoFocus
          />
          <button type="submit" className="msg-feedback-send" disabled={busy}>
            Enviar
          </button>
        </form>
      )}
    </div>
  );
}
