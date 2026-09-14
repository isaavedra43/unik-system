import { describe, expect, it } from 'vitest';
import { buildTurnDirectives, looksUnfinished, stripMarkdownImages, wantsDocument } from './turn-directives';

describe('buildTurnDirectives', () => {
  it('gives the attachment protocol when photos come with an analysis request', () => {
    const d = buildTurnDirectives({
      message: 'Quiero que me hagas una tabla poniéndome cada orden de venta diciéndome por qué no se ha entregado y comparando',
      tier: 'complex',
      attachmentKinds: ['image', 'image', 'document'],
      priorAttachmentKinds: [],
    });
    expect(d).toContain('readAttachment');
    expect(d).toContain('lookupSalesOrdersByNumber');
    expect(d).toContain('UNA tabla markdown por grupo');
    expect(d).toContain('NO pidió archivo');
    expect(d).not.toContain('El usuario pide un archivo');
  });

  it('lets a reasoning vision model transcribe photos itself (no extra readAttachment pass)', () => {
    const d = buildTurnDirectives({ message: 'hazme una tabla con cada orden y su motivo', tier: 'complex', attachmentKinds: ['image'], priorAttachmentKinds: [], modelReasonsWithVision: true });
    expect(d).toContain('Transcribe TÚ cada foto');
    expect(d).toContain('lookupSalesOrdersByNumber');
    expect(d).not.toContain('una llamada por imagen');
  });

  it('adds the composeDocument step when a file is requested, also for prior attachments', () => {
    const d = buildTurnDirectives({ message: 'Dame un pdf con todo', tier: 'complex', attachmentKinds: [], priorAttachmentKinds: ['image'] });
    expect(d).toContain('composeDocument');
    expect(d).toContain('appendix.includeAttachments=true');
    expect(d).toContain('re-adjuntados');
  });

  it('uses the document directive without attachments and the complex bar otherwise', () => {
    expect(buildTurnDirectives({ message: 'hazme un reporte en word de las ventas de septiembre', tier: 'standard', attachmentKinds: [], priorAttachmentKinds: [] })).toContain('generatePdfReport/generateExcelReport');
    expect(buildTurnDirectives({ message: 'analiza por qué cayeron las ventas', tier: 'complex', attachmentKinds: [], priorAttachmentKinds: [] })).toContain('tarea compleja');
  });

  it('stays silent for simple turns, voice and copilot auto-triggers', () => {
    expect(buildTurnDirectives({ message: 'gracias', tier: 'simple', attachmentKinds: [], priorAttachmentKinds: [] })).toBe('');
    expect(buildTurnDirectives({ message: 'analiza esto', tier: 'complex', attachmentKinds: ['image'], priorAttachmentKinds: [], voice: true })).toBe('');
    expect(buildTurnDirectives({ message: '⟦auto:open⟧', tier: 'complex', attachmentKinds: [], priorAttachmentKinds: [], autoTrigger: true })).toBe('');
  });
});

describe('looksUnfinished', () => {
  it('detects postponed work', () => {
    expect(looksUnfinished('He transcrito las órdenes. Ahora, voy a crear una tabla para mostrarte la información organizada. Un momento, por favor.')).toBe(true);
    expect(looksUnfinished('Procedo a generar el reporte.')).toBe(true);
  });
  it('accepts finished answers', () => {
    expect(looksUnfinished('Aquí está la tabla completa con las 65 órdenes.\n\n**Confianza:** Verificado — datos de lookupSalesOrdersByNumber')).toBe(false);
    expect(looksUnfinished('')).toBe(false);
  });
});

describe('stripMarkdownImages', () => {
  it('replaces markdown images with their alt text and removes stray bangs', () => {
    expect(stripMarkdownImages('Aquí tienes la tabla:\n\n![Órdenes de Venta Pendientes](https://x/app/assistant/api/artifacts/1)\n\nSi necesitas más.')).toBe(
      'Aquí tienes la tabla:\n\nÓrdenes de Venta Pendientes\n\nSi necesitas más.'
    );
    expect(stripMarkdownImages('Texto\n!\nMás')).toBe('Texto\n\nMás');
  });
});

describe('wantsDocument', () => {
  it('detects explicit requests and acceptances of an offer, nothing else', () => {
    expect(wantsDocument('Dame un pdf con todo')).toBe(true);
    expect(wantsDocument('pásamelo en excel')).toBe(true);
    expect(wantsDocument('Quiero que me hagas una tabla poniéndome cada orden de venta')).toBe(false);
    expect(wantsDocument('sí, dale', '…¿Quieres que te genere el PDF con todo esto?')).toBe(true);
    expect(wantsDocument('sí, dale', 'Aquí está la tabla completa.')).toBe(false);
    expect(wantsDocument('ok gracias')).toBe(false);
  });
});
