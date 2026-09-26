'use client';

import React, { useRef, useState, useEffect, useCallback } from 'react';
import {
  ArrowUp,
  AudioLines,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Square,
  X,
} from 'lucide-react';
import { ToolsButton } from './ToolsButton';
import { VoiceDictationButton } from '@/components/voice/VoiceDictationButton';
import { uploadFile, UploadError } from '@/lib/upload-client';

/** A file the user attached: only its id travels to the server when sending. */
export interface AttachmentDraft {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

interface UploadingDraft {
  key: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  percent: number;
  phase: string;
  controller: AbortController;
}

export interface AssistantInputProps {
  onSend: (message: string, attachments: AttachmentDraft[]) => void;
  /** Stops the current answer (keeps whatever the server persists). */
  onStop?: () => void;
  disabled?: boolean;
  streaming?: boolean;
  maxLength?: number;
  placeholder?: string;
  conversationId?: string | null;
  canUpload?: boolean;
  canUseVoice?: boolean;
  onVoiceOpen?: () => void;
  /** Extra controls in the bar: mode pills (left) and model picker (right). */
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  /** Text set from outside (quick actions, "retry"). Consumed once. */
  draft?: { text: string; at: number } | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function AssistantInput({
  onSend,
  onStop,
  disabled,
  streaming,
  maxLength = 10_000,
  placeholder = 'Escribe un mensaje o pide una misión…',
  conversationId,
  canUpload = false,
  canUseVoice = false,
  onVoiceOpen,
  leading,
  trailing,
  draft,
}: AssistantInputProps) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [uploads, setUploads] = useState<UploadingDraft[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploading = uploads.length > 0;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [value]);

