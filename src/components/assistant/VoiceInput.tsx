'use client';

import { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export interface VoiceInputProps {
  onTranscribed: (text: string) => void;
  disabled?: boolean;
}

/**
 * VoiceInput — Microphone button for the chat input bar.
 *
 * Uses Web Speech API (SpeechRecognition) as primary (free, low latency).
 * Falls back to Whisper endpoint if Web Speech API is not available.
 *
 * When recording, shows a pulsing red dot animation.
 */
export function VoiceInput({ onTranscribed, disabled }: VoiceInputProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<unknown>(null);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setIsRecording(false);
  }, []);

  const transcribeViaWhisper = useCallback(async (blob: Blob) => {
    const formData = new FormData();
    formData.append('audio', blob, 'audio.webm');
    const res = await fetch('/app/assistant/api/voice/transcribe', {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Error de transcripción' }));
      throw new Error(err.error || 'Error de transcripción');
    }
    const data = await res.json();
    return data.text as string;
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);

    // Try Web Speech API first (free, instant, no server roundtrip)
    const SpeechRecognition =
      (typeof window !== 'undefined' &&
        ((window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition ||
          (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition)) ||
      null;

    if (SpeechRecognition) {
      try {
        const recognition = new (SpeechRecognition as { new (): SpeechRecognitionLike })();
        recognition.lang = 'es-MX';
        recognition.continuous = false;
        recognition.interimResults = false;

        let finalTranscript = '';
        recognition.onresult = (event: SpeechRecognitionEventLike) => {
          for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
              finalTranscript += event.results[i][0].transcript;
            }
          }
        };

        recognition.onerror = (event: { error: string }) => {
          if (event.error !== 'no-speech' && event.error !== 'aborted') {
            setError('Error de reconocimiento: ' + event.error);
          }
          setIsRecording(false);
        };

        recognition.onend = () => {
          setIsRecording(false);
          if (finalTranscript.trim()) {
            onTranscribed(finalTranscript.trim());
          }
        };

        recognition.start();
        recognitionRef.current = recognition;
        setIsRecording(true);
        return;
      } catch {
        // Fall through to Whisper
      }
    }

    // Fallback: MediaRecorder + Whisper
    try {
      if (!navigator.mediaDevices) {
        setError('Tu navegador no soporta grabación de audio');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        setIsRecording(false);
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        if (blob.size < 1000) return; // Too small, probably silence
        try {
          const text = await transcribeViaWhisper(blob);
          if (text.trim()) onTranscribed(text.trim());
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Error de transcripción');
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
    } catch {
      setError('No se pudo acceder al micrófono');
      setIsRecording(false);
    }
  }, [onTranscribed, transcribeViaWhisper]);

  const toggleRecording = useCallback(() => {
    if (disabled) return;
    if (isRecording) {
      // Stop Web Speech API
      if (recognitionRef.current) {
        (recognitionRef.current as { stop: () => void }).stop();
        recognitionRef.current = null;
      }
      // Stop MediaRecorder
      stopRecording();
    } else {
      startRecording();
    }
  }, [disabled, isRecording, startRecording, stopRecording]);

  return (
    <div className="voice-input-wrapper">
      <button
        type="button"
        className={`voice-input-btn ${isRecording ? 'recording' : ''}`}
        onClick={toggleRecording}
        disabled={disabled}
        aria-label={isRecording ? 'Detener grabación' : 'Hablar'}
        title={isRecording ? 'Detener grabación' : 'Dictar por voz'}
      >
        {isRecording ? (
          <motion.div
            className="voice-input-recording-dot"
            animate={{ scale: [1, 1.3, 1], opacity: [1, 0.6, 1] }}
            transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
          />
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
        )}
      </button>

      <AnimatePresence>
        {error && (
          <motion.div
            className="voice-input-error"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            {error}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Minimal type stubs for Web Speech API (not in standard TS lib)
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: (event: SpeechRecognitionEventLike) => void;
  onerror: (event: { error: string }) => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}
