import { describe, expect, it } from 'vitest';
import { describeRouteForPrompt, heuristicRoute, type RoutingEnvelope } from './routing-envelope';

const jevRoute: RoutingEnvelope = {
  path: 'deep',
  domains: ['ventas'],
  needsRag: false,
  needsBrowser: true,
  needsComputer: false,
  needsDelegation: true,
  delegateTo: 'researcher',
  spawnVsReuse: 'spawn',
  modelClass: 'deep',
  parallelizable: true,
  fanout: 4,
  riskClass: 'external_send',
  needsApproval: true,
  memoryWorthy: false,
  source: 'jev',
  durationMs: 120,
};

describe('describeRouteForPrompt', () => {
  it('turns the Jev decision into working guidance for the model', () => {
    const text = describeRouteForPrompt(jevRoute)!;
    expect(text).toMatch(/RUTA DEL TURNO/);
    expect(text).toMatch(/a fondo/);
    expect(text).toMatch(/buscar o navegar en internet/);
    expect(text).toMatch(/delegar a un investigador/);
    expect(text).toMatch(/en paralelo/);
    expect(text).toMatch(/mensajes a terceros/);
    expect(text).toMatch(/aprobación/);
  });

  it('adds nothing for heuristic envelopes', () => {
    expect(describeRouteForPrompt(heuristicRoute({ message: 'hola' }))).toBeNull();
  });
});
