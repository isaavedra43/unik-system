'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_VAD, encodeWav, resample, rms, Vad } from './audio';
import { isLikelyHallucination, SentenceStream } from './speakable';

/**
 * Voice session — the SAME agent turn as the chat, spoken.
 *
 * mic (echo-cancelled) → VAD → WAV → /voice/transcribe → chat.send (same
 * conversation, same agent, tools, approvals and cards) → the streaming
 * answer is read aloud sentence by sentence (/voice/speak, prefetched) →
 * back to listening. Speaking over the agent interrupts it (barge-in). When
 * the server voice is technically unavailable it falls back to the browser's
 * own speech recognition and synthesis — never when voice is turned off for
 * the user or the company (401/403).
 */

export type VoicePhase =
  'starting' | 'listening' | 'hearing' | 'transcribing' | 'thinking' | 'speaking' | 'error';

export interface VoiceLine {
  id: number;
  role: 'user' | 'agent';
  text: string;
}

export interface VoiceSessionOptions {
  /** Sends the user's words as a chat turn (voice context); settles when the turn ends. */
  send: (text: string) => Promise<unknown> | void;
  /** The chat is generating an answer. */
  streaming: boolean;
  /** The answer being generated (markdown, grows while streaming). */
  content: string;
  /** What the agent is doing right now (running tool label). */
  activity?: string | null;
}

