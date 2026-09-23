import { describe, it, expect } from 'vitest';
import {
  createProjectSchema,
  createSurfaceSchema,
  refineSurfaceSchema,
  requestProposalSchema,
  surfacePromptSchema,
} from './visual-contract';

describe('visual-contract schemas', () => {
  it('accepta un proyecto mínimo válido', () => {
    const r = createProjectSchema.safeParse({ name: 'Cocina Hernández' });
    expect(r.success).toBe(true);
  });

  it('rechaza nombre vacío', () => {
    expect(createProjectSchema.safeParse({ name: '  ' }).success).toBe(false);
  });

  it('prompt: puntos positivos/negativos y caja', () => {
    const r = surfacePromptSchema.parse({
      points: [
        { x: 100, y: 200, positive: true },
        { x: 50, y: 50, positive: false },
      ],
      box: { x: 10, y: 20, w: 300, h: 150 },
    });
    expect(r.points).toHaveLength(2);
    expect(r.box?.w).toBe(300);
  });

  it('prompt sin puntos ni caja es válido (se valida en la acción)', () => {
    expect(surfacePromptSchema.parse({}).points).toEqual([]);
  });

  it('createSurface requiere assetId y label', () => {
    expect(
      createSurfaceSchema.safeParse({ projectId: 'p', assetId: 'a', label: '', prompt: {} }).success
    ).toBe(false);
    expect(
      createSurfaceSchema.safeParse({ projectId: 'p', assetId: 'a', label: 'Cubierta', prompt: {} })
        .success
    ).toBe(true);
  });

  it('refineSurface acepta máscara manual opcional', () => {
    const ok = refineSurfaceSchema.safeParse({
      surfaceId: 's1',
      prompt: { points: [] },
      manualMaskPngBase64: 'aGVsbG8=',
    });
    expect(ok.success).toBe(true);
  });

  it('requestProposal exige modo y prompt', () => {
    expect(
      requestProposalSchema.safeParse({
        projectId: 'p',
        surfaceId: 's',
        mode: 'faithful',
        prompt: 'Granito Titanium',
      }).success
    ).toBe(true);
    expect(
      requestProposalSchema.safeParse({ projectId: 'p', surfaceId: 's', mode: 'x', prompt: 'y' })
        .success
    ).toBe(false);
  });
});
