import { describe, expect, it } from 'vitest';
import { encodeWav, resample, rms, Vad } from './audio';
import { isLikelyHallucination, SentenceStream, splitSentences, toSpeakable } from './speakable';

describe('toSpeakable', () => {
  it('reads the prose and leaves tables, code, links and chips on screen', () => {
    const md = [
      '## Ventas de ayer',
      'Vendiste **$482 mil** en 31 pedidos 🎉.',
      '',
      '| Sucursal | Total |',
      '|---|---|',
      '| Norte | $212k |',
      '',
      '- Norte creció 12%',
      '- Sur bajó 3%',
      'Detalle en [el reporte](https://unik.mx/r/1).',
      'Sugerencias: [Compara con agosto] · [Hazme el PDF]',
      'Confianza: verificado',
    ].join('\n');
    const { text, skippedVisual } = toSpeakable(md);
    expect(skippedVisual).toBe(true);
    expect(text).toBe(
      'Ventas de ayer. Vendiste $482 mil en 31 pedidos. Norte creció 12%. Sur bajó 3%. Detalle en el reporte.'
    );
  });

  it('drops code blocks and bare URLs', () => {
    const { text, skippedVisual } = toSpeakable(
      'Corre esto:\n```bash\nnpm test\n```\nY revisa https://x.dev/y'
    );
    expect(skippedVisual).toBe(true);
    expect(text).toBe('Corre esto: Y revisa el enlace.');
  });
});

describe('SentenceStream', () => {
  it('speaks complete sentences as the answer streams, then the rest', () => {
    const s = new SentenceStream();
    expect(s.push('Hoy vendiste')).toEqual([]);
    expect(s.push('Hoy vendiste $480 mil. En 31')).toEqual(['Hoy vendiste $480 mil.']);
    expect(s.push('Hoy vendiste $480 mil. En 31 pedidos. Norte')).toEqual(['En 31 pedidos.']);
    expect(s.flush('Hoy vendiste $480 mil. En 31 pedidos. Norte lidera')).toEqual([
      'Norte lidera.',
    ]);
  });

  it('never reads half a code block and points to the chat for visuals', () => {
    const s = new SentenceStream();
    expect(s.push('Aquí va:\n```sql\nselect 1;\n')).toEqual(['Aquí va:']);
    const out = s.flush('Aquí va:\n```sql\nselect 1;\n```\nListo.');
    expect(out).toEqual(['Listo.', 'Te dejé el detalle en el chat.']);
  });
});

describe('splitSentences', () => {
  it('merges very short sentences', () => {
    expect(splitSentences('Sí. Claro. Lo reviso ahora mismo con calma.')).toEqual([
      'Sí. Claro. Lo reviso ahora mismo con calma.',
    ]);
  });
});

describe('isLikelyHallucination', () => {
  it('filters what Whisper invents on silence', () => {
    expect(isLikelyHallucination('Subtítulos realizados por la comunidad de Amara.org')).toBe(true);
    expect(isLikelyHallucination('¡Gracias por ver el video!')).toBe(true);
    expect(isLikelyHallucination('¿Cuánto vendimos ayer?')).toBe(false);
  });
});

describe('audio helpers', () => {
  it('encodes 16-bit mono WAV with a valid header', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 16_000);
    const text = (a: number, b: number) => String.fromCharCode(...wav.slice(a, b));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 12)).toBe('WAVE');
    expect(wav.length).toBe(44 + 8);
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getInt16(44 + 6, true)).toBe(0x7fff);
  });

  it('resamples 48 kHz to 16 kHz', () => {
    const out = resample([new Float32Array(4800)], 48_000, 16_000);
    expect(out.length).toBe(1600);
  });

  it('detects an utterance, ignores clicks and adapts to the room', () => {
    const vad = new Vad();
    // quiet room
    for (let i = 0; i < 50; i++) expect(vad.push(0.003, 20)).toBeNull();
    // a click (40 ms) is not speech
    expect(vad.push(0.2, 20)).toBeNull();
    expect(vad.push(0.2, 20)).toBeNull();
    expect(vad.push(0.003, 20)).toBeNull();
    // speech: 1 s loud, then silence
    const events: string[] = [];
    for (let i = 0; i < 50; i++) {
      const e = vad.push(0.08, 20);
      if (e) events.push(e);
    }
    for (let i = 0; i < 50; i++) {
      const e = vad.push(0.003, 20);
      if (e) events.push(e);
    }
    expect(events).toEqual(['start', 'end']);
    expect(rms(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
  });

  it('needs louder, longer speech to barge in while the agent talks', () => {
    const vad = new Vad();
    for (let i = 0; i < 50; i++) vad.push(0.003, 20);
    // echo-level sound during playback does not trigger
    let triggered = false;
    for (let i = 0; i < 20; i++) if (vad.push(0.025, 20, true) === 'start') triggered = true;
    expect(triggered).toBe(false);
    for (let i = 0; i < 20; i++) if (vad.push(0.12, 20, true) === 'start') triggered = true;
    expect(triggered).toBe(true);
  });
});
