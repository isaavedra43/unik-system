'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, PhoneOff, X, AlertCircle, RefreshCw } from 'lucide-react';

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

type VoicePhase = 'listening' | 'thinking' | 'speaking' | 'error';

/**
 * VoiceMode — Full-screen conversational voice interface.
 *
 * Architecture (chained voice pipeline with VAD):
 *
 * 1. Open mic stream + analyser for volume monitoring
 * 2. Record continuously, detect speech via volume threshold
 * 3. When user stops speaking (silence > 1.2s) → stop recording
 * 4. Send audio to /voice/transcribe (Whisper) → text
 * 5. Send text to /chat (SSE) → AI response
 * 6. Send response to /voice/speak (TTS) → audio playback
 * 7. While TTS plays: pause VAD to prevent echo feedback
 * 8. When TTS ends: resume listening automatically
 *
 * Error handling:
 * - Mic permission denied → show error + retry
 * - Transcription failure → show error + retry
 * - Chat failure → show error + retry
 * - TTS failure → show error + continue listening
 * - All errors offer "Reintentar" without page reload
 */

export function VoiceMode({ conversationId, context, onClose, onConversationCreated }: VoiceModeProps) {
  const [phase, setPhase] = useState<VoicePhase>('listening');
  const [transcript, setTranscript] = useState<string>('');
  const [aiResponse, setAiResponse] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(false);

  // Refs for all mutable state that the loop needs (avoids stale closures)
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const currentConvIdRef = useRef<string | null>(conversationId);
  const isMutedRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);
  const isSpeakingRef = useRef<boolean>(false);
  const vadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const hasSpeechRef = useRef<boolean>(false);
  const recordingMimeTypeRef = useRef<string>('audio/webm');

  // Sync refs
  useEffect(() => {
    currentConvIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cleanup() {
    if (vadIntervalRef.current) {
      clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch { /* ignore */ }
      audioContextRef.current = null;
    }
  }

  /**
   * Initialize microphone stream and audio analyser for VAD.
   */
  async function initMicrophone(): Promise<void> {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Tu navegador no soporta captura de audio. Usa Chrome, Edge o Firefox.');
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      const e = err as DOMException;
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        throw new Error('Permiso de micrófono denegado. Permite el acceso al micrófono en tu navegador.');
      }
      if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
        throw new Error('No se encontró ningún micrófono. Conecta un micrófono e inténtalo de nuevo.');
      }
      if (e.name === 'NotReadableError' || e.name === 'TrackStartError') {
        throw new Error('El micrófono está en uso por otra aplicación. Ciérrala e inténtalo de nuevo.');
      }
      throw new Error(`Error al acceder al micrófono: ${e.message || e.name}`);
    }

    streamRef.current = stream;

    // Set up AudioContext + analyser for VAD
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioCtx = new AudioCtx();
    audioContextRef.current = audioCtx;

    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    analyserRef.current = analyser;
  }

  /**
   * Start recording audio. Returns a Promise<Blob> that resolves when
   * stopRecording() is called.
   */
  function startRecording(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const stream = streamRef.current;
      if (!stream) {
        reject(new Error('No hay stream de audio'));
        return;
      }

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';

      recordingMimeTypeRef.current = mimeType || 'audio/webm';

      let recorder: MediaRecorder;
      try {
        recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
      } catch (err) {
        reject(new Error(`No se pudo iniciar la grabación: ${(err as Error).message}`));
        return;
      }

      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onerror = (e) => {
        reject(new Error(`Error de grabación: ${(e as ErrorEvent).message || 'desconocido'}`));
      };

      // Store resolve so stopRecording can call it
      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: recordingMimeTypeRef.current });
        resolve(blob);
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      hasSpeechRef.current = false;
      silenceStartRef.current = null;
    });
  }

  /**
   * Stop the current recording.
   */
  function stopRecording(): void {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  }

  /**
   * Transcribe audio blob via Whisper endpoint.
   */
  async function transcribeAudio(blob: Blob): Promise<string> {
    if (blob.size < 1000) {
      return ''; // Too small, probably silence
    }

    const formData = new FormData();
    formData.append('audio', blob, 'audio.webm');

    const res = await fetch('/app/assistant/api/voice/transcribe', {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      let msg = 'Error de transcripción';
      try {
        const err = await res.json();
        msg = err.error || msg;
      } catch { /* ignore */ }
      throw new Error(msg);
    }

    const data = await res.json();
    return (data.text as string) || '';
  }

  /**
   * Send text to chat endpoint and stream the response.
   * Returns the full response text.
   */
  async function sendToChat(text: string): Promise<string> {
    // Ensure we have a conversation
    if (!currentConvIdRef.current) {
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
        context: { ...context, voice: true },
      }),
    });

    if (!res.ok) {
      let msg = 'Error en el chat';
      try {
        const err = await res.json();
        msg = err.error || msg;
      } catch { /* ignore */ }
      throw new Error(msg);
    }
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
              const delta = event.data.delta as string;
              fullResponse += delta;
              if (isMountedRef.current) {
                setAiResponse((prev) => prev + delta);
              }
            } else if (event.type === 'done') {
              return fullResponse;
            } else if (event.type === 'error') {
              throw new Error((event.data?.message as string) || 'Error del asistente');
            }
          } catch (e) {
            // If it's a real error (not partial JSON), rethrow
            if (e instanceof Error && e.message !== 'Unexpected token') {
              // Check if it's a JSON parse error or a real error
              if (!(e instanceof SyntaxError)) throw e;
            }
          }
        }
      }
    }
    return fullResponse;
  }

  /**
   * Speak text via TTS endpoint and play it.
   * While playing, VAD is paused to prevent echo feedback.
   */
  async function speakText(text: string): Promise<void> {
    if (!text || text.trim().length === 0) return;

    if (isMountedRef.current) {
      setPhase('speaking');
    }
    isSpeakingRef.current = true;

    // Stop VAD while AI speaks (prevent echo)
    stopVAD();

    try {
      // Truncate long text for faster TTS response (first ~500 chars is enough for voice)
      const ttsText = text.length > 500 ? text.slice(0, 500) + '...' : text;

      const res = await fetch('/app/assistant/api/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ttsText }),
      });

      if (!res.ok) {
        let msg = 'Error al generar audio';
        try {
          const err = await res.json();
          msg = err.error || msg;
        } catch { /* ignore */ }
        throw new Error(msg);
      }

      const audioBlob = await res.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      await new Promise<void>((resolve) => {
        let resolved = false;
        const finish = () => {
          if (resolved) return;
          resolved = true;
          URL.revokeObjectURL(audioUrl);
          isSpeakingRef.current = false;
          audioRef.current = null;
          resolve();
        };

        audio.onended = finish;
        audio.onerror = () => {
          finish();
          if (isMountedRef.current) {
            setError('Error al reproducir el audio');
          }
        };
        audio.play().catch((e) => {
          finish();
          if (isMountedRef.current) {
            setError(`No se pudo reproducir el audio: ${e.message}`);
          }
        });
      });
    } catch (err) {
      isSpeakingRef.current = false;
      throw err;
    }
  }

  /**
   * Start Voice Activity Detection.
   * Monitors audio volume to detect when the user speaks and stops.
   * When silence is detected after speech, stops recording and triggers transcription.
   */
  function startVAD(onSilence: () => void): void {
    const analyser = analyserRef.current;
    if (!analyser) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const SPEECH_THRESHOLD = 8; // Volume level to count as speech (lower = more sensitive)
    const SILENCE_DURATION_MS = 700; // Silence duration to trigger stop (lower = faster)

    silenceStartRef.current = null;
    hasSpeechRef.current = false;

    vadIntervalRef.current = setInterval(() => {
      if (!isMountedRef.current || isSpeakingRef.current || isMutedRef.current) {
        return;
      }

      analyser.getByteFrequencyData(dataArray);
      // Calculate average volume (0-255)
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const avg = sum / dataArray.length;

      if (isMountedRef.current) {
        setAudioLevel(avg);
      }

      if (avg > SPEECH_THRESHOLD) {
        hasSpeechRef.current = true;
        silenceStartRef.current = null;
      } else if (hasSpeechRef.current) {
        // User was speaking, now silent
        if (silenceStartRef.current === null) {
          silenceStartRef.current = Date.now();
        } else if (Date.now() - silenceStartRef.current > SILENCE_DURATION_MS) {
          // Silence detected after speech → stop recording
          stopVAD();
          stopRecording();
          onSilence();
        }
      }
    }, 100);
  }

  function stopVAD(): void {
    if (vadIntervalRef.current) {
      clearInterval(vadIntervalRef.current);
      vadIntervalRef.current = null;
    }
    if (isMountedRef.current) {
      setAudioLevel(0);
    }
  }

  /**
   * Main voice loop — defined as a ref to avoid stale closures and circular deps.
   *
   * Flow:
   * 1. Start recording
   * 2. Start VAD (detects silence → stops recording)
   * 3. On stop → transcribe
   * 4. If text → send to chat → speak response
   * 5. Loop back to listening
   */
  const voiceLoopRef = useRef<() => Promise<void>>(async () => {});

  voiceLoopRef.current = async () => {
    if (!isMountedRef.current) return;

    setError(null);
    setAiResponse('');
    setTranscript('');
    setPhase('listening');

    try {
      // Ensure mic is initialized
      if (!streamRef.current) {
        await initMicrophone();
      }

      // Start recording
      const recordingPromise = startRecording();

      // Start VAD — will stop recording when user goes silent
      startVAD(() => {
        // VAD detected silence — recording is being stopped
        // The recordingPromise will resolve with the audio blob
      });

      // Wait for recording to complete (stopped by VAD)
      const audioBlob = await recordingPromise;

      if (!isMountedRef.current) return;

      // Transcribe
      setPhase('thinking');
      const text = await transcribeAudio(audioBlob);

      if (!isMountedRef.current) return;

      if (!text || text.trim().length === 0) {
        // No speech detected — listen again
        voiceLoopRef.current();
        return;
      }

      setTranscript(text);

      if (!isMountedRef.current) return;

      // Send to chat
      setPhase('thinking');
      const response = await sendToChat(text);

      if (!isMountedRef.current) return;

      // Speak the response
      if (response && response.trim().length > 0) {
        await speakText(response);
      }

      if (!isMountedRef.current) return;

      // Loop back to listening
      voiceLoopRef.current();
    } catch (err) {
      if (!isMountedRef.current) return;
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      setError(msg);
      setPhase('error');
      stopVAD();
    }
  };

  // Start voice loop on mount
  useEffect(() => {
    voiceLoopRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle retry
  const handleRetry = useCallback(() => {
    setError(null);
    cleanup();
    streamRef.current = null;
    audioContextRef.current = null;
    analyserRef.current = null;
    voiceLoopRef.current();
  }, []);

  // Handle mute toggle
  const handleMuteToggle = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      isMutedRef.current = next;
      // If unmuting while listening, restart VAD
      if (!next && phase === 'listening' && !vadIntervalRef.current) {
        // VAD will restart on next loop iteration
      }
      return next;
    });
  }, [phase]);

  // Handle close
  const handleClose = useCallback(() => {
    cleanup();
    onClose();
  }, [onClose]);

  const phaseLabels: Record<VoicePhase, string> = {
    listening: isMuted ? 'Micrófono silenciado' : 'Escuchando...',
    thinking: 'Pensando...',
    speaking: 'Hablando...',
    error: 'Ocurrió un error',
  };

  // Audio level for waveform (0-1)
  const normalizedLevel = Math.min(audioLevel / 40, 1);

  return (
    <motion.div
      className="voice-mode-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* Close button */}
      <button
        className="voice-mode-close"
        onClick={handleClose}
        aria-label="Cerrar modo voz"
      >
        <X size={24} />
      </button>

      <div className="voice-mode-content">
        {/* Title */}
        <motion.div
          className="voice-mode-title"
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <span className="voice-mode-title-icon" />
          Asistente de UNIK
        </motion.div>

        {/* Waveform / Orb animation */}
        <motion.div
          className="voice-mode-visual"
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        >
          <VoiceWaveform
            phase={phase}
            audioLevel={normalizedLevel}
            isMuted={isMuted}
          />
        </motion.div>

        {/* State label */}
        <AnimatePresence mode="wait">
          <motion.p
            key={phase + (isMuted ? '-muted' : '')}
            className="voice-mode-label"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.3 }}
          >
            {phaseLabels[phase]}
          </motion.p>
        </AnimatePresence>

        {/* Transcript + AI response */}
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
                <span className="voice-mode-speaker">Tú</span>
                <p>{transcript}</p>
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
                <span className="voice-mode-speaker">UNIK</span>
                <p>{aiResponse}</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Error state */}
        <AnimatePresence>
          {error && phase === 'error' && (
            <motion.div
              className="voice-mode-error-panel"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
            >
              <AlertCircle size={20} className="voice-mode-error-icon" />
              <p className="voice-mode-error-msg">{error}</p>
              <button className="voice-mode-retry-btn" onClick={handleRetry}>
                <RefreshCw size={16} />
                Reintentar
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Controls */}
        <div className="voice-mode-controls">
          <button
            className="voice-mode-control-btn mute"
            onClick={handleMuteToggle}
            aria-label={isMuted ? 'Activar micrófono' : 'Silenciar micrófono'}
          >
            {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
            <span>{isMuted ? 'Activar' : 'Silenciar'}</span>
          </button>
          <button
            className="voice-mode-control-btn end"
            onClick={handleClose}
            aria-label="Finalizar conversación"
          >
            <PhoneOff size={20} />
            <span>Finalizar</span>
          </button>
        </div>

        {/* Privacy notice */}
        <p className="voice-mode-privacy">
          Las conversaciones pueden ser revisadas por el administrador del sistema.
        </p>
      </div>
    </motion.div>
  );
}

