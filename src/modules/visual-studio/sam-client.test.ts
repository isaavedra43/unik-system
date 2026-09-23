import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests del cliente SAM: fetch mockeado — verifica el payload hacia el worker,
 * el bearer token y los errores normalizados.
 */

import { segmentImage, isSamConfigured, SamClientError } from './sam-client';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
  process.env.VISUAL_SAM_URL = 'http://127.0.0.1:8765';
  process.env.VISUAL_SAM_TOKEN = 'tok';
});

afterEach(() => {
  delete process.env.VISUAL_SAM_URL;
  delete process.env.VISUAL_SAM_TOKEN;
});

describe('sam-client', () => {
  it('sin VISUAL_SAM_URL falla con unconfigured', async () => {
    delete process.env.VISUAL_SAM_URL;
    expect(isSamConfigured()).toBe(false);
    await expect(
      segmentImage({ image: Buffer.from('x'), prompt: { points: [] } })
    ).rejects.toMatchObject({ code: 'unconfigured' });
  });

  it('envía imagen + puntos + caja como JSON y parsea la máscara', async () => {
    const mask = Buffer.from([1, 2, 3]).toString('base64');
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          mask_png_b64: mask,
          score: 0.9,
          width: 640,
          height: 480,
          model: 'sam2.1_hiera_tiny',
          device: 'mps',
        }),
        { status: 200 }
      )
    );
    const res = await segmentImage({
      image: Buffer.from('img'),
      prompt: {
        points: [
          { x: 10, y: 20, positive: true },
          { x: 5, y: 5, positive: false },
        ],
        box: { x: 1, y: 2, w: 3, h: 4 },
      },
    });
    expect(res.maskPng).toEqual(Buffer.from([1, 2, 3]));
    expect(res.score).toBe(0.9);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8765/segment');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const body = JSON.parse(init.body as string);
    expect(body.points).toEqual([
      { x: 10, y: 20, positive: true },
      { x: 5, y: 5, positive: false },
    ]);
    expect(body.box).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it('error HTTP del worker se normaliza', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(
      segmentImage({ image: Buffer.from('x'), prompt: { points: [] } })
    ).rejects.toBeInstanceOf(SamClientError);
  });

  it('respuesta sin máscara es inválida', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    await expect(
      segmentImage({ image: Buffer.from('x'), prompt: { points: [] } })
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});
