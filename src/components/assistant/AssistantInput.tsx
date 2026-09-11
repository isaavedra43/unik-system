'use client';

import React, { useRef, useState, useEffect } from 'react';
import { Send, Paperclip, X, FileText, Image as ImageIcon } from 'lucide-react';
import { ToolsButton } from './ToolsButton';

export interface AttachmentDraft {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
}

export interface AssistantInputProps {
  onSend: (message: string, attachments: AttachmentDraft[]) => void;
  disabled?: boolean;
  streaming?: boolean;
  maxLength?: number;
  placeholder?: string;
  conversationId?: string | null;
  canUpload?: boolean;
  canUseVoice?: boolean;
  onVoiceOpen?: () => void;
}

export function AssistantInput({
  onSend,
  disabled,
  streaming,
  maxLength = 10_000,
  placeholder = 'Escribe tu mensaje…',
  conversationId,
  canUpload = false,
  canUseVoice = false,
  onVoiceOpen,
}: AssistantInputProps) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !disabled && !streaming && !uploading;

  function handleSend() {
    if (!canSend) return;
    onSend(value.trim() || 'Analiza los archivos adjuntos', attachments);
    setValue('');
    setAttachments([]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
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

    setUploading(true);
    setUploadError(null);

    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('conversationId', conversationId);

        const res = await fetch('/app/assistant/api/upload', {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Error al subir archivo' }));
          throw new Error(err.error || 'Error al subir archivo');
        }

        const result = await res.json();
        setAttachments((prev) => [
          ...prev,
          {
            id: result.id,
            fileName: result.fileName,
            mimeType: result.mimeType,
            sizeBytes: result.sizeBytes,
            storagePath: result.storagePath,
          },
        ]);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Error al subir archivo');
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }

  function removeAttachment(id: string) {
    // Delete from server
    fetch(`/app/assistant/api/attachments/${id}?conversationId=${conversationId}`, {
      method: 'DELETE',
    }).catch(() => {});
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }

  function isImage(mimeType: string): boolean {
    return mimeType.startsWith('image/');
  }

  return (
    <div className="assistant-input-container">
      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="assistant-attachments-preview">
          {attachments.map((att) => (
            <div key={att.id} className="attachment-chip">
              {isImage(att.mimeType) ? (
                <ImageIcon size={14} className="attachment-chip-icon" />
              ) : (
                <FileText size={14} className="attachment-chip-icon" />
              )}
              <span className="attachment-chip-name" title={att.fileName}>
                {att.fileName}
              </span>
              <span className="attachment-chip-size">{formatSize(att.sizeBytes)}</span>
              <button
                type="button"
                className="attachment-chip-remove"
                onClick={() => removeAttachment(att.id)}
                aria-label={`Quitar ${att.fileName}`}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Upload error */}
      {uploadError && (
        <div className="assistant-upload-error">
          {uploadError}
          <button onClick={() => setUploadError(null)} aria-label="Cerrar">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="assistant-input">
        <textarea
          ref={textareaRef}
          className="assistant-input-textarea"
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, maxLength))}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          aria-label="Mensaje al asistente"
        />
        <div className="assistant-input-actions">
          <div className="assistant-input-actions-left">
            {canUseVoice && (
              <button
                type="button"
                className="voice-mode-btn"
                onClick={onVoiceOpen}
                disabled={disabled || streaming}
                aria-label="Asistente de voz"
                title="Asistente de voz conversacional"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                </svg>
              </button>
            )}
            {canUpload && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/png,image/jpeg,application/pdf,text/plain,text/csv"
                  onChange={handleFileSelect}
                  style={{ display: 'none' }}
                  aria-label="Adjuntar archivos"
                />
                <button
                  type="button"
                  className="assistant-input-attach"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={disabled || streaming || uploading}
                  aria-label="Adjuntar archivos"
                  title="Adjuntar imagen o PDF"
                >
                  {uploading ? (
                    <span className="spinner" aria-hidden="true" />
                  ) : (
                    <Paperclip size={18} />
                  )}
                </button>
              </>
            )}
            <ToolsButton
              disabled={disabled || streaming}
              onSelect={(name, desc) => {
                const prompt = `Usa el tool "${name}" para: ${desc.split('.')[0].toLowerCase()}`;
                setValue(prompt);
                textareaRef.current?.focus();
              }}
            />
          </div>
          <button
            type="button"
            className="assistant-input-send"
            onClick={handleSend}
            disabled={!canSend}
            aria-label="Enviar mensaje"
          >
            {streaming ? <span className="spinner" aria-hidden="true" /> : <Send size={18} />}
          </button>
        </div>
        {maxLength > 0 && value.length > maxLength * 0.8 && (
          <span className="assistant-input-counter">
            {value.length}/{maxLength}
          </span>
        )}
      </div>
    </div>
  );
}