/**
 * VoiceWaveform — Real-time audio-reactive waveform visualization.
 * Uses the actual audio level from the analyser to drive the animation.
 */
function VoiceWaveform({
  phase,
  audioLevel,
  isMuted,
}: {
  phase: VoicePhase;
  audioLevel: number;
  isMuted: boolean;
}) {
  const colors: Record<VoicePhase, string> = {
    listening: '#3b82f6',
    thinking: '#8b5cf6',
    speaking: '#10b981',
    error: '#ef4444',
  };

  const color = isMuted ? '#64748b' : colors[phase];

  // Number of bars in the waveform
  const barCount = 7;
  const bars = Array.from({ length: barCount }, (_, i) => i);

  // Calculate bar heights based on phase and audio level
  function getBarHeight(i: number): number {
    if (isMuted) return 6;
    if (phase === 'listening') {
      // Real audio level drives the bars
      const center = (barCount - 1) / 2;
      const distance = Math.abs(i - center);
      const wave = Math.sin(Date.now() / 200 + i * 0.5) * 0.3 + 0.7;
      return Math.max(6, audioLevel * 60 * wave * (1 - distance / barCount));
    }
    if (phase === 'speaking') {
      // Simulated waveform for AI speaking
      const wave = Math.sin(Date.now() / 150 + i * 0.8) * 0.4 + 0.6;
      return Math.max(8, 40 * wave);
    }
    if (phase === 'thinking') {
      // Gentle pulse
      const wave = Math.sin(Date.now() / 400 + i * 0.3) * 0.2 + 0.3;
      return Math.max(6, 20 * wave);
    }
    return 6;
  }

  return (
    <div className="voice-waveform" style={{ '--wave-color': color } as React.CSSProperties}>
      {/* Outer ring */}
      <div
        className="voice-waveform-ring"
        style={{
          borderColor: `${color}40`,
          boxShadow: `0 0 60px ${color}30, inset 0 0 30px ${color}15`,
        }}
      />
      {/* Inner glow */}
      <div
        className="voice-waveform-glow"
        style={{
          background: `radial-gradient(circle, ${color}30, transparent 70%)`,
        }}
      />
      {/* Bars */}
      <div className="voice-waveform-bars">
        {bars.map((i) => (
          <motion.div
            key={i}
            className="voice-waveform-bar"
            style={{
              background: color,
              borderRadius: 3,
            }}
            animate={{
              height: getBarHeight(i),
            }}
            transition={{
              duration: phase === 'listening' ? 0.08 : 0.3,
              ease: 'easeOut',
            }}
          />
        ))}
      </div>
      {/* Center icon */}
      <div className="voice-waveform-icon">
        {phase === 'listening' && !isMuted && <Mic size={24} color={color} />}
        {phase === 'listening' && isMuted && <MicOff size={24} color={color} />}
        {phase === 'thinking' && (
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
          >
            <RefreshCw size={24} color={color} />
          </motion.div>
        )}
        {phase === 'speaking' && (
          <motion.div
            animate={{ scale: [1, 1.15, 1] }}
            transition={{ duration: 0.5, repeat: Infinity, ease: 'easeInOut' }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          </motion.div>
        )}
        {phase === 'error' && <AlertCircle size={24} color={color} />}
      </div>
    </div>
  );
}