type Speech = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult:
    | ((e: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function speechRecognitionCtor(): (new () => Speech) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => Speech;
    webkitSpeechRecognition?: new () => Speech;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Voice is off for this user or for the company: never work around it. */
const isPolicyBlock = (status: number) => status === 401 || status === 403;

const PREROLL_MS = 400;
/** Sentences synthesized ahead, counting the one playing. */
const PREFETCH = 3;
const FILLER = 'Déjame revisarlo.';
const POLICY_MESSAGE = 'La voz no está habilitada para tu usuario.';

type QueueItem = { text: string; audio: Promise<Blob | null> | null };

export function useVoiceSession(opts: VoiceSessionOptions) {
  const [phase, setPhase] = useState<VoicePhase>('starting');
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<VoiceLine[]>([]);
  const [caption, setCaption] = useState<string>('');
  const [mode, setMode] = useState<'server' | 'browser'>('server');

  // Levels are read by the animation loop (refs: no re-render per frame).
  const micLevel = useRef(0);
  const outLevel = useRef(0);

  const phaseRef = useRef<VoicePhase>('starting');
  const mutedRef = useRef(false);
  /** Who listens: the server (VAD + STT) or the browser's recognizer. */
  const modeRef = useRef<'server' | 'browser'>('server');
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });
  const setPhaseBoth = useCallback((p: VoicePhase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioNode | null>(null);
  const vadRef = useRef(new Vad(DEFAULT_VAD));
  const prerollRef = useRef<Float32Array[]>([]);
  const captureRef = useRef<Float32Array[] | null>(null);
  const alive = useRef(true);
  /** Bumped by every start/teardown: a slow start that lost the race cleans up after itself. */
  const genRef = useRef(0);
  const lineId = useRef(0);

  // Answer → speech
  const sentencesRef = useRef(new SentenceStream());
  const lastContentRef = useRef('');
  const turnActiveRef = useRef(false);
  /** False once the user interrupted: the rest of that answer stays in the chat, unspoken. */
  const speakTurnRef = useRef(false);
  const turnIdRef = useRef(0);
  const finishTurnRef = useRef<() => void>(() => undefined);
  const pendingUtterance = useRef<string | null>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const playingRef = useRef<HTMLAudioElement | null>(null);
  const playingUrl = useRef<string | null>(null);
  const draining = useRef(false);
  /** Who speaks: the server's voice or the browser's synthesis. */
  const ttsMode = useRef<'server' | 'browser'>('server');
  const fillerCache = useRef<Blob | null>(null);
  const fillerSpoken = useRef(false);
  const thinkingSince = useRef(0);
  const recognitionRef = useRef<Speech | null>(null);

  const addLine = useCallback((role: VoiceLine['role'], text: string) => {
    setLines((prev) => {
      const last = prev[prev.length - 1];
      if (role === 'agent' && last?.role === 'agent') {
        return [...prev.slice(0, -1), { ...last, text: `${last.text} ${text}`.trim() }];
      }
      return [...prev, { id: ++lineId.current, role, text }].slice(-40);
    });
  }, []);

  /** Voice is off by policy: stop, free the microphone and say why. */
  const blockByPolicy = useCallback(
    (message?: string) => {
      queueRef.current = [];
      captureRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      setError(message || POLICY_MESSAGE);
      setPhaseBoth('error');
    },
    [setPhaseBoth]
  );

  /* ------------------------------------------------- browser recognition */

  // The browser's recognizer is not echo-cancelled against the agent's voice:
  // it is paused while the agent talks and resumed right after.
  const pauseRecognition = useCallback(() => {
    if (modeRef.current === 'browser') recognitionRef.current?.abort();
  }, []);

  const resumeRecognition = useCallback(() => {
    if (modeRef.current !== 'browser' || mutedRef.current || !alive.current) return;
    if (phaseRef.current === 'speaking' || phaseRef.current === 'error') return;
    try {
      recognitionRef.current?.start();
    } catch {
      /* already started */
    }
  }, []);

  /* ------------------------------------------------------------ speaking */

  const fetchSpeech = useCallback(
    async (text: string): Promise<Blob | null> => {
      if (ttsMode.current === 'browser') return null;
      if (text === FILLER && fillerCache.current) return fillerCache.current;
      try {
        const res = await fetch('/app/assistant/api/voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) {
          if (isPolicyBlock(res.status)) {
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            blockByPolicy(data.error);
          } else if (res.status === 404 || res.status >= 500) {
            // The server voice is unavailable (no key, provider down): the browser speaks.
            ttsMode.current = 'browser';
            setMode('browser');
          }
          return null;
        }
        const blob = await res.blob();
        if (text === FILLER) fillerCache.current = blob;
        return blob;
      } catch {
        return null;
      }
    },
    [blockByPolicy]
  );

  /** Synthesizes the next few sentences while the current one plays. */
  const warm = useCallback(() => {
    for (const item of queueRef.current.slice(0, PREFETCH)) {
      if (!item.audio) item.audio = fetchSpeech(item.text);
    }
  }, [fetchSpeech]);

  const speakWithBrowser = useCallback(
    (text: string) =>
      new Promise<void>((resolve) => {
        if (typeof window === 'undefined' || !('speechSynthesis' in window)) return resolve();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'es-MX';
        u.rate = 1.05;
        const voices = window.speechSynthesis.getVoices();
        const es =
          voices.find((v) => v.lang?.startsWith('es-MX')) ??
          voices.find((v) => v.lang?.startsWith('es'));
        if (es) u.voice = es;
        u.onend = () => resolve();
        u.onerror = () => resolve();
        let t = 0;
        const pump = () => {
          // No analyser for synthesis: a gentle synthetic level for the orb.
          outLevel.current = 0.25 + 0.2 * Math.abs(Math.sin((t += 0.35)));
          if (window.speechSynthesis.speaking) window.setTimeout(pump, 60);
          else outLevel.current = 0;
        };
        window.speechSynthesis.speak(u);
        pump();
      }),
    []
  );

  const stopAudio = useCallback(() => {
    const a = playingRef.current;
    if (a) {
      a.pause();
      a.src = '';
    }
    playingRef.current = null;
    if (playingUrl.current) URL.revokeObjectURL(playingUrl.current);
    playingUrl.current = null;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window)
      window.speechSynthesis.cancel();
    outLevel.current = 0;
  }, []);

  const playBlob = useCallback(
    (blob: Blob) =>
      new Promise<void>((resolve) => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        playingRef.current = audio;
        playingUrl.current = url;
        const ctx = ctxRef.current;
        let analyser: AnalyserNode | null = null;
        if (ctx) {
          try {
            const src = ctx.createMediaElementSource(audio);
            analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            src.connect(analyser);
            analyser.connect(ctx.destination);
          } catch {
            analyser = null;
          }
        }
        const data = analyser ? new Float32Array(analyser.fftSize) : null;
        let raf = 0;
        const meter = () => {
          if (analyser && data) {
            analyser.getFloatTimeDomainData(data);
            outLevel.current = Math.min(1, rms(data) * 4);
          }
          raf = window.requestAnimationFrame(meter);
        };
        const done = () => {
          window.cancelAnimationFrame(raf);
          outLevel.current = 0;
          if (playingUrl.current === url) {
            URL.revokeObjectURL(url);
            playingUrl.current = null;
            playingRef.current = null;
          }
          resolve();
        };
        audio.onended = done;
        audio.onerror = done;
        audio.onpause = () => {
          if (!audio.ended) done();
        };
        meter();
        audio.play().catch(done);
      }),
    []
  );

  const drain = useCallback(async () => {
    if (draining.current) return;
    draining.current = true;
    try {
      while (queueRef.current.length > 0 && alive.current) {
        const item = queueRef.current[0];
        warm();
        const blob = await (item.audio ?? fetchSpeech(item.text));
        if (queueRef.current[0] !== item) continue; // interrupted meanwhile
        if (phaseRef.current === 'error') break; // voice turned off by policy
        if (phaseRef.current !== 'speaking') {
          setPhaseBoth('speaking');
          pauseRecognition();
        }
        setCaption(item.text);
        // The transcript shows what was actually said, not what was cut off.
        if (item.text !== FILLER) addLine('agent', item.text);
        if (blob) await playBlob(blob);
        else await speakWithBrowser(item.text);
        if (queueRef.current[0] === item) queueRef.current.shift();
      }
    } finally {
      draining.current = false;
      if (alive.current && queueRef.current.length === 0 && phaseRef.current === 'speaking') {
        setCaption('');
        setPhaseBoth(turnActiveRef.current && speakTurnRef.current ? 'thinking' : 'listening');
        resumeRecognition();
      }
    }
  }, [
    warm,
    fetchSpeech,
    playBlob,
    speakWithBrowser,
    setPhaseBoth,
    pauseRecognition,
    resumeRecognition,
    addLine,
  ]);

  const enqueue = useCallback(
    (sentences: string[]) => {
      if (sentences.length === 0 || phaseRef.current === 'error') return;
      for (const text of sentences) queueRef.current.push({ text, audio: null });
      warm();
      void drain();
    },
    [warm, drain]
  );

  /** Stop talking now. The answer keeps going in the chat, just not aloud. */
  const interrupt = useCallback(() => {
    speakTurnRef.current = false;
    queueRef.current = [];
    stopAudio();
    setCaption('');
    if (phaseRef.current === 'speaking') setPhaseBoth('listening');
    resumeRecognition();
  }, [stopAudio, setPhaseBoth, resumeRecognition]);

  /* ------------------------------------------------------------ hearing */

  const deliver = useCallback(
    (text: string) => {
      const clean = text.trim();
      if (!clean || isLikelyHallucination(clean)) {
        if (phaseRef.current === 'transcribing') setPhaseBoth('listening');
        return;
      }
      setError(null);
      addLine('user', clean);
      if (optsRef.current.streaming) {
        // Never two turns at once in one conversation: it goes out right after.
        const prev = pendingUtterance.current;
        pendingUtterance.current = prev ? `${prev} ${clean}` : clean;
        setPhaseBoth('thinking');
        return;
      }
      sentencesRef.current.reset();
      lastContentRef.current = '';
      fillerSpoken.current = false;
      turnActiveRef.current = true;
      speakTurnRef.current = true;
      thinkingSince.current = Date.now();
      const turn = ++turnIdRef.current;
      setPhaseBoth('thinking');
      // The turn normally ends when `streaming` drops; this is the safety net
      // for a send that failed before it ever started streaming.
      Promise.resolve(optsRef.current.send(clean))
        .catch(() => undefined)
        .then(() => {
          window.setTimeout(() => {
            if (turn === turnIdRef.current && !optsRef.current.streaming) finishTurnRef.current();
          }, 400);
        });
    },
    [addLine, setPhaseBoth]
  );

  const startBrowserRecognition = useCallback(() => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return false;
    const rec = new Ctor();
    rec.lang = 'es-MX';
    rec.continuous = false;
    rec.interimResults = true;
    rec.onresult = (e) => {
      if (phaseRef.current === 'speaking') return; // never its own voice
      let finalText = '';
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (interim) {
        setCaption(interim);
        if (phaseRef.current === 'listening') setPhaseBoth('hearing');
      }
      if (finalText) {
        setCaption('');
        if (phaseRef.current === 'hearing') setPhaseBoth('listening');
        deliver(finalText);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setError('Permite el micrófono en tu navegador para hablar con el agente.');
        setPhaseBoth('error');
      }
    };
    rec.onend = () => {
      if (recognitionRef.current !== rec) return; // replaced or torn down
      if (phaseRef.current === 'hearing') {
        setCaption('');
        setPhaseBoth('listening');
      }
      // Keeps listening between turns (not while it speaks: no echo loops).
      window.setTimeout(() => {
        if (recognitionRef.current === rec) resumeRecognition();
      }, 250);
    };
    recognitionRef.current = rec;
    try {
      rec.start();
    } catch {
      /* already started */
    }
    return true;
  }, [deliver, setPhaseBoth, resumeRecognition]);

  const transcribe = useCallback(
    async (frames: Float32Array[], rate: number) => {
      setPhaseBoth('transcribing');
      const pcm = resample(frames, rate, 16_000);
      const wav = encodeWav(pcm, 16_000);
      const form = new FormData();
      form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'voz.wav');
      try {
        const res = await fetch('/app/assistant/api/voice/transcribe', {
          method: 'POST',
          body: form,
        });
        const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
        if (!res.ok) {
          if (isPolicyBlock(res.status)) {
            blockByPolicy(data.error);
            return;
          }
          if (speechRecognitionCtor()) {
            // The server voice is unavailable → the browser listens and speaks from now on.
            modeRef.current = 'browser';
            ttsMode.current = 'browser';
            setMode('browser');
            setPhaseBoth('listening');
            setCaption('No alcancé a entenderte; repítelo, por favor.');
            startBrowserRecognition();
            return;
          }
          setError(data.error ?? 'No se pudo transcribir el audio.');
          setPhaseBoth('listening');
          return;
        }
        const heard = (data.text ?? '').trim();
        deliver(heard);
        if (!heard && phaseRef.current === 'transcribing') setPhaseBoth('listening');
      } catch {
        setError('Se perdió la conexión al transcribir. Vuelve a intentarlo.');
        setPhaseBoth('listening');
      }
    },
    [deliver, setPhaseBoth, startBrowserRecognition, blockByPolicy]
  );

  const onFrame = useCallback(
    (frame: Float32Array, rate: number) => {
      const level = rms(frame);
      micLevel.current = mutedRef.current ? 0 : level;
      const frameMs = (frame.length / rate) * 1000;
      // Pre-roll: the first syllables before the VAD triggers.
      const pre = prerollRef.current;
      pre.push(frame);
      const keep = Math.ceil(PREROLL_MS / frameMs);
      if (pre.length > keep) pre.splice(0, pre.length - keep);
      if (mutedRef.current || modeRef.current === 'browser') return;
      const p = phaseRef.current;
      if (p === 'transcribing' || p === 'starting' || p === 'error') return;
      if (p === 'speaking' && ttsMode.current === 'browser') {
        // The browser's synthesized voice is not echo-cancelled: no barge-in
        // over it (the Interrumpir button still works).
        if (captureRef.current) {
          captureRef.current = null;
          vadRef.current.reset();
        }
        return;
      }
      const strict = p === 'speaking';
      const ev = vadRef.current.push(level, frameMs, strict);
      if (ev === 'start') {
        if (p === 'speaking') interrupt(); // barge-in
        captureRef.current = [...pre];
        if (phaseRef.current !== 'thinking') setPhaseBoth('hearing');
      } else if (captureRef.current) {
        captureRef.current.push(frame);
        if (ev === 'end') {
          const frames = captureRef.current;
          captureRef.current = null;
          void transcribe(frames, rate);
        } else if (ev === 'discard') {
          captureRef.current = null;
          if (phaseRef.current === 'hearing') setPhaseBoth('listening');
        }
      }
    },
    [interrupt, setPhaseBoth, transcribe]
  );

  /* ------------------------------------------------------------ lifecycle */

  const start = useCallback(async () => {
    const gen = ++genRef.current;
    const stale = () => !alive.current || gen !== genRef.current;
    setError(null);
    setPhaseBoth('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      if (stale()) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      await ctx.resume().catch(() => undefined);
      let node: AudioNode;
      try {
        await ctx.audioWorklet.addModule('/voice-capture-worklet.js');
        if (stale()) return; // torn down meanwhile: stream and context are already closed
        const worklet = new AudioWorkletNode(ctx, 'unik-voice-capture');
        worklet.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data, ctx.sampleRate);
        node = worklet;
      } catch {
        if (stale()) return;
        // Older engines: ScriptProcessor does the same job.
        const sp = ctx.createScriptProcessor(1024, 1, 1);
        sp.onaudioprocess = (e) =>
          onFrame(new Float32Array(e.inputBuffer.getChannelData(0)), ctx.sampleRate);
        node = sp;
      }
      const source = ctx.createMediaStreamSource(stream);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      sink.connect(ctx.destination);
      source.connect(node);
      node.connect(sink);
      nodeRef.current = node;
      setPhaseBoth('listening');
      // A retry after falling back keeps listening with the browser.
      if (modeRef.current === 'browser') startBrowserRecognition();
    } catch (err) {
      if (stale()) return;
      const name = (err as { name?: string })?.name;
      setError(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Permite el micrófono en tu navegador para hablar con el agente.'
          : name === 'NotFoundError'
            ? 'No encontré un micrófono conectado.'
            : 'No se pudo abrir el micrófono.'
      );
      setPhaseBoth('error');
    }
  }, [onFrame, setPhaseBoth, startBrowserRecognition]);

  const teardown = useCallback(() => {
    genRef.current++;
    queueRef.current = [];
    stopAudio();
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    rec?.abort();
    captureRef.current = null;
    vadRef.current.reset();
    try {
      nodeRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    nodeRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
  }, [stopAudio]);

  useEffect(() => {
    alive.current = true;
    void start();
    return () => {
      alive.current = false;
      teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------ the answer */

  const finishTurn = useCallback(() => {
    if (!turnActiveRef.current) return;
    turnActiveRef.current = false;
    // What the answer said after the last full stop, then "the detail is in
    // the chat" if something visual was left out.
    if (speakTurnRef.current) enqueue(sentencesRef.current.flush(lastContentRef.current));
    if (queueRef.current.length === 0 && phaseRef.current === 'thinking') setPhaseBoth('listening');
    // What the user said meanwhile goes out now.
    const next = pendingUtterance.current;
    pendingUtterance.current = null;
    if (next) window.setTimeout(() => deliver(next), 150);
  }, [enqueue, deliver, setPhaseBoth]);

  useEffect(() => {
    finishTurnRef.current = finishTurn;
  }, [finishTurn]);

  // Read the answer aloud while it streams.
  useEffect(() => {
    if (!turnActiveRef.current || !speakTurnRef.current || !opts.content) return;
    lastContentRef.current = opts.content;
    enqueue(sentencesRef.current.push(opts.content));
  }, [opts.content, enqueue]);

  // The answer finished.
  useEffect(() => {
    if (!opts.streaming) finishTurn();
  }, [opts.streaming, finishTurn]);

  // A tool is taking a while and nothing was said yet: a short filler, once.
  useEffect(() => {
    if (phase !== 'thinking' || !opts.activity || fillerSpoken.current) return;
    const wait = Math.max(0, 2800 - (Date.now() - thinkingSince.current));
    const t = window.setTimeout(() => {
      if (
        phaseRef.current === 'thinking' &&
        turnActiveRef.current &&
        speakTurnRef.current &&
        !fillerSpoken.current &&
        queueRef.current.length === 0
      ) {
        fillerSpoken.current = true;
        enqueue([FILLER]);
      }
    }, wait);
    return () => window.clearTimeout(t);
  }, [phase, opts.activity, enqueue]);

  /* ------------------------------------------------------------ controls */

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    captureRef.current = null;
    vadRef.current.reset();
    if (modeRef.current === 'browser') {
      if (next) recognitionRef.current?.abort();
      else resumeRecognition();
    }
  }, [resumeRecognition]);

  const retry = useCallback(() => {
    teardown();
    void start();
  }, [teardown, start]);

  return {
    phase,
    muted,
    error,
    lines,
    caption,
    mode,
    micLevel,
    outLevel,
    toggleMute,
    interrupt,
    retry,
  };
}
