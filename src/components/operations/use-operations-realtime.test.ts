import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openOperationsStreamCount, subscribeToOperationsStream } from './use-operations-realtime';

/**
 * Cada página de área tenía DOS suscriptores al mismo canal (el chip del shell y
 * el centro de trabajo) y Comunicaciones hasta cuatro: cuatro conexiones SSE
 * permanentes dejan sólo dos del cupo de seis por origen en HTTP/1.1.
 */

interface FakeListener {
  type: string;
  fn: EventListener;
}

class FakeEventSource {
  static opened: string[] = [];
  static closed = 0;
  readonly listeners: FakeListener[] = [];
  closedFlag = false;

  constructor(readonly url: string) {
    FakeEventSource.opened.push(url);
  }

  addEventListener(type: string, fn: EventListener): void {
    this.listeners.push({ type, fn });
  }

  removeEventListener(type: string, fn: EventListener): void {
    const index = this.listeners.findIndex((entry) => entry.type === type && entry.fn === fn);
    if (index >= 0) this.listeners.splice(index, 1);
  }

  close(): void {
    this.closedFlag = true;
    FakeEventSource.closed += 1;
  }

  emit(type: string, data: unknown): void {
    for (const entry of [...this.listeners]) {
      if (entry.type !== type) continue;
      entry.fn({ type, data: JSON.stringify(data) } as unknown as Event);
    }
  }
}

const sources: FakeEventSource[] = [];

beforeEach(() => {
  FakeEventSource.opened = [];
  FakeEventSource.closed = 0;
  sources.length = 0;
  vi.stubGlobal(
    'EventSource',
    class extends FakeEventSource {
      constructor(url: string) {
        super(url);
        sources.push(this);
      }
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscribeToOperationsStream', () => {
  it('abre UNA conexión para dos suscriptores del mismo canal', () => {
    const first = vi.fn();
    const second = vi.fn();
    const offA = subscribeToOperationsStream('area:ventas', ['ops.events'], first);
    const offB = subscribeToOperationsStream('area:ventas', ['ops.events'], second);

    expect(FakeEventSource.opened).toHaveLength(1);
    expect(openOperationsStreamCount()).toBe(1);

    sources[0]!.emit('ops.events', { id: 'e1' });
    expect(first).toHaveBeenCalledWith('ops.events', { id: 'e1' });
    expect(second).toHaveBeenCalledWith('ops.events', { id: 'e1' });

    offA();
    offB();
  });

  it('no cierra mientras quede un suscriptor y cierra con el último', () => {
    const offA = subscribeToOperationsStream('area:compras', ['ops.events'], vi.fn());
    const offB = subscribeToOperationsStream('area:compras', ['ops.events'], vi.fn());

    offA();
    expect(FakeEventSource.closed).toBe(0);
    offB();
    expect(FakeEventSource.closed).toBe(1);
    expect(openOperationsStreamCount()).toBe(0);
  });

  it('desuscribirse dos veces no cierra la conexión de otro', () => {
    const off = subscribeToOperationsStream('area:logistica', ['ops.events'], vi.fn());
    off();
    off();
    const other = subscribeToOperationsStream('area:logistica', ['ops.events'], vi.fn());
    expect(FakeEventSource.opened).toHaveLength(2);
    expect(FakeEventSource.closed).toBe(1);
    other();
  });

  it('canales distintos abren conexiones distintas', () => {
    const offA = subscribeToOperationsStream('area:ventas', ['ops.events'], vi.fn());
    const offB = subscribeToOperationsStream('case:c1', ['ops.events'], vi.fn());
    expect(openOperationsStreamCount()).toBe(2);
    offA();
    offB();
  });

  it('un JSON inválido no tumba al resto de los suscriptores', () => {
    const handler = vi.fn();
    const off = subscribeToOperationsStream('area:inventario', ['ops.events'], handler);
    const source = sources[0]!;
    for (const entry of source.listeners) {
      entry.fn({ type: 'ops.events', data: 'no-json' } as unknown as Event);
    }
    expect(handler).not.toHaveBeenCalled();
    source.emit('ops.events', { ok: true });
    expect(handler).toHaveBeenCalledWith('ops.events', { ok: true });
    off();
  });
});
