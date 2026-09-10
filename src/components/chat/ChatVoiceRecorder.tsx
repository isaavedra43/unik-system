'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, X, Send, AlertCircle } from 'lucide-react';
import { Button } from '@/components/shadcn/button';

export interface ChatVoiceRecorderProps {
  onComplete: (blob: Blob, durationMs: number) => void;
  channelId: string;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function isMediaRecorderSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof window.MediaRecorder !== 'undefined'
  );
}

export function ChatVoiceRecorder({ onComplete }: ChatVoiceRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const supportedRef = useRef<boolean | null>(null);

  // Detect support on mount (client only)
  useEffect(() => {
    supportedRef.current = isMediaRecorderSupported();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.start();
      startTimeRef.current = Date.now();
      setElapsedMs(0);
      setIsRecording(true);

      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startTimeRef.current);
      }, 200);
    } catch {
      setError('No se pudo acceder al micrófono');
      stopStream();
    }
  }, [stopStream]);

  const resetState = useCallback(() => {
    setIsRecording(false);
    setElapsedMs(0);
    mediaRecorderRef.current = null;
    chunksRef.current = [];
  }, []);

  const handleSend = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      // Already stopped or not started
      return;
    }
    const durationMs = Date.now() - startTimeRef.current;

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      if (blob.size > 0) {
        onComplete(blob, durationMs);
      }
      stopStream();
      resetState();
    };

    recorder.stop();
    stopTimer();
  }, [onComplete, stopStream, stopTimer, resetState]);

  const handleCancel = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = () => {
        stopStream();
        resetState();
      };
      recorder.stop();
    } else {
      stopStream();
      resetState();
    }
    stopTimer();
  }, [stopStream, stopTimer, resetState]);

  // Not supported — don't render the button
  if (supportedRef.current === false) return null;

  if (!isRecording) {
    return (
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={startRecording}
          aria-label="Grabar nota de voz"
        >
          <Mic size={20} />
        </Button>
        {error && (
          <span className="flex items-center gap-1 text-xs text-destructive">
            <AlertCircle size={12} /> {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card p-2">
      <span className="size-2 rounded-full bg-destructive animate-pulse" aria-hidden="true" />
      <span className="font-mono text-xs font-medium text-foreground">{formatDuration(elapsedMs)}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={handleCancel}
        aria-label="Cancelar grabación"
        className="text-muted-foreground hover:text-destructive"
      >
        <X size={18} />
      </Button>
      <Button
        variant="default"
        size="icon-sm"
        onClick={handleSend}
        aria-label="Enviar nota de voz"
      >
        <Send size={18} />
      </Button>
    </div>
  );
}
