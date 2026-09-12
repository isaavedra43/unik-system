import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'crypto';
import {
  decryptSecret,
  encryptSecret,
  maskSecret,
  redactDeep,
  reencryptIfStale,
  resetKeyRingCache,
} from './secrets';
import { EgressError, isHostAllowed, isPublicAddress, safeFetch } from './safe-fetch';
import { canonicalJson, jsonSchemaToZod } from './json-schema-to-zod';
import { evaluateCondition, lookupPath, resolveTemplates, TemplateError } from './skill-templates';
import { importOpenApi, selectResponseFields } from './openapi-importer';

describe('secrets', () => {
  beforeAll(() => {
    process.env.UNIK_SECRETS_MASTER_KEY = randomBytes(32).toString('base64');
    process.env.UNIK_SECRETS_KEY_ID = 'k2';
    process.env.UNIK_SECRETS_MASTER_KEY_PREVIOUS = randomBytes(32).toString('base64');
    process.env.UNIK_SECRETS_KEY_ID_PREVIOUS = 'k1';
    resetKeyRingCache();
  });

  it('encrypts and decrypts with the current key and records the key id', () => {
    const enc = encryptSecret('sk-live-1234567890');
    expect(enc.keyId).toBe('k2');
    expect(enc.ciphertext).not.toContain('sk-live');
    expect(decryptSecret(enc)).toBe('sk-live-1234567890');
  });

  it('rejects tampered ciphertext', () => {
    const enc = encryptSecret('secret');
    const tampered = { ...enc, ciphertext: enc.ciphertext.slice(0, -3) + 'abc' };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('supports rotation: previous key decrypts, re-encrypt moves to current', () => {
    // Build a ciphertext with the previous key by temporarily swapping envs.
    const current = process.env.UNIK_SECRETS_MASTER_KEY!;
    process.env.UNIK_SECRETS_MASTER_KEY = process.env.UNIK_SECRETS_MASTER_KEY_PREVIOUS;
    process.env.UNIK_SECRETS_KEY_ID = 'k1';
    resetKeyRingCache();
    const old = encryptSecret('rotate-me');
    process.env.UNIK_SECRETS_MASTER_KEY = current;
    process.env.UNIK_SECRETS_KEY_ID = 'k2';
    resetKeyRingCache();
    expect(old.keyId).toBe('k1');
    expect(decryptSecret(old)).toBe('rotate-me');
    const fresh = reencryptIfStale(old);
    expect(fresh.keyId).toBe('k2');
    expect(decryptSecret(fresh)).toBe('rotate-me');
  });

  it('masks and redacts secrets in results', () => {
    expect(maskSecret('abcdef')).toBe('••••cdef');
    const redacted = redactDeep({
      apiKey: 'sk-1234567890abcdefghij',
      nested: {
        authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
        note: 'token sk-abcdefghijklmnopqrstuvwxyz inside',
      },
      list: ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'],
    });
    expect(redacted.apiKey).toBe('[REDACTED]');
    expect(redacted.nested.authorization).toBe('[REDACTED]');
    expect(redacted.nested.note).toContain('[REDACTED]');
    expect(redacted.list[0]).toBe('[REDACTED]');
  });
});

describe('safe-fetch egress control', () => {
  it('classifies private, loopback, link-local and metadata addresses', () => {
    expect(isPublicAddress('127.0.0.1')).toBe(false);
    expect(isPublicAddress('10.1.2.3')).toBe(false);
    expect(isPublicAddress('192.168.1.1')).toBe(false);
    expect(isPublicAddress('172.16.5.5')).toBe(false);
    expect(isPublicAddress('169.254.169.254')).toBe(false);
    expect(isPublicAddress('100.64.0.1')).toBe(false);
    expect(isPublicAddress('::1')).toBe(false);
    expect(isPublicAddress('fd00::1')).toBe(false);
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700::1111')).toBe(true);
  });

  it('matches exact hosts and wildcard subdomains only', () => {
    expect(isHostAllowed('api.example.com', ['api.example.com'])).toBe(true);
    expect(isHostAllowed('x.api.example.com', ['*.example.com'])).toBe(true);
    expect(isHostAllowed('example.com', ['*.example.com'])).toBe(false);
    expect(isHostAllowed('evil-example.com', ['*.example.com'])).toBe(false);
  });

  it('refuses http, unapproved hosts, unapproved ports and IP literals to internal ranges', async () => {
    const policy = { allowedHosts: ['api.example.com'] };
    await expect(safeFetch('http://api.example.com/x', {}, policy)).rejects.toMatchObject({
      code: 'scheme',
    });
    await expect(safeFetch('https://other.example.com/x', {}, policy)).rejects.toMatchObject({
      code: 'host',
    });
    await expect(safeFetch('https://api.example.com:8443/x', {}, policy)).rejects.toMatchObject({
      code: 'port',
    });
    await expect(
      safeFetch(
        'https://169.254.169.254/latest/meta-data',
        {},
        { allowedHosts: ['169.254.169.254'] }
      )
    ).rejects.toMatchObject({ code: 'private_address' });
  });

  it('follows redirects manually, re-validates and drops Authorization across origins', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
      if (url.startsWith('https://a.example.com/')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://b.example.com/final' },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const publicLookup = async () => ['93.184.216.34'];
    const res = await safeFetch(
      'https://a.example.com/start',
      { headers: { Authorization: 'Bearer secret' } },
      { allowedHosts: ['a.example.com', 'b.example.com'], lookup: publicLookup },
      fakeFetch
    );
    expect(res.status).toBe(200);
    expect(calls[0].headers.Authorization).toBe('Bearer secret');
    expect(calls[1].headers.Authorization).toBeUndefined();

    // A redirect towards an unapproved host is blocked.
    const toEvil: typeof fetch = async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example.org/' } });
    await expect(
      safeFetch(
        'https://a.example.com/x',
        {},
        { allowedHosts: ['a.example.com'], lookup: publicLookup },
        toEvil
      )
    ).rejects.toBeInstanceOf(EgressError);

    // DNS pointing a public name at an internal address is blocked too (rebinding).
    const rebinding = async () => ['93.184.216.34', '10.0.0.5'];
    await expect(
      safeFetch(
        'https://a.example.com/x',
        {},
        { allowedHosts: ['a.example.com'], lookup: rebinding },
        fakeFetch
      )
    ).rejects.toMatchObject({ code: 'private_address' });
  });

  it('bounds the response size and content type', async () => {
    const lookup = async () => ['93.184.216.34'];
    const big: typeof fetch = async () =>
      new Response('x'.repeat(5000), { status: 200, headers: { 'content-type': 'text/plain' } });
    await expect(
      safeFetch(
        'https://a.example.com/x',
        {},
        { allowedHosts: ['a.example.com'], maxResponseBytes: 1000, lookup },
        big
      )
    ).rejects.toMatchObject({ code: 'too_large' });
    const binary: typeof fetch = async () =>
      new Response('x', { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    await expect(
      safeFetch('https://a.example.com/x', {}, { allowedHosts: ['a.example.com'], lookup }, binary)
    ).rejects.toMatchObject({ code: 'content_type' });
  });
});

describe('jsonSchemaToZod', () => {
  it('validates objects with required/optional, enums, arrays and numbers', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        customer: { type: 'string', minLength: 1 },
        qty: { type: 'integer', minimum: 1 },
        mode: { type: 'string', enum: ['fast', 'slow'] },
        tags: { type: 'array', items: { type: 'string' } },
        note: { type: ['string', 'null'] },
      },
      required: ['customer', 'qty'],
      additionalProperties: false,
    });
    expect(
      schema.safeParse({ customer: 'A', qty: 2, mode: 'fast', tags: ['x'], note: null }).success
    ).toBe(true);
    expect(schema.safeParse({ customer: '', qty: 2 }).success).toBe(false);
    expect(schema.safeParse({ customer: 'A', qty: 0 }).success).toBe(false);
    expect(schema.safeParse({ customer: 'A', qty: 1, mode: 'medium' }).success).toBe(false);
    expect(schema.safeParse({ customer: 'A', qty: 1, extra: true }).success).toBe(false);
  });

  it('produces a stable fingerprint regardless of key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 })
    );
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});

