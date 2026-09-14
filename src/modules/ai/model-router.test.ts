import { describe, expect, it } from 'vitest';
import { AUTO_MODEL_ID, classifyTask, pickModelForTier, resolveTurnModel } from './model-router';

const settings = {
  deployment: 'gpt-4o',
  fallbackDeployment: 'gpt-4o-mini',
  routingEnabled: true,
  routingSimpleModel: 'gpt-4o-mini',
  routingStandardModel: '',
  routingComplexModel: '',
};

describe('classifyTask', () => {
  it('greetings and acknowledgements are simple', () => {
    expect(classifyTask({ message: 'hola' }).tier).toBe('simple');
    expect(classifyTask({ message: 'gracias, perfecto' }).tier).toBe('simple');
  });

  it('data questions are standard', () => {
    expect(classifyTask({ message: 'dime las ventas en efectivo de la semana pasada' }).tier).toBe('standard');
    expect(classifyTask({ message: 'mandale mensaje a papa diciendole hola' }).tier).toBe('standard');
  });

  it('analysis, multi-domain and documents are complex', () => {
    expect(classifyTask({ message: 'analiza la tendencia de ventas del trimestre y explica por qué cayó marzo' }).tier).toBe('complex');
    expect(classifyTask({ message: 'arma un reporte trimestral con clientes top, productos más vendidos y anomalías' }).tier).toBe('complex');
    expect(classifyTask({ message: 'lee esta factura', attachmentKinds: ['document'] }).tier).toBe('complex');
    expect(classifyTask({ message: 'hola', planFirst: true }).tier).toBe('complex');
  });

  it('a short follow-up after tools stays standard, images need vision', () => {
    expect(classifyTask({ message: 'ok', recentToolNames: ['querySalesOrders'] }).tier).toBe('standard');
    const img = classifyTask({ message: 'qué ves aquí', attachmentKinds: ['image'] });
    expect(img.needsVision).toBe(true);
  });
});

describe('resolveTurnModel', () => {
  it('respects an explicit model', () => {
    const d = resolveTurnModel(settings, 'o3-mini', classifyTask({ message: 'hola' }));
    expect(d.model).toBe('o3-mini');
    expect(d.routed).toBe(false);
  });

  it('routes simple turns to the cheap model when auto', () => {
    const d = resolveTurnModel(settings, AUTO_MODEL_ID, classifyTask({ message: 'hola' }));
    expect(d.model).toBe('gpt-4o-mini');
    expect(d.routed).toBe(true);
  });

  it('routes complex turns to the primary model and keeps vision-capable models for images', () => {
    expect(resolveTurnModel(settings, undefined, classifyTask({ message: 'analiza y compara ventas vs el año pasado' })).model).toBe('gpt-4o');
    const noVision = { ...settings, routingSimpleModel: 'o3-mini' };
    const d = resolveTurnModel(noVision, undefined, { tier: 'simple', reason: 'x', needsVision: true });
    expect(d.model).toBe('gpt-4o');
  });

  it('uses the primary model when routing is disabled', () => {
    const d = resolveTurnModel({ ...settings, routingEnabled: false }, undefined, classifyTask({ message: 'hola' }));
    expect(d.model).toBe('gpt-4o');
    expect(d.routed).toBe(false);
  });

  it('pickModelForTier falls back sensibly', () => {
    expect(pickModelForTier({ ...settings, routingSimpleModel: '' }, 'simple')).toBe('gpt-4o-mini');
    expect(pickModelForTier(settings, 'complex')).toBe('gpt-4o');
  });
});

describe('routine tier', () => {
  it('standard turns use the routine model when configured', () => {
    const split = { ...settings, routingStandardModel: 'moonshotai/kimi-k2.6', routingComplexModel: 'gpt-4o' };
    expect(pickModelForTier(split, 'standard')).toBe('moonshotai/kimi-k2.6');
    expect(pickModelForTier(split, 'complex')).toBe('gpt-4o');
    expect(resolveTurnModel(split, AUTO_MODEL_ID, classifyTask({ message: 'dime las ventas de hoy' })).model).toBe('moonshotai/kimi-k2.6');
  });
});
