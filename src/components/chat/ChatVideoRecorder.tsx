'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Video, X, Send, VideoOff } from 'lucide-react';

export interface ChatVideoRecorderProps {
  onComplete: (blob: Blob, durationMs: number) => void;
  channelId: string;
}

const MAX_DURATION_MS = 3 * 60 * 1000; // 3 minutes

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

export function ChatVideoRecorder({ onComplete }: ChatVideoRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const supportedRef = useRef<boolean | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    supportedRef.current = isMediaRecorderSupported();
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (autoStopRef.current) clearTimeout(autoStopRef.current);
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

  const resetState = useCallback(() => {
    setIsRecording(false);
    setElapsedMs(0);
    setVideoUrl(null);
    mediaRecorderRef.current = null;
    chunksRef.current = [];
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      if (previewRef.current) {
        previewRef.current.srcObject = stream;
      }

      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';
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
        const elapsed = Date.now() - startTimeRef.current;
        setElapsedMs(elapsed);
        if (elapsed >= MAX_DURATION_MS) {
          handleSend();
        }
      }, 200);

      // Auto-stop at 3 minutes
      autoStopRef.current = setTimeout(() => {
        handleSend();
      }, MAX_DURATION_MS);
    } catch {
      setError('No se pudo acceder a la cámara');
      stopStream();
    }
  }, [stopStream]);

  const handleSend = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    const durationMs = Date.now() - startTimeRef.current;

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'video/webm' });
      if (blob.size > 0) {
        onComplete(blob, durationMs);
      }
      stopStream();
      resetState();
    };

    recorder.stop();
    stopTimer();
    if (autoStopRef.current) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
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
    if (autoStopRef.current) {
      clearTimeout(autoStopRef.current);
      autoStopRef.current = null;
    }
  }, [stopStream, stopTimer, resetState]);

  if (supportedRef.current === false) return null;

  if (!isRecording) {
    return (
      <div className="chat-voice-recorder">
        <button
          type="button"
          className="chat-voice-btn"
          onClick={startRecording}
          aria-label="Grabar nota de video"
          title="Grabar nota de video (máx 3 min)"
        >
          <Video size={20} />
        </button>
        {error && <span className="chat-voice-error">{error}</span>}
      </div>
    );
  }

  return (
    <div className="chat-video-recorder">
      <div className="chat-video-preview">
        <video ref={previewRef} autoPlay muted playsInline />
      </div>
      <div className="chat-video-recording-info">
        <span className="chat-voice-dot" aria-hidden="true" />
        <span className="chat-voice-timer">{formatDuration(elapsedMs)}</span>
        <span className="chat-video-limit">/ 03:00</span>
      </div>
      <div className="chat-video-controls">
        <button
          type="button"
          className="chat-voice-cancel"
          onClick={handleCancel}
          aria-label="Cancelar grabación"
        >
          <X size={18} />
        </button>
        <button
          type="button"
          className="chat-voice-send"
          onClick={handleSend}
          aria-label="Enviar nota de video"
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