describe('skill templates', () => {
  const data = {
    inputs: { material: 'Mármol', qty: 3 },
    steps: { lookup: { result: { items: [{ sku: 'M-1', price: 10 }] } } },
  };

  it('resolves paths and interpolations without evaluating code', () => {
    expect(lookupPath(data, 'inputs.material')).toBe('Mármol');
    expect(lookupPath(data, 'steps.lookup.result.items[0].sku')).toBe('M-1');
    expect(
      resolveTemplates(
        {
          text: 'Cotizar {{inputs.qty}} de {{inputs.material}}',
          raw: '{{steps.lookup.result.items}}',
        },
        data
      )
    ).toEqual({
      text: 'Cotizar 3 de Mármol',
      raw: [{ sku: 'M-1', price: 10 }],
    });
    expect(() => lookupPath(data, 'inputs.material; process.exit()')).toThrow(TemplateError);
    expect(() => lookupPath(data, 'constructor.prototype')).not.toThrow();
    expect(lookupPath({}, '__proto__.polluted')).toBeUndefined();
  });

  it('evaluates declarative conditions', () => {
    expect(evaluateCondition({ path: 'inputs.qty', op: 'gt', value: 2 }, data)).toBe(true);
    expect(evaluateCondition({ path: 'inputs.missing', op: 'empty' }, data)).toBe(true);
    expect(evaluateCondition({ path: 'inputs.material', op: 'contains', value: 'rm' }, data)).toBe(
      true
    );
    expect(evaluateCondition({ path: 'inputs.material', op: 'in', value: ['Granito'] }, data)).toBe(
      false
    );
  });
});

