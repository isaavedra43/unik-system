/**
 * Audio helpers for voice mode — pure, unit tested.
 * Speech is captured as raw PCM and encoded to 16 kHz mono WAV: every browser
 * (Safari records mp4, Firefox ogg) and every STT model accepts it.
 */

export function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / Math.max(1, frame.length));
}

/** Concatenates frames and resamples (linear) to `targetRate`. */
export function resample(
  frames: Float32Array[],
  fromRate: number,
  targetRate = 16_000
): Float32Array {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const input = new Float32Array(total);
  let o = 0;
  for (const f of frames) {
    input.set(f, o);
    o += f.length;
  }
  if (fromRate === targetRate) return input;
  const ratio = fromRate / targetRate;
  const length = Math.max(0, Math.floor(total / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate = 16_000): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(44 + samples.length * 2));
  const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

/** Voice-activity detector with an adaptive noise floor. */
export interface VadConfig {
  /** ms of sound above threshold to start an utterance. */
  onsetMs: number;
  /** ms of quiet to end it. */
  hangoverMs: number;
  /** Utterances shorter than this are noise. */
  minSpeechMs: number;
  maxSpeechMs: number;
}

export const DEFAULT_VAD: VadConfig = {
  onsetMs: 120,
  hangoverMs: 750,
  minSpeechMs: 350,
  maxSpeechMs: 30_000,
};

export type VadEvent = 'start' | 'end' | 'discard' | null;

export class Vad {
  floor = 0.004;
  private above = 0;
  private below = 0;
  private speechMs = 0;
  speaking = false;
  constructor(private cfg: VadConfig = DEFAULT_VAD) {}

  /** Threshold for a frame; `strict` while the agent speaks (echo must not count). */
  threshold(strict: boolean): number {
    const base = Math.min(0.2, Math.max(0.012, this.floor * 2.8 + 0.006));
    return strict ? base * 1.9 : base;
  }

  push(level: number, frameMs: number, strict = false): VadEvent {
    const loud = level > this.threshold(strict);
    if (!this.speaking) {
      // The floor follows the room while nobody speaks.
      if (!loud) this.floor = this.floor * 0.95 + Math.min(level, 0.05) * 0.05;
      this.above = loud ? this.above + frameMs : 0;
      if (this.above >= (strict ? this.cfg.onsetMs * 1.8 : this.cfg.onsetMs)) {
        this.speaking = true;
        this.speechMs = this.above;
        this.below = 0;
        return 'start';
      }
      return null;
    }
    this.speechMs += frameMs;
    this.below = loud ? 0 : this.below + frameMs;
    if (this.below >= this.cfg.hangoverMs || this.speechMs >= this.cfg.maxSpeechMs) {
      const long = this.speechMs - this.below >= this.cfg.minSpeechMs;
      this.reset();
      return long ? 'end' : 'discard';
    }
    return null;
  }

  reset(): void {
    this.speaking = false;
    this.above = 0;
    this.below = 0;
    this.speechMs = 0;
  }
}
