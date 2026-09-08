'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { VoiceOrb, type VoiceState } from './VoiceOrb';

export interface VoiceModeProps {
  conversationId: string | null;
  context?: { page?: string };
  onClose: () => void;
  onConversationCreated?: (id: string) => void;
  user: { id: string; name: string; username: string; isSuperAdmin: boolean };
}

interface ChatSSEEvent {
  type: 'token' | 'tool_call_start' | 'tool_call_end' | 'artifact' | 'done' | 'error';
  data?: Record<string, unknown>;
}

/**
 * VoiceMode — Full-screen conversational voice interface.
 *
 * Architecture (chained voice pipeline):
 * 1. User speaks → MediaRecorder captures audio
 * 2. Audio sent to /voice/transcribe (Whisper) → text
 * 3. Text sent to /chat (SSE) → AI response with tool calls
 * 4. AI response text sent to /voice/speak (TTS) → audio playback
 * 5. Barge-in: if user starts speaking while AI is talking, audio stops
 *
 * Features:
 * - Animated VoiceOrb (idle/listening/thinking/speaking)
 * - Live transcript display
 * - Barge-in via volume detection on mic while AI speaks
 * - Auto-listen after AI finishes speaking
 */
export function VoiceMode({ conversationId, context, onClose, onConversationCreated, user }: VoiceModeProps) {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [transcript, setTranscript] = useState<string>('');
  const [aiResponse, setAiResponse] = useState<string>('');
  const [interimText, setInterimText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);

  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const bargeInIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentConvIdRef = useRef<string | null>(conversationId);
  const isSpeakingRef = useRef(false);
  const isRecordingRef = useRef(false);

  // Sync conversationId ref
  useEffect(() => {
    currentConvIdRef.current = conversationId;
  }, [conversationId]);

  /**
   * Start recording audio from the microphone.
   * Returns a Promise<Blob> when recording stops.
   */
  const startRecording = useCallback((): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      if (!navigator.mediaDevices) {
        reject(new Error('Navegador no soporta grabación de audio'));
        return;
      }

      navigator.mediaDevices
        .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        .then((stream) => {
          audioStreamRef.current = stream;
          const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : 'audio/webm';
          const recorder = new MediaRecorder(stream, { mimeType });
          audioChunksRef.current = [];

          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) audioChunksRef.current.push(e.data);
          };

          recorder.onstop = () => {
            const blob = new Blob(audioChunksRef.current, { type: mimeType });
            resolve(blob);
          };

          recorder.onerror = (e) => reject(e);

          recorder.start();
          mediaRecorderRef.current = recorder;
          isRecordingRef.current = true;
        })
        .catch(reject);
    });
  }, []);

  /**
   * Stop recording and return the audio blob.
   */
  const stopRecording = useCallback((): Promise<Blob> => {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        resolve(new Blob());
        return;
      }
      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType });
        isRecordingRef.current = false;
        resolve(blob);
      };
      recorder.stop();
    });
  }, []);

  /**
   * Transcribe audio blob via Whisper endpoint.
   */
  const transcribeAudio = useCallback(async (blob: Blob): Promise<string> => {
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

  /**
   * Send text to chat endpoint and stream the response.
   * Returns the full response text.
   */
  const sendToChat = useCallback(async (text: string): Promise<string> => {
    const convId = currentConvIdRef.current;
    if (!convId) {
      // Create conversation first
      const createRes = await fetch('/app/assistant/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context }),
      });
      if (!createRes.ok) throw new Error('No se pudo crear la conversación');
      const created = await createRes.json();
      currentConvIdRef.current = created.id;
      onConversationCreated?.(created.id);
    }

    const res = await fetch('/app/assistant/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: currentConvIdRef.current,
        message: text,
        context,
      }),
    });

    if (!res.ok) throw new Error('Error en el chat');
    if (!res.body) throw new Error('No hay stream de respuesta');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event: ChatSSEEvent = JSON.parse(line.slice(6));
            if (event.type === 'token' && event.data?.delta) {
              fullResponse += event.data.delta as string;
              setAiResponse((prev) => prev + (event.data?.delta as string));
            } else if (event.type === 'done') {
              return fullResponse;
            } else if (event.type === 'error') {
              throw new Error((event.data?.message as string) || 'Error del asistente');
            }
          } catch {
            // partial JSON, skip
          }
        }
      }
    }
    return fullResponse;
  }, [context, onConversationCreated]);

  /**
   * Speak text via TTS endpoint and play it.
   * Supports barge-in: if user starts speaking, playback stops.
   */
  const speakText = useCallback(async (text: string): Promise<void> => {
    if (!text || text.trim().length === 0) return;

    setVoiceState('speaking');
    isSpeakingRef.current = true;

    try {
      const res = await fetch('/app/assistant/api/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!res.ok) {
        throw new Error('Error en TTS');
      }

      const audioBlob = await res.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      // Start barge-in detection while AI speaks
      startBargeInDetection();

      await new Promise<void>((resolve) => {
        audio.onended = () => {
          URL.revokeObjectURL(audioUrl);
          isSpeakingRef.current = false;
          stopBargeInDetection();
          resolve();
        };
        audio.onerror = () => {
          URL.revokeObjectURL(audioUrl);
          isSpeakingRef.current = false;
          stopBargeInDetection();
          resolve();
        };
        audio.play().catch(() => {
          isSpeakingRef.current = false;
          stopBargeInDetection();
          resolve();
        });
      });
    } catch {
      isSpeakingRef.current = false;
      stopBargeInDetection();
    }
  }, []);

  /**
   * Barge-in detection: monitor mic volume while AI speaks.
   * If volume exceeds threshold, stop AI audio and start listening.
   */
  const startBargeInDetection = useCallback(() => {
    if (!audioStreamRef.current) return;

    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext();
      }
      const source = audioContextRef.current.createMediaStreamSource(audioStreamRef.current);
      const analyser = audioContextRef.current.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let consecutiveLoudFrames = 0;

      bargeInIntervalRef.current = setInterval(() => {
        if (!isSpeakingRef.current || !analyserRef.current) return;
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        // Threshold: if average volume > 30 for 3 consecutive frames (~150ms)
        if (avg > 30) {
          consecutiveLoudFrames++;
          if (consecutiveLoudFrames >= 3) {
            // Barge-in! Stop AI audio
            if (audioRef.current) {
              audioRef.current.pause();
              audioRef.current.currentTime = 0;
            }
            isSpeakingRef.current = false;
            stopBargeInDetection();
            // Start listening again
            startVoiceLoop();
          }
        } else {
          consecutiveLoudFrames = 0;
        }
      }, 50);
    } catch {
      // Audio context might fail, skip barge-in
    }
  }, []);

  const stopBargeInDetection = useCallback(() => {
    if (bargeInIntervalRef.current) {
      clearInterval(bargeInIntervalRef.current);
      bargeInIntervalRef.current = null;
    }
    analyserRef.current = null;
  }, []);

  /**
   * Main voice loop: listen → transcribe → chat → speak → repeat
   */
  const startVoiceLoop = useCallback(async () => {
    if (!isActive) return;
    setError(null);
    setInterimText('');
    setAiResponse('');
    setVoiceState('listening');

    try {
      // 1. Record user audio
      const audioBlob = await startRecording();

      // 2. Transcribe
      setVoiceState('thinking');
      const text = await transcribeAudio(audioBlob);
      setTranscript(text);

      if (!text || text.trim().length === 0) {
        // No speech detected, listen again
        startVoiceLoop();
        return;
      }

      // 3. Send to chat
      setVoiceState('thinking');
      const response = await sendToChat(text);

      // 4. Speak the response
      if (response && response.trim().length > 0) {
        await speakText(response);
      }

      // 5. Loop back to listening
      if (isActive) {
        startVoiceLoop();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      setError(msg);
      setVoiceState('idle');
    }
  }, [isActive, startRecording, transcribeAudio, sendToChat, speakText]);

  // Start voice loop on mount
  useEffect(() => {
    setIsActive(true);
    startVoiceLoop();
    return () => {
      setIsActive(false);
      stopBargeInDetection();
      if (audioRef.current) {
        audioRef.current.pause();
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (audioStreamRef.current) {
        audioStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);

  const stateLabels: Record<VoiceState, string> = {
    idle: 'Toca para hablar',
    listening: 'Escuchando...',
    thinking: 'Pensando...',
    speaking: 'Hablando...',
  };

  return (
    <motion.div
      className="voice-mode-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="voice-mode-content">
        {/* Close button */}
        <button
          className="voice-mode-close"
          onClick={onClose}
          aria-label="Cerrar modo voz"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        {/* Voice Orb */}
        <motion.div
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          <VoiceOrb state={voiceState} size={160} />
        </motion.div>

        {/* State label */}
        <motion.p
          className="voice-mode-label"
          key={voiceState}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          {stateLabels[voiceState]}
        </motion.p>

        {/* Transcript display */}
        <div className="voice-mode-transcript">
          <AnimatePresence mode="wait">
            {transcript && (
              <motion.div
                key="user-transcript"
                className="voice-mode-user-text"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                <span className="voice-mode-speaker">Tú:</span> {transcript}
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence mode="wait">
            {aiResponse && (
              <motion.div
                key="ai-response"
                className="voice-mode-ai-text"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
              >
                <span className="voice-mode-speaker">UNIK:</span> {aiResponse}
              </motion.div>
            )}
          </AnimatePresence>

          {error && (
            <motion.div
              className="voice-mode-error"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              {error}
            </motion.div>
          )}
        </div>

        {/* Privacy notice */}
        <p className="voice-mode-privacy">
          Las conversaciones pueden ser revisadas por el administrador del sistema.
        </p>
      </div>
    </motion.div>
  );
}