describe('openapi importer', () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'Proveedor', version: '1.0' },
    servers: [{ url: 'https://api.proveedor.com/v1' }],
    components: {
      schemas: {
        Item: {
          type: 'object',
          properties: { sku: { type: 'string' }, stock: { type: 'integer' } },
        },
        External: { $ref: 'https://evil.example.com/schema.json' },
      },
    },
    paths: {
      '/items/{sku}': {
        parameters: [{ name: 'sku', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          operationId: 'getItem',
          summary: 'Consultar disponibilidad',
          responses: {
            '200': {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } },
            },
          },
        },
        delete: { summary: 'Eliminar item', responses: { '204': {} } },
      },
      '/orders': {
        post: {
          operationId: 'createOrder',
          requestBody: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/External' } } },
          },
          responses: { '201': {} },
        },
      },
    },
  };

  it('extracts operations, resolves local refs and refuses external ones', () => {
    const result = importOpenApi(doc);
    expect(result.title).toBe('Proveedor');
    expect(result.servers).toEqual(['https://api.proveedor.com/v1']);
    const get = result.operations.find((o) => o.operationId === 'getItem')!;
    expect(get.method).toBe('GET');
    expect(get.pathParams.required).toEqual(['sku']);
    expect(get.responseSchema).toMatchObject({ type: 'object' });
    expect(get.suggestedEffect).toBe('read');
    const del = result.operations.find((o) => o.method === 'DELETE')!;
    expect(del.suggestedEffect).toBe('destructive');
    const post = result.operations.find((o) => o.operationId === 'createOrder')!;
    expect(post.suggestedEffect).toBe('business_write');
    expect(result.warnings.some((w) => w.includes('externa'))).toBe(true);
  });

  it('rejects non-3.x documents', () => {
    expect(() => importOpenApi({ swagger: '2.0' })).toThrow();
  });

  it('selects response fields including arrays', () => {
    const value = {
      data: {
        items: [
          { sku: 'a', secret: 1 },
          { sku: 'b', secret: 2 },
        ],
        total: 2,
      },
      token: 'x',
    };
    expect(selectResponseFields(value, ['data.items[].sku', 'data.total'])).toEqual({
      data: { items: [{ sku: 'a' }, { sku: 'b' }], total: 2 },
    });
  });
});
