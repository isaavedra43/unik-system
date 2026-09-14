import { describe, expect, it } from 'vitest';
import { parseReviewVerdict } from './ai-answer-review';

describe('parseReviewVerdict', () => {
  it('reads an approval', () => {
    expect(parseReviewVerdict('{"approved": true, "issues": []}')).toEqual({ approved: true, issues: [] });
  });
  it('reads concrete issues and never approves with issues present', () => {
    const v = parseReviewVerdict('Aquí va:\n```json\n{"approved": true, "issues": ["El grupo Recolección dice 20 pero la tabla trae 12 filas"]}\n```');
    expect(v).toEqual({ approved: false, issues: ['El grupo Recolección dice 20 pero la tabla trae 12 filas'] });
  });
  it('returns null on garbage', () => {
    expect(parseReviewVerdict('no json here')).toBeNull();
  });
});
