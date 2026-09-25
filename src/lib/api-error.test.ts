import { describe, expect, it, vi } from 'vitest';
import { apiErrorResponse } from './api-error';

vi.spyOn(console, 'error').mockImplementation(() => {});

async function body(res: Response) {
  return res.json() as Promise<{ error: string }>;
}

describe('apiErrorResponse', () => {
  it('exposes the message for domain errors carrying a 4xx status', async () => {
    const err = Object.assign(new Error('El archivo excede 10 MB'), { status: 413 });
    const res = apiErrorResponse(err);
    expect(res.status).toBe(413);
    expect((await body(res)).error).toBe('El archivo excede 10 MB');
  });

  it('exposes messages for allow-listed error names at the given status', async () => {
    const err = new Error('Canal no encontrado');
    err.name = 'ChatError';
    const res = apiErrorResponse(err, { status: 400, safeNames: ['ChatError'] });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('Canal no encontrado');
  });

  it('does not leak messages for non-allow-listed named errors', async () => {
    const err = new Error('relation "SecretTable" does not exist');
    err.name = 'ChatError';
    const res = apiErrorResponse(err, { status: 400, safeNames: ['OtherError'] });
    expect(res.status).toBe(500);
    expect((await body(res)).error).toBe('Error interno');
  });

  it('hides generic Error internals behind a generic message', async () => {
    const res = apiErrorResponse(new Error('prisma: column p.secret'));
    expect(res.status).toBe(500);
    expect((await body(res)).error).toBe('Error interno');
  });

  it('hides non-Error throwables', async () => {
    const res = apiErrorResponse('weird string throw');
    expect(res.status).toBe(500);
    expect((await body(res)).error).toBe('Error interno');
  });
});
