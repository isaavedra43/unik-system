'use client';

import React, { useCallback, useRef, useState } from 'react';
import { Paperclip, Send, X } from 'lucide-react';
import { VoiceDictationButton } from '@/components/voice/VoiceDictationButton';
import { TemplatePicker } from './TemplatePicker';
import { uploadFile, type UploadProgress } from '@/lib/upload-client';

interface PendingAttachment {
  localId: string;
  objectId: string | null;
  name: string;
  progress: number;
  error: string | null;
  abort: AbortController;
}

interface Props {
  conversationId: string;
  value: string;
  onChange: (value: string) => void;
  onSend: (body: string, mediaObjectIds: string[], templateKey?: string) => Promise<void>;
  disabled?: boolean;
  disabledReason?: string | null;
  /** When true, shows the WhatsApp template picker (Content SID). */
  showTemplatePicker?: boolean;
}

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,audio/*,video/mp4';

export function MessageComposer({
  conversationId,
  value,
  onChange,
  onSend,
  disabled,
  disabledReason,
  showTemplatePicker,
}: Props) {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [templateKey, setTemplateKey] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const uploading = attachments.some((a) => !a.objectId && !a.error);
  const canSend =
    !disabled &&
    !sending &&
    !uploading &&
    (value.trim().length > 0 || attachments.some((a) => a.objectId));

  const update = (localId: string, patch: Partial<PendingAttachment>) =>
    setAttachments((prev) => prev.map((a) => (a.localId === localId ? { ...a, ...patch } : a)));

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files)) {
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const abort = new AbortController();
      setAttachments((prev) => [
        ...prev,
        { localId, objectId: null, name: file.name, progress: 0, error: null, abort },
      ]);
      try {
        const result = await uploadFile(file, {
          target: { type: 'comm_conversation', id: conversationId },
          signal: abort.signal,
          onProgress: (p: UploadProgress) => update(localId, { progress: p.percent }),
        });
        update(localId, { objectId: result.objectId, progress: 100 });
      } catch (err) {
        update(localId, { error: err instanceof Error ? err.message : 'No se pudo subir' });
      }
    }
  };

  const remove = (localId: string) => {
    const item = attachments.find((a) => a.localId === localId);
    item?.abort.abort();
    setAttachments((prev) => prev.filter((a) => a.localId !== localId));
  };

  const insertAtCursor = useCallback((insertText: string) => {
    const ta = textarea.current;
    if (!ta) {
      onChange(value ? `${value} ${insertText}` : insertText);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const needsSpace = before.length > 0 && !before.endsWith(' ') && !insertText.startsWith(' ');
    const insert = (needsSpace ? ' ' : '') + insertText;
    const newValue = before + insert + after;
    onChange(newValue);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + insert.length;
      ta.setSelectionRange(pos, pos);
    });
  }, [value, onChange, textarea]);

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      await onSend(
        value,
        attachments.map((a) => a.objectId).filter((id): id is string => Boolean(id)),
        templateKey.trim() || undefined
      );
      setAttachments([]);
      setTemplateKey('');
      textarea.current?.focus();
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat-input-wrapper">
      {disabledReason && (
        <div className="assistant-admin-error" role="status" style={{ marginBottom: 8 }}>
          {disabledReason}
        </div>
      )}
      {attachments.length > 0 && (
        <div
          className="chat-input-attachments"
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}
        >
          {attachments.map((a) => (
            <div
              key={a.localId}
              className="chat-input-attachment-item"
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <span className="badge badge-weak">{a.name}</span>
              {a.error ? (
                <span className="badge badge-danger">{a.error}</span>
              ) : a.objectId ? (
                <span className="badge badge-success">Listo</span>
              ) : (
                <span className="badge badge-info">{a.progress}%</span>
              )}
              <button
                type="button"
                className="icon-btn"
                aria-label={`Quitar ${a.name}`}
                onClick={() => remove(a.localId)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {showTemplatePicker && (
        <div className="chat-input-template-row">
          <TemplatePicker
            value={templateKey}
            onChange={(sid, templateBody) => {
              setTemplateKey(sid);
              if (templateBody && !value.trim()) onChange(templateBody);
            }}
            onBodyChange={(b) => onChange(b)}
            currentBody={value}
            disabled={disabled || sending}
          />
        </div>
      )}
      <div className="chat-input-row">
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => addFiles(e.target.files)}
        />
        <button
          type="button"
          className="chat-input-btn"
          aria-label="Adjuntar archivo"
          title="Adjuntar imagen, PDF o audio (máx. 25 MB)"
          disabled={disabled || sending}
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip size={18} />
        </button>
        <textarea
          ref={textarea}
          className="chat-input-textarea"
          aria-label="Escribe un mensaje"
          placeholder={
            disabled
              ? 'No se puede enviar en este momento'
              : 'Escribe un mensaje… (Enter para enviar, Shift+Enter salto de línea)'
          }
          value={value}
          rows={1}
          disabled={disabled || sending}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <VoiceDictationButton
          onFinalTranscript={insertAtCursor}
          disabled={disabled || sending}
          iconSize={18}
        />
        <button
          type="button"
          className="chat-input-send"
          aria-label="Enviar mensaje"
          disabled={!canSend}
          onClick={() => void submit()}
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
