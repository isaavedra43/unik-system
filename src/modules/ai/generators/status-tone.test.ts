import { describe, it, expect } from 'vitest';
import { colorForStatusLabel, hexToArgb, sanitizeSvgColor, toneForStatusLabel } from './status-tone';

describe('sanitizeSvgColor — guards against SVG attribute injection', () => {
  it('accepts valid hex colors as-is', () => {
    expect(sanitizeSvgColor('#2563eb', '#000000')).toBe('#2563eb');
    expect(sanitizeSvgColor('#FFF', '#000000')).toBe('#FFF');
    expect(sanitizeSvgColor('#2563ebaa', '#000000')).toBe('#2563ebaa');
  });

  it('falls back for anything that could break out of a fill="..." attribute', () => {
    // Real attack shape: color values are AI tool-call arguments interpolated directly into
    // `fill="${color}"` — this string would inject a new attribute/event handler if not validated.
    expect(sanitizeSvgColor('red" onload="alert(1)', '#000000')).toBe('#000000');
    expect(sanitizeSvgColor('"><script>alert(1)</script>', '#000000')).toBe('#000000');
    expect(sanitizeSvgColor('javascript:alert(1)', '#000000')).toBe('#000000');
    expect(sanitizeSvgColor('red', '#000000')).toBe('#000000'); // named colors rejected on purpose
  });

  it('falls back for null/undefined/empty', () => {
    expect(sanitizeSvgColor(undefined, '#111')).toBe('#111');
    expect(sanitizeSvgColor(null, '#111')).toBe('#111');
    expect(sanitizeSvgColor('', '#111')).toBe('#111');
  });
});

describe('hexToArgb', () => {
  it('converts a valid 6-digit hex to ExcelJS ARGB', () => {
    expect(hexToArgb('#2563eb')).toBe('FF2563EB');
    expect(hexToArgb('2563EB')).toBe('FF2563EB');
  });

  it('falls back to the default brand ARGB for anything malformed', () => {
    expect(hexToArgb('not-a-color')).toBe('FF2563EB');
    expect(hexToArgb('#fff')).toBe('FF2563EB'); // 3-digit shorthand not accepted here
  });
});

describe('toneForStatusLabel / colorForStatusLabel', () => {
  it('recognizes real status labels used across the app', () => {
    expect(toneForStatusLabel('Cerrado')).toBe('success');
    expect(toneForStatusLabel('En tránsito')).toBe('info');
    expect(colorForStatusLabel('Anulado')).toBe('#b91c1c');
  });

  it('returns null for non-status text', () => {
    expect(toneForStatusLabel('CARMEN HERNANDEZ SANDOVAL')).toBeNull();
    expect(colorForStatusLabel('$126,730.00')).toBeNull();
  });
});
