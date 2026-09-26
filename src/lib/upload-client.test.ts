import { describe, expect, it } from 'vitest';
import { inferMimeType } from './upload-client';

describe('inferMimeType', () => {
  it('uses the extension when the browser reports nothing', () => {
    expect(inferMimeType('notas.md', '')).toBe('text/markdown');
    expect(inferMimeType('datos.csv', undefined)).toBe('text/csv');
    expect(inferMimeType('audio.m4a', '')).toBe('audio/mp4');
  });

  it('fixes the labels browsers get wrong', () => {
    // Windows reports every .csv as Excel 97.
    expect(inferMimeType('ventas.csv', 'application/vnd.ms-excel')).toBe('text/csv');
    expect(inferMimeType('nota.m4a', 'audio/x-m4a')).toBe('audio/mp4');
    expect(inferMimeType('grabacion.wav', 'audio/x-wav')).toBe('audio/wav');
    expect(inferMimeType('LEEME.MD', 'text/x-markdown')).toBe('text/markdown');
  });

  it('keeps a trustworthy reported type', () => {
    expect(inferMimeType('foto.png', 'image/png')).toBe('image/png');
    expect(inferMimeType('reporte.xls', 'application/vnd.ms-excel')).toBe(
      'application/vnd.ms-excel'
    );
  });

  it('falls back to octet-stream for unknown files', () => {
    expect(inferMimeType('archivo', '')).toBe('application/octet-stream');
    expect(inferMimeType('raro.xyz', '')).toBe('application/octet-stream');
  });
});
