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
  AlertCircle,
  ArrowUp,
  AudioLines,
  Clock,
  FileText,
  Flag,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Mic,
  RotateCw,
  Square,
  X,
} from 'lucide-react';
import { uploadFile, UploadError, type UploadProgress } from '@/lib/upload-client';
import { useVoiceDictation } from '@/lib/hooks/use-voice-dictation';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/shadcn/tooltip';
import { cn } from '@/lib/utils';
import type { AttachmentInfo } from '../lib/types';
import { formatBytes } from '../lib/format';
import { EffortPicker, type EffortValue } from './EffortPicker';
import { PlusMenu } from './PlusMenu';
import { CapabilityIcon, type PickedCapability } from './CapabilityMenu';

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
  /** Files dropped anywhere on the conversation. */
  addFiles: (files: File[]) => void;
}

/** One file in the tray: uploading, ready to travel with the message, or failed (retryable). */
interface TrayItem {
  key: string;
  file: File;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  state: 'queued' | 'uploading' | 'ready' | 'failed';
  percent: number;
  phase: UploadProgress['phase'] | 'queued';
  error?: string;
  /** AiAttachment id once the server accepted the file. */
  attachmentId?: string;
  /** Local thumbnail for images (object URL). */
  previewUrl?: string;
  conversationId?: string;
  controller?: AbortController;
}

/** Uploads at once; the rest wait their turn (each one already sends parts in parallel). */
const MAX_PARALLEL_UPLOADS = 3;
const PREVIEW_MAX_BYTES = 15 * 1024 * 1024;

function friendlyUploadError(err: unknown, fileName: string): string {
  const ext = fileName.includes('.') ? `.${fileName.split('.').pop()}` : 'este archivo';
  const msg = err instanceof Error ? err.message : '';
  if (/no permitido/i.test(msg)) return `No se aceptan archivos ${ext} aquí`;
  if (/demasiado grande/i.test(msg)) return msg;
  if (err instanceof UploadError && err.code === 'network')
    return 'Se cortó la conexión. Reintenta.';
  if (err instanceof UploadError && err.code === 'timeout')
    return 'La verificación tardó demasiado. Reintenta.';
  if (err instanceof UploadError && err.code === 'rejected')
    return msg || 'El archivo no pasó la verificación';
  return msg || 'No se pudo subir';
}

const ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,text/markdown,.txt,.csv,.md,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,audio/*,.m4a,.mp3,.wav,video/mp4,video/webm';

const MAX_LEN = 10_000;

export interface ComposerProps {
  /** `capabilities`: ids the user picked in the "+" menu for this message. */
  onSend: (text: string, attachments: AttachmentInfo[], capabilities: string[]) => void;
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
  effort: EffortValue;
  onEffortChange: (value: EffortValue) => void;
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
    effort,
    onEffortChange,
    onTeach,
    autoFocus,
    className,
  },
  ref
) {
  const [value, setValue] = useState('');
  const [items, setItems] = useState<TrayItem[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  /** Enter pressed while files were still uploading: sends as soon as they finish. */
  const [queued, setQueued] = useState(false);
  /** What the agent must use for the next message (internet, an MCP, a skill…). */
  const [picked, setPicked] = useState<PickedCapability[]>([]);
  const pickedRef = useRef<PickedCapability[]>([]);
  useEffect(() => {
    pickedRef.current = picked;
  }, [picked]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef<TrayItem[]>([]);
  const convRef = useRef<string | null>(conversationId);
  const slots = useRef({ active: 0, waiting: [] as Array<() => void> });

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const ready = items.filter((i) => i.state === 'ready');
  const busy = items.filter((i) => i.state === 'uploading' || i.state === 'queued');
  const failed = items.filter((i) => i.state === 'failed');

  const patch = useCallback((key: string, change: Partial<TrayItem>) => {
    setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...change } : i)));
  }, []);

  const drop = useCallback((key: string) => {
    const item = itemsRef.current.find((i) => i.key === key);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setItems((prev) => prev.filter((i) => i.key !== key));
  }, []);

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

  // Files belong to a thread. Switching threads cancels and clears the tray;
  // the thread this composer just created (null → id) keeps its uploads.
  useEffect(() => {
    const prev = convRef.current;
    convRef.current = conversationId;
    if (prev === null || prev === conversationId) return;
    for (const i of itemsRef.current) {
      i.controller?.abort();
      if (i.previewUrl) URL.revokeObjectURL(i.previewUrl);
    }
    setItems([]);
    setQueued(false);
    setNote(null);
  }, [conversationId]);

  // Unmount: stop uploads nobody will see.
  useEffect(
    () => () => {
      for (const i of itemsRef.current) i.controller?.abort();
    },
    []
  );

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

  const hasContent = value.trim().length > 0 || ready.length > 0 || busy.length > 0;
  const canSend = hasContent && !disabled && !streaming && failed.length === 0;

  const dispatch = useCallback(() => {
    const files = itemsRef.current.filter((i) => i.state === 'ready');
    const attachments: AttachmentInfo[] = files.map((i) => ({
      id: i.attachmentId as string,
      fileName: i.fileName,
      mimeType: i.mimeType,
      sizeBytes: i.sizeBytes,
      // The sent bubble keeps showing the local thumbnail.
      previewUrl: i.previewUrl,
    }));
    const text = taRef.current?.value.trim() ?? '';
    onSend(
      text || 'Analiza los archivos adjuntos',
      attachments,
      pickedRef.current.map((p) => p.id)
    );
    setValue('');
    setItems([]);
    setPicked([]);
    setQueued(false);
  }, [onSend]);

  const send = () => {
    if (!canSend) return;
    if (dictation.isListening) dictation.stop();
    if (busy.length > 0) {
      setQueued(true);
      return;
    }
    dispatch();
  };

  // A queued message leaves as soon as the last file is ready.
  useEffect(() => {
    if (!queued || busy.length > 0) return;
    if (failed.length > 0) {
      setQueued(false);
      setNote('Un archivo no se subió: reinténtalo o quítalo y vuelve a enviar.');
      return;
    }
    if (streaming || disabled) return;
    dispatch();
  }, [queued, busy.length, failed.length, streaming, disabled, dispatch]);

  const acquireSlot = useCallback(async () => {
    const s = slots.current;
    if (s.active >= MAX_PARALLEL_UPLOADS) await new Promise<void>((r) => s.waiting.push(r));
    s.active++;
  }, []);
  const releaseSlot = useCallback(() => {
    const s = slots.current;
    s.active--;
    s.waiting.shift()?.();
  }, []);

  const runUpload = useCallback(
    async (key: string, file: File, convId: string) => {
      const alive = () => itemsRef.current.some((i) => i.key === key);
      const controller = new AbortController();
      patch(key, { state: 'queued', phase: 'queued', controller, error: undefined, percent: 0 });
      await acquireSlot();
      try {
        if (controller.signal.aborted || !alive()) return;
        patch(key, { state: 'uploading', phase: 'initiating' });
        const result = await uploadFile(file, {
          target: { type: 'ai_conversation', id: convId },
          signal: controller.signal,
          onProgress: (p) => patch(key, { percent: p.percent, phase: p.phase }),
        });
        // The user moved to another thread meanwhile: this file is not theirs here.
        if (convRef.current !== convId) return;
        if (result.status === 'ready' && result.referenceId) {
          patch(key, {
            state: 'ready',
            phase: 'ready',
            percent: 100,
            attachmentId: result.referenceId,
            mimeType: result.mimeType,
            controller: undefined,
          });
        } else {
          patch(key, {
            state: 'failed',
            controller: undefined,
            error: result.rejectionReason ?? 'El archivo no pasó la verificación',
          });
        }
      } catch (err) {
        if (err instanceof UploadError && err.code === 'aborted') {
          drop(key);
          return;
        }
        patch(key, {
          state: 'failed',
          controller: undefined,
          error: friendlyUploadError(err, file.name),
        });
      } finally {
        releaseSlot();
      }
    },
    [acquireSlot, releaseSlot, patch, drop]
  );

  const uploadMany = useCallback(
    async (list: File[]) => {
      if (list.length === 0) return;
      if (!canUpload) {
        setNote('Tu usuario no tiene permiso para adjuntar archivos.');
        return;
      }
      setNote(null);
      // The chips appear at once; the thread is created (once) in the meantime.
      const added: TrayItem[] = list.map((file) => ({
        key: `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        fileName: file.name || 'archivo',
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        state: 'queued',
        phase: 'queued',
        percent: 0,
        previewUrl:
          file.type.startsWith('image/') && file.size <= PREVIEW_MAX_BYTES
            ? URL.createObjectURL(file)
            : undefined,
      }));
      setItems((prev) => [...prev, ...added]);
      const convId = await ensureConversation();
      if (!convId) {
        for (const a of added)
          patch(a.key, {
            state: 'failed',
            error: 'No se pudo preparar la conversación. Reintenta.',
          });
        return;
      }
      for (const a of added) patch(a.key, { conversationId: convId });
      await Promise.all(added.map((a) => runUpload(a.key, a.file, convId)));
    },
    [canUpload, ensureConversation, patch, runUpload]
  );

  const retry = async (item: TrayItem) => {
    const convId = item.conversationId ?? (await ensureConversation());
    if (!convId) return;
    setNote(null);
    await runUpload(item.key, item.file, convId);
  };

  const remove = (item: TrayItem) => {
    if (item.state === 'uploading' || item.state === 'queued') {
      // uploadFile aborts the server session; the chip leaves on 'aborted'.
      item.controller?.abort();
      if (item.state === 'queued') drop(item.key);
      return;
    }
    if (item.state === 'ready' && item.attachmentId && item.conversationId) {
      fetch(
        `/app/assistant/api/attachments/${item.attachmentId}?conversationId=${encodeURIComponent(item.conversationId)}`,
        { method: 'DELETE' }
      ).catch(() => undefined);
    }
    drop(item.key);
  };

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
    addFiles: (files: File[]) => void uploadMany(files),
  }));

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
        e.preventDefault(); // the conversation-level drop zone sees it as handled
        setDrag(false);
        void uploadMany(Array.from(e.dataTransfer.files ?? []));
      }}
    >
      {items.length > 0 && (
        <div className="uv-composer-files" aria-label="Archivos adjuntos">
          {items.map((item) => (
            <TrayChip
              key={item.key}
              item={item}
              onRemove={() => remove(item)}
              onRetry={() => void retry(item)}
            />
          ))}
        </div>
      )}
      {picked.length > 0 && (
        <div className="uv-composer-picks" aria-label="Lo que usará el agente">
          <span className="uv-composer-picks-label">Usará</span>
          {picked.map((p) => (
            <span key={p.id} className="uv-pick-chip">
              <CapabilityIcon name={p.icon} size={13} />
              {p.label}
              <button
                type="button"
                onClick={() => setPicked((prev) => prev.filter((x) => x.id !== p.id))}
                aria-label={`No usar ${p.label}`}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {queued && busy.length > 0 && (
        <div className="uv-composer-queued" role="status">
          <Clock size={13} />
          Se enviará en cuanto termine{busy.length > 1 ? 'n' : ''} de subir {busy.length} archivo
          {busy.length > 1 ? 's' : ''}.
          <button type="button" onClick={() => setQueued(false)}>
            No enviar aún
          </button>
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
        enterKeyHint="send"
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
          picked={picked}
          onToggleCapability={(cap) =>
            setPicked((prev) =>
              prev.some((p) => p.id === cap.id)
                ? prev.filter((p) => p.id !== cap.id)
                : [...prev, cap].slice(0, 8)
            )
          }
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
        <EffortPicker value={effort} onChange={onEffortChange} disabled={disabled} />
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
        {canUseVoice && onVoiceMode && !value.trim() && items.length === 0 && !streaming ? (
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
            className={cn('uv-send', queued && 'is-queued')}
            onClick={queued ? () => setQueued(false) : send}
            disabled={!queued && !canSend}
            aria-label={queued ? 'Se enviará al terminar la subida (cancelar)' : 'Enviar'}
          >
            {queued ? (
              <Loader2 size={17} className="uv-spin" />
            ) : (
              <ArrowUp size={18} strokeWidth={2.4} />
            )}
          </button>
        )}
      </div>
    </div>
  );
});

function TrayChip({
  item,
  onRemove,
  onRetry,
}: {
  item: TrayItem;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const working = item.state === 'uploading' || item.state === 'queued';
  const isImage = item.mimeType.startsWith('image/');
  const meta =
    item.state === 'failed'
      ? item.error
      : item.state === 'queued'
        ? 'En espera…'
        : item.state === 'uploading'
          ? item.phase === 'validating' || item.phase === 'completing'
            ? 'Verificando…'
            : item.phase === 'initiating'
              ? 'Preparando…'
              : `${item.percent}% · ${formatBytes(item.sizeBytes)}`
          : formatBytes(item.sizeBytes);
  return (
    <span
      className={cn('uv-file-chip', `is-${item.state}`)}
      title={item.state === 'failed' ? `${item.fileName}: ${item.error}` : item.fileName}
    >
      <span className={cn('uv-file-chip-icon', item.previewUrl && 'has-thumb')}>
        {item.previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
          <img src={item.previewUrl} alt="" />
        ) : item.state === 'failed' ? (
          <AlertCircle size={14} />
        ) : isImage ? (
          <ImageIcon size={14} />
        ) : (
          <FileText size={14} />
        )}
        {working && (
          <svg className="uv-ring" viewBox="0 0 36 36" aria-hidden="true">
            <circle cx="18" cy="18" r="15.5" pathLength={100} />
            <circle
              cx="18"
              cy="18"
              r="15.5"
              pathLength={100}
              className={cn(
                'uv-ring-fill',
                (item.state === 'queued' || item.phase !== 'uploading') && 'is-indeterminate'
              )}
              style={{ strokeDasharray: `${Math.max(4, item.percent)} 100` }}
            />
          </svg>
        )}
      </span>
      <span className="uv-file-chip-text">
        <span className="uv-file-chip-name">{item.fileName}</span>
        <span className="uv-file-chip-meta" aria-live="polite">
          {meta}
        </span>
      </span>
      {item.state === 'failed' && (
        <button
          type="button"
          className="uv-file-chip-x"
          onClick={onRetry}
          aria-label={`Reintentar ${item.fileName}`}
          title="Reintentar"
        >
          <RotateCw size={13} />
        </button>
      )}
      <button
        type="button"
        className="uv-file-chip-x"
        onClick={onRemove}
        aria-label={working ? `Cancelar ${item.fileName}` : `Quitar ${item.fileName}`}
        title={working ? 'Cancelar' : 'Quitar'}
      >
        <X size={13} />
      </button>
    </span>
  );
}
