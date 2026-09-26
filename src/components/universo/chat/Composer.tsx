'use client';

import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
} from 'react';
import {
  ArrowUp,
  AudioLines,
  FileText,
  Flag,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Mic,
  Square,
  X,
} from 'lucide-react';
import { uploadFile, UploadError } from '@/lib/upload-client';
import { useVoiceDictation } from '@/lib/hooks/use-voice-dictation';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/shadcn/tooltip';
import { cn } from '@/lib/utils';
import type { AttachmentInfo } from '../lib/types';
import { formatBytes } from '../lib/format';
import { ModelPicker } from './ModelPicker';
import { PlusMenu } from './PlusMenu';

/**
 * The composer. Text grows with the content; files upload straight to storage
 * (drag & drop, paste or the "+" menu) and only their ids travel with the
 * message. Dictation, full voice mode, Misión/Mensaje and the model live in
 * the bottom bar; Enter sends, Shift+Enter breaks the line.
 */

export type ComposerMode = 'mission' | 'message';

export interface ComposerHandle {
  focus: () => void;
  setText: (text: string) => void;
}

interface Uploading {
  key: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  percent: number;
  phase: string;
  controller: AbortController;
}

const ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,text/markdown,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,audio/*,video/mp4,video/webm';

const MAX_LEN = 10_000;

export interface ComposerProps {
  onSend: (text: string, attachments: AttachmentInfo[]) => void;
  onStop?: () => void;
  streaming: boolean;
  disabled?: boolean;
  /** Creates the conversation lazily (files need one to attach to). */
  ensureConversation: () => Promise<string | null>;
  conversationId: string | null;
  canUpload: boolean;
  canUseVoice: boolean;
  onVoiceMode?: () => void;
  placeholder: string;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  model: string;
  onModelChange: (id: string) => void;
  onTeach?: () => void;
  autoFocus?: boolean;
  className?: string;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    onSend,
    onStop,
    streaming,
    disabled,
    ensureConversation,
    conversationId,
    canUpload,
    canUseVoice,
    onVoiceMode,
    placeholder,
    mode,
    onModeChange,
    model,
    onModelChange,
    onTeach,
    autoFocus,
    className,
  },
  ref
) {
  const [value, setValue] = useState('');
  const [files, setFiles] = useState<AttachmentInfo[]>([]);
  const [uploads, setUploads] = useState<Uploading[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploading = uploads.length > 0;

  useImperativeHandle(ref, () => ({
    focus: () => taRef.current?.focus(),
    setText: (text: string) => {
      setValue(text.slice(0, MAX_LEN));
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
    },
  }));

  // Grow with the content.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);

  // Files belong to a thread: switching threads clears the tray.
  useEffect(() => {
    setFiles([]);
    setNote(null);
  }, [conversationId]);

  const dictation = useVoiceDictation({
    onTranscript: (text, isFinal) => {
      if (!isFinal || !text.trim()) return;
      setValue((prev) => {
        const sep = prev && !prev.endsWith(' ') ? ' ' : '';
        return `${prev}${sep}${text.trim()}`.slice(0, MAX_LEN);
      });
    },
    onError: (err) =>
      setNote(
        err === 'not-allowed'
          ? 'Permite el micrófono en tu navegador para dictar.'
          : 'No se pudo usar el dictado.'
      ),
  });

  const canSend =
    (value.trim().length > 0 || files.length > 0) && !disabled && !streaming && !uploading;

  const send = () => {
    if (!canSend) return;
    if (dictation.isListening) dictation.stop();
    onSend(value.trim() || 'Analiza los archivos adjuntos', files);
    setValue('');
    setFiles([]);
  };

  const uploadMany = useCallback(
    async (list: File[]) => {
      if (list.length === 0) return;
      if (!canUpload) {
        setNote('Tu usuario no tiene permiso para adjuntar archivos.');
        return;
      }
      setNote(null);
      const convId = await ensureConversation();
      if (!convId) {
        setNote('No se pudo preparar la conversación para adjuntar.');
        return;
      }
      await Promise.all(
        list.map(async (file) => {
          const key = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const controller = new AbortController();
          setUploads((prev) => [
            ...prev,
            {
              key,
              fileName: file.name || 'archivo',
              mimeType: file.type || 'application/octet-stream',
              sizeBytes: file.size,
              percent: 0,
              phase: 'initiating',
              controller,
            },
          ]);
          try {
            const result = await uploadFile(file, {
              target: { type: 'ai_conversation', id: convId },
              signal: controller.signal,
              onProgress: (p) =>
                setUploads((prev) =>
                  prev.map((u) =>
                    u.key === key ? { ...u, percent: p.percent, phase: p.phase } : u
                  )
                ),
            });
            if (result.status === 'rejected') {
              setNote(result.rejectionReason ?? `No se aceptó ${file.name}.`);
            } else if (result.referenceId) {
              setFiles((prev) => [
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
              setNote(err instanceof Error ? err.message : 'No se pudo subir el archivo.');
            }
          } finally {
            setUploads((prev) => prev.filter((u) => u.key !== key));
          }
        })
      );
    },
    [canUpload, ensureConversation]
  );

  const removeFile = (id: string) => {
    if (conversationId) {
      fetch(
        `/app/assistant/api/attachments/${id}?conversationId=${encodeURIComponent(conversationId)}`,
        { method: 'DELETE' }
      ).catch(() => undefined);
    }
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  return (
    <div
      className={cn('uv-composer', drag && 'is-drop', className)}
      onDragOver={(e) => {
        if (!canUpload || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false);
      }}
      onDrop={(e) => {
        if (!canUpload) return;
        e.preventDefault();
        setDrag(false);
        void uploadMany(Array.from(e.dataTransfer.files ?? []));
      }}
    >
      {(uploads.length > 0 || files.length > 0) && (
        <div className="uv-composer-files" aria-live="polite">
          {uploads.map((u) => (
            <span key={u.key} className="uv-file-chip">
              <span className="uv-file-chip-icon">
                <Loader2 size={14} className="uv-spin" />
              </span>
              <span className="uv-file-chip-text">
                <span className="uv-file-chip-name" title={u.fileName}>
                  {u.fileName}
                </span>
                <span className="uv-file-chip-meta">
                  {u.phase === 'validating' ? 'Validando…' : `${u.percent}%`}
                </span>
                <span className="uv-upload-bar" aria-hidden="true">
                  <i style={{ width: `${u.percent}%` }} />
                </span>
              </span>
              <button
                type="button"
                className="uv-file-chip-x"
                onClick={() => u.controller.abort()}
                aria-label={`Cancelar ${u.fileName}`}
              >
                <X size={13} />
              </button>
            </span>
          ))}
          {files.map((f) => (
            <span key={f.id} className="uv-file-chip">
              <span className="uv-file-chip-icon">
                {f.mimeType.startsWith('image/') ? <ImageIcon size={14} /> : <FileText size={14} />}
              </span>
              <span className="uv-file-chip-text">
                <span className="uv-file-chip-name" title={f.fileName}>
                  {f.fileName}
                </span>
                <span className="uv-file-chip-meta">{formatBytes(f.sizeBytes)}</span>
              </span>
              <button
                type="button"
                className="uv-file-chip-x"
                onClick={() => removeFile(f.id)}
                aria-label={`Quitar ${f.fileName}`}
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}

      {note && (
        <div className="uv-composer-note" role="alert">
          {note}
          <button type="button" onClick={() => setNote(null)} aria-label="Cerrar aviso">
            <X size={13} />
          </button>
        </div>
      )}

      <textarea
        ref={taRef}
        value={value}
        rows={1}
        placeholder={drag ? 'Suelta los archivos para adjuntarlos' : placeholder}
        disabled={disabled}
        aria-label="Mensaje al agente"
        onChange={(e) => setValue(e.target.value.slice(0, MAX_LEN))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        onPaste={(e) => {
          const pasted = Array.from(e.clipboardData?.files ?? []);
          if (pasted.length > 0 && canUpload) {
            e.preventDefault();
            void uploadMany(pasted);
          }
        }}
      />
      {dictation.isListening && dictation.interimTranscript && (
        <div className="uv-interim">{dictation.interimTranscript}</div>
      )}

      <div className="uv-composer-bar">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            const list = Array.from(e.target.files ?? []);
            e.target.value = '';
            void uploadMany(list);
          }}
        />
        <PlusMenu
          canUpload={canUpload}
          disabled={disabled}
          onAttach={() => fileRef.current?.click()}
          onPrefill={(text) => {
            setValue((prev) => (prev.trim() ? `${text}${prev}` : text));
            requestAnimationFrame(() => {
              const ta = taRef.current;
              if (!ta) return;
              ta.focus();
              ta.setSelectionRange(ta.value.length, ta.value.length);
            });
          }}
          onTeach={onTeach}
        />
        <div className="uv-seg" role="radiogroup" aria-label="Cómo trabaja el agente">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'mission'}
                onClick={() => onModeChange('mission')}
              >
                <Flag size={13} />
                <span>Misión</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              Propone un plan y lo ejecuta paso a paso cuando lo apruebas
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'message'}
                onClick={() => onModeChange('message')}
              >
                <MessageSquare size={13} />
                <span>Directo</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs">
              Actúa y responde de inmediato
            </TooltipContent>
          </Tooltip>
        </div>
        <span className="uv-grow" />
        <ModelPicker value={model} onChange={onModelChange} disabled={disabled} />
        {dictation.isSupported && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn('uv-icon-btn uv-mic', dictation.isListening && 'is-listening')}
                onClick={dictation.toggle}
                disabled={disabled || streaming}
                aria-label={dictation.isListening ? 'Detener dictado' : 'Dictar'}
                aria-pressed={dictation.isListening}
              >
                <Mic size={17} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              {dictation.isListening ? 'Detener dictado' : 'Dictar'}
            </TooltipContent>
          </Tooltip>
        )}
        {canUseVoice && onVoiceMode && !value.trim() && !streaming ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="uv-send is-voice"
                onClick={onVoiceMode}
                disabled={disabled}
                aria-label="Conversar por voz"
              >
                <AudioLines size={17} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Conversar por voz</TooltipContent>
          </Tooltip>
        ) : streaming && onStop ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="uv-send is-stop"
                onClick={onStop}
                aria-label="Detener"
              >
                <Square size={13} fill="currentColor" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">Detener</TooltipContent>
          </Tooltip>
        ) : (
          <button
            type="button"
            className="uv-send"
            onClick={send}
            disabled={!canSend}
            aria-label="Enviar"
          >
            <ArrowUp size={18} strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  );
});
