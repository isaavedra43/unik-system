import { describe, expect, it } from 'vitest';
import {
  candidateDedupeKey,
  dedupeCandidateDrafts,
  extractDomain,
  findMatchingCandidate,
  matchExistingSupplier,
  matchVendorContact,
  mergeCandidateDrafts,
  normalizeCompanyName,
  normalizePhone,
  type CandidateDraft,
} from './sourcing-dedupe';

function draft(overrides: Partial<CandidateDraft> & { name: string }): CandidateDraft {
  return { url: null, domain: null, email: null, phone: null, priceSnippets: [], evidence: [], confidence: null, ...overrides };
}

describe('normalización', () => {
  it('normalizeCompanyName quita razón social, signos, acentos y palabras vacías', () => {
    expect(normalizeCompanyName('Acme Materiales, S.A. de C.V.')).toBe('acme materiales');
    expect(normalizeCompanyName('Pisos & Azulejos del Norte S de RL de CV')).toBe('pisos azulejos norte');
    expect(normalizeCompanyName('Cerámica Única SAPI de CV')).toBe('ceramica unica');
    expect(normalizeCompanyName('')).toBe('');
  });

  it('extractDomain usa el sitio o el correo y descarta correos genéricos y directorios', () => {
    expect(extractDomain('https://www.acme.com.mx/productos?x=1')).toBe('acme.com.mx');
    expect(extractDomain('ventas@acme.com.mx')).toBe('acme.com.mx');
    expect(extractDomain('acme.com.mx')).toBe('acme.com.mx');
    expect(extractDomain('juan@gmail.com')).toBeNull();
    expect(extractDomain('https://facebook.com/acme')).toBeNull();
    expect(extractDomain('https://m.facebook.com/acme')).toBeNull();
    expect(extractDomain('no es url')).toBeNull();
  });

  it('normalizePhone deja 10 dígitos mexicanos', () => {
    expect(normalizePhone('+52 1 81 1234 5678')).toBe('8112345678');
    expect(normalizePhone('+52 81 1234 5678')).toBe('8112345678');
    expect(normalizePhone('(81) 1234-5678')).toBe('8112345678');
    expect(normalizePhone('01 81 1234 5678')).toBe('8112345678');
    expect(normalizePhone('+1 415 555 0100')).toBe('14155550100');
    expect(normalizePhone('123')).toBeNull();
  });
});

describe('llave e identidad', () => {
  it('dominio > teléfono > nombre', () => {
    expect(candidateDedupeKey(draft({ name: 'Acme', url: 'https://acme.com.mx', phone: '8112345678' }))).toBe('dom:acme.com.mx');
    expect(candidateDedupeKey(draft({ name: 'Acme', email: 'x@gmail.com', phone: '(81) 1234 5678' }))).toBe('tel:8112345678');
    expect(candidateDedupeKey(draft({ name: 'Acme Materiales S.A. de C.V.' }))).toBe('nom:acme materiales');
  });

  it('findMatchingCandidate encuentra la misma empresa por teléfono aunque la llave cambie', () => {
    const existing = [
      { id: 'c1', dedupeKey: 'tel:8112345678', name: 'Acme', phone: '8112345678' },
      { id: 'c2', dedupeKey: 'dom:beta.mx', name: 'Beta', domain: 'beta.mx' },
    ];
    expect(findMatchingCandidate(draft({ name: 'ACME SA', url: 'https://acme.mx', phone: '+52 81 1234 5678' }), existing)?.id).toBe('c1');
    expect(findMatchingCandidate(draft({ name: 'Beta', url: 'https://www.beta.mx/x' }), existing)?.id).toBe('c2');
    expect(findMatchingCandidate(draft({ name: 'Gamma' }), existing)).toBeNull();
  });
});

describe('proveedores existentes', () => {
  const suppliers = [
    { id: 's1', name: 'Acme Materiales', website: 'https://acme.com.mx', channels: [] },
    { id: 's2', name: 'Distribuidora Beta', channels: [{ type: 'whatsapp', value: '+52 81 5555 1234' }] },
    { id: 's3', name: 'AB', channels: [] },
  ];

  it('detecta por dominio, teléfono del canal o nombre normalizado', () => {
    expect(matchExistingSupplier(draft({ name: 'Otra', url: 'https://www.acme.com.mx/p' }), suppliers)).toEqual({ supplierId: 's1', reason: 'domain' });
    expect(matchExistingSupplier(draft({ name: 'Beta', phone: '8155551234' }), suppliers)).toEqual({ supplierId: 's2', reason: 'phone' });
    expect(matchExistingSupplier(draft({ name: 'ACME MATERIALES, S.A. DE C.V.' }), suppliers)).toEqual({ supplierId: 's1', reason: 'name' });
  });

  it('no confunde nombres muy cortos ni empresas distintas', () => {
    expect(matchExistingSupplier(draft({ name: 'AB' }), suppliers)).toBeNull();
    expect(matchExistingSupplier(draft({ name: 'Gamma', url: 'https://gamma.mx' }), suppliers)).toBeNull();
  });

  it('detecta un proveedor de Zoho por celular', () => {
    expect(
      matchVendorContact(draft({ name: 'X', phone: '81 2222 3333' }), [
        { zohoContactId: 'z1', companyName: 'Otra', mobile: '+528122223333' },
      ])
    ).toEqual({ zohoContactId: 'z1', reason: 'phone' });
  });
});

describe('fusión de candidatos', () => {
  it('conserva datos conocidos, la mayor confianza y la unión de precios y evidencias', () => {
    const merged = mergeCandidateDrafts(
      draft({
        name: 'Acme',
        url: 'https://acme.mx',
        confidence: 0.4,
        productsSummary: 'Porcelanato',
        priceSnippets: [{ text: '$200 m2', price: 200, currency: 'MXN', unit: 'm2', url: 'u1' }],
        evidence: [{ url: 'u1', fetchedAt: 't', objectId: 'o1', sha256: 'a' }],
      }),
      draft({
        name: 'Acme SA',
        phone: '8112345678',
        confidence: 0.8,
        productsSummary: 'Azulejo',
        priceSnippets: [
          { text: '$200 m2', price: 200, currency: 'MXN', unit: 'm2', url: 'u1' },
          { text: '$250 m2', price: 250, currency: 'MXN', unit: 'm2', url: 'u2' },
        ],
        evidence: [{ url: 'u2', fetchedAt: 't', objectId: 'o2', sha256: 'b' }],
      })
    );
    expect(merged).toMatchObject({ name: 'Acme', url: 'https://acme.mx', phone: '8112345678', confidence: 0.8, productsSummary: 'Porcelanato · Azulejo' });
    expect(merged.priceSnippets).toHaveLength(2);
    expect(merged.evidence).toHaveLength(2);
  });

  it('dedupeCandidateDrafts junta la misma empresa dentro de un resultado y omite nombres vacíos', () => {
    const out = dedupeCandidateDrafts([
      draft({ name: 'Acme', url: 'https://acme.mx/a', confidence: 0.3 }),
      draft({ name: 'Acme Materiales', url: 'https://www.acme.mx/b', confidence: 0.6 }),
      draft({ name: 'Beta', phone: '8111111111' }),
      draft({ name: '   ' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: 'Acme', dedupeKey: 'dom:acme.mx', confidence: 0.6 });
    expect(out[1].dedupeKey).toBe('tel:8111111111');
  });
});
