'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

// ---------------------------------------------------------------------------
// Web Speech API types (not in standard TS lib.dom.d.ts)
// ---------------------------------------------------------------------------

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognition;

type WindowWithSpeechRecognition = typeof window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface VoiceDictationOptions {
  /** BCP-47 language tag. Default: 'es-MX' (Mexican Spanish). */
  lang?: string;
  /** Called whenever the transcript changes (interim + final). */
  onTranscript?: (text: string, isFinal: boolean) => void;
  /** Called when dictation starts. */
  onStart?: () => void;
  /** Called when dictation stops (manually or automatically). */
  onEnd?: () => void;
  /** Called on error (mic denied, network, etc.). */
  onError?: (error: string) => void;
}

export interface VoiceDictationState {
  /** Whether dictation is currently active (listening). */
  isListening: boolean;
  /** The interim (not-yet-final) transcript shown while speaking. */
  interimTranscript: string;
  /** Whether the browser supports the Web Speech API. */
  isSupported: boolean;
  /** Start listening. No-op if already listening or unsupported. */
  start: () => void;
  /** Stop listening. Final results are flushed before onEnd. */
  stop: () => void;
  /** Toggle listening on/off. */
  toggle: () => void;
  /** Last error message, if any. */
  error: string | null;
}

/**
 * Voice dictation hook using the browser's Web Speech API.
 *
 * - Real-time streaming recognition with interim results.
 * - Optimized for Mexican Spanish (es-MX) by default.
 * - No external dependencies, no API costs, works offline in Chrome.
 * - Graceful fallback: `isSupported` is false on Firefox/older browsers.
 *
 * Usage:
 * ```tsx
 * const { isListening, interimTranscript, toggle, isSupported } = useVoiceDictation({
 *   onTranscript: (text, isFinal) => {
 *     if (isFinal) appendToMessage(text);
 *   },
 * });
 * ```
 */
/** Nothing to subscribe to: whether the browser speaks Web Speech never changes mid-session. */
const subscribeToNothing = () => () => {};

/**
 * Whether this browser has the Web Speech API.
 *
 * It must NOT be read as `typeof window !== 'undefined'` during render: the
 * server said "no" and the browser said "yes" on its very first render, so the
 * dictation button appeared out of nowhere and React threw away the whole
 * surrounding tree (hydration error #418 — it hit the copilot, the assistant
 * and the chat composers). `useSyncExternalStore` answers `false` on the server
 * AND during hydration, then commits the real value, so the markup always
 * matches and the button simply appears a tick later.
 */
function useSpeechRecognitionSupported(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () =>
      !!(window as WindowWithSpeechRecognition).SpeechRecognition ||
      !!(window as WindowWithSpeechRecognition).webkitSpeechRecognition,
    () => false
  );
}

export function useVoiceDictation(options: VoiceDictationOptions = {}): VoiceDictationState {
  const { lang = 'es-MX', onTranscript, onStart, onEnd, onError } = options;

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const isListeningRef = useRef(false);
  const shouldRestartRef = useRef(false);

  // Stable refs for callbacks so the recognition instance isn't recreated.
  const onTranscriptRef = useRef(onTranscript);
  const onStartRef = useRef(onStart);
  const onEndRef = useRef(onEnd);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
    onStartRef.current = onStart;
    onEndRef.current = onEnd;
    onErrorRef.current = onError;
  });

  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isSupported = useSpeechRecognitionSupported();

  // Create the recognition instance once (lazy on first start).
  const ensureRecognition = useCallback((): SpeechRecognition | null => {
    if (recognitionRef.current) return recognitionRef.current;

    const w = window as WindowWithSpeechRecognition;
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return null;

    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      isListeningRef.current = true;
      setIsListening(true);
      onStartRef.current?.();
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) {
          setInterimTranscript('');
          onTranscriptRef.current?.(transcript.trim(), true);
        } else {
          interim += transcript;
        }
      }
      if (interim) {
        setInterimTranscript(interim);
        onTranscriptRef.current?.(interim, false);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // 'no-speech' and 'aborted' are benign — don't surface them as errors.
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        const msg =
          event.error === 'not-allowed'
            ? 'Permiso de micrófono denegado'
            : event.error === 'network'
              ? 'Error de red en el dictado'
              : `Error de dictado: ${event.error}`;
        setError(msg);
        onErrorRef.current?.(event.error);
      }
    };

    recognition.onend = () => {
      setInterimTranscript('');
      isListeningRef.current = false;
      setIsListening(false);

      // Auto-restart if the user didn't explicitly stop (Chrome stops after
      // ~60s of silence; continuous mode needs manual restart).
      if (shouldRestartRef.current) {
        try {
          recognition.start();
          return;
        } catch {
          // If start fails (e.g. mic permission revoked), fall through to onEnd.
        }
      }

      onEndRef.current?.();
    };

    recognitionRef.current = recognition;
    return recognition;
  }, [lang]);

  const start = useCallback(() => {
    if (isListeningRef.current) return;
    setError(null);

    const recognition = ensureRecognition();
    if (!recognition) {
      setError('Tu navegador no soporta dictado por voz');
      onErrorRef.current?.('unsupported');
      return;
    }

    shouldRestartRef.current = true;
    try {
      recognition.start();
    } catch {
      // start() throws if already started — safe to ignore.
    }
  }, [ensureRecognition]);

  const stop = useCallback(() => {
    shouldRestartRef.current = false;
    const recognition = recognitionRef.current;
    if (recognition && isListeningRef.current) {
      try {
        recognition.stop();
      } catch {
        // ignore
      }
    }
    isListeningRef.current = false;
    setIsListening(false);
    setInterimTranscript('');
  }, []);

  const toggle = useCallback(() => {
    if (isListeningRef.current) {
      stop();
    } else {
      start();
    }
  }, [start, stop]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      shouldRestartRef.current = false;
      const recognition = recognitionRef.current;
      if (recognition) {
        try {
          recognition.abort();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  return {
    isListening,
    interimTranscript,
    isSupported,
    start,
    stop,
    toggle,
    error,
  };
}