  // External drafts (quick actions from the workspace, retry from an error).
  useEffect(() => {
    if (!draft?.text) return;
    setValue(draft.text);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [draft]);

  const canSend =
    (value.trim().length > 0 || attachments.length > 0) && !disabled && !streaming && !uploading;

  function handleSend() {
    if (!canSend) return;
    onSend(value.trim() || 'Analiza los archivos adjuntos', attachments);
    setValue('');
    setAttachments([]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    if (!conversationId) {
      setUploadError('Inicia una conversación primero');
      return;
    }

    setUploadError(null);
    const selected = Array.from(files);
    if (fileInputRef.current) fileInputRef.current.value = '';

    // Direct-to-storage upload: the browser only receives short-lived per-part
    // authorizations; the server validates the real format before "ready".
    await Promise.all(
      selected.map(async (file) => {
        const key = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const controller = new AbortController();
        setUploads((prev) => [
          ...prev,
          {
            key,
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            sizeBytes: file.size,
            percent: 0,
            phase: 'initiating',
            controller,
          },
        ]);
        try {
          const result = await uploadFile(file, {
            target: { type: 'ai_conversation', id: conversationId },
            signal: controller.signal,
            onProgress: (p) =>
              setUploads((prev) =>
                prev.map((u) => (u.key === key ? { ...u, percent: p.percent, phase: p.phase } : u))
              ),
          });
          if (result.referenceId) {
            setAttachments((prev) => [
              ...prev,
              {
                id: result.referenceId as string,
                fileName: result.fileName,
                mimeType: result.mimeType,
                sizeBytes: result.sizeBytes,
              },
            ]);
          }
        } catch (err) {
          if (!(err instanceof UploadError && err.code === 'aborted')) {
            setUploadError(err instanceof Error ? err.message : 'Error al subir archivo');
          }
        } finally {
          setUploads((prev) => prev.filter((u) => u.key !== key));
        }
      })
    );
  }

  function cancelUpload(key: string) {
    setUploads((prev) => {
      prev.find((u) => u.key === key)?.controller.abort();
      return prev;
    });
  }

  function removeAttachment(id: string) {
    fetch(`/app/assistant/api/attachments/${id}?conversationId=${conversationId}`, {
      method: 'DELETE',
    }).catch(() => {});
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  const insertAtCursor = useCallback(
    (text: string) => {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((prev) => (prev ? `${prev} ${text}` : text));
        return;
      }
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const before = value.slice(0, start);
      const after = value.slice(end);
      const needsSpace = before.length > 0 && !before.endsWith(' ') && !text.startsWith(' ');
      const insert = (needsSpace ? ' ' : '') + text;
      setValue(before + insert + after);
      requestAnimationFrame(() => {
        ta.focus();
        const pos = start + insert.length;
        ta.setSelectionRange(pos, pos);
      });
    },
    [value]
  );

  // Drag & drop files onto the composer.
  const [dragOver, setDragOver] = useState(false);
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (!canUpload || !fileInputRef.current) return;
    const dt = e.dataTransfer;
    if (!dt?.files?.length) return;
    fileInputRef.current.files = dt.files;
    fileInputRef.current.dispatchEvent(new Event('change', { bubbles: true }));
  }

  return (
    <div
      className="uv-composer"
      onDragOver={(e) => {
        if (!canUpload) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      style={
        dragOver
          ? { boxShadow: 'var(--uv-composer-ring-focus), var(--uv-composer-shadow)' }
          : undefined
      }
    >
      {(uploads.length > 0 || attachments.length > 0) && (
        <div className="uv-composer-attachments" aria-live="polite">
          {uploads.map((u) => (
            <span key={u.key} className="uv-att">
              <span className="spinner" aria-hidden="true" />
              <span className="uv-att-name" title={u.fileName}>
                {u.fileName}
              </span>
              <span className="uv-att-progress" aria-hidden="true">
                <i style={{ width: `${u.percent}%` }} />
              </span>
              <span className="uv-att-size">
                {u.phase === 'validating' ? 'Validando…' : `${u.percent}%`}
              </span>
              <button
                type="button"
                onClick={() => cancelUpload(u.key)}
                aria-label={`Cancelar subida de ${u.fileName}`}
              >
                <X size={13} />
              </button>
            </span>
          ))}
          {attachments.map((att) => (
            <span key={att.id} className="uv-att">
              {att.mimeType.startsWith('image/') ? <ImageIcon size={13} /> : <FileText size={13} />}
              <span className="uv-att-name" title={att.fileName}>
                {att.fileName}
              </span>
              <span className="uv-att-size">{formatSize(att.sizeBytes)}</span>
              <button
                type="button"
                onClick={() => removeAttachment(att.id)}
                aria-label={`Quitar ${att.fileName}`}
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}

      {uploadError && (
        <div className="uv-composer-error" role="alert">
          {uploadError}
          <button type="button" onClick={() => setUploadError(null)} aria-label="Cerrar">
            <X size={13} />
          </button>
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value.slice(0, maxLength))}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        aria-label="Mensaje al asistente"
      />

      <div className="uv-composer-bar">
        <div className="uv-composer-left">
          {canUpload && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,text/markdown,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,audio/*,video/mp4,video/webm"
                onChange={handleFileSelect}
                style={{ display: 'none' }}
                aria-label="Adjuntar archivos"
              />
              <button
                type="button"
                className="uv-tool-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || streaming || uploading}
                aria-label="Adjuntar archivos"
                title="Adjuntar imagen, PDF, documento o audio"
              >
                {uploading ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <Paperclip size={17} />
                )}
              </button>
            </>
          )}
          <ToolsButton
            disabled={disabled || streaming}
            onSelect={(name, desc) => {
              setValue(`Usa el tool "${name}" para: ${desc.split('.')[0].toLowerCase()}`);
              textareaRef.current?.focus();
            }}
          />
          <VoiceDictationButton
            onFinalTranscript={insertAtCursor}
            disabled={disabled || streaming}
            iconSize={17}
          />
          {canUseVoice && (
            <button
              type="button"
              className="uv-tool-btn"
              onClick={onVoiceOpen}
              disabled={disabled || streaming}
              aria-label="Modo de voz"
              title="Conversación por voz"
            >
              <AudioLines size={17} />
            </button>
          )}
          {leading}
        </div>
        <div className="uv-composer-right">
          {maxLength > 0 && value.length > maxLength * 0.8 && (
            <span className="uv-counter">
              {value.length}/{maxLength}
            </span>
          )}
          {trailing}
          {streaming && onStop ? (
            <button
              type="button"
              className="uv-send is-stop"
              onClick={onStop}
              aria-label="Detener respuesta"
              title="Detener"
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className="uv-send"
              onClick={handleSend}
              disabled={!canSend}
              aria-label="Enviar mensaje"
            >
              {streaming ? (
                <span className="spinner" aria-hidden="true" />
              ) : (
                <ArrowUp size={18} strokeWidth={2.4} />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
