import { describe, expect, it } from 'vitest';

import { escapeHtml, isSafeHref, renderInline } from './markdown-inline';

describe('escapeHtml', () => {
  it('escapes markup metacharacters', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('a & "b" \'c\'')).toBe('a &amp; &quot;b&quot; &#39;c&#39;');
  });
});

describe('isSafeHref', () => {
  it('allows https, http, mailto, tel and relative links', () => {
    expect(isSafeHref('https://example.com/x?y=1')).toBe(true);
    expect(isSafeHref('http://example.com')).toBe(true);
    expect(isSafeHref('mailto:a@b.com')).toBe(true);
    expect(isSafeHref('tel:+521234')).toBe(true);
    expect(isSafeHref('/app/sales/orders')).toBe(true);
    expect(isSafeHref('./rel/path')).toBe(true);
    expect(isSafeHref('#anchor')).toBe(true);
    expect(isSafeHref('orders/123')).toBe(true);
  });

  it('rejects scriptable and smuggling schemes', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,<h1>x</h1>')).toBe(false);
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeHref('file:///etc/passwd')).toBe(false);
  });

  it('rejects schemes hidden by whitespace or control chars', () => {
    expect(isSafeHref('java\tscript:alert(1)')).toBe(false);
    expect(isSafeHref('java\nscript:alert(1)')).toBe(false);
    expect(isSafeHref('jav ascript:alert(1)')).toBe(false);
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
  });

  it('rejects schemes hidden by HTML entities (browser decodes attrs)', () => {
    expect(isSafeHref('&#106;avascript:alert(1)')).toBe(false);
    expect(isSafeHref('&#x6a;avascript:alert(1)')).toBe(false);
    expect(isSafeHref('&Tab;avascript:alert(1)')).toBe(false); // &Tab; unknown entity → stays, no scheme → borderline
  });
});

describe('renderInline', () => {
  it('keeps safe links and adds hardening attrs', () => {
    const out = renderInline('[folio](/app/sales/orders/1)');
    expect(out).toContain('href="/app/sales/orders/1"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it('renders link text without an anchor for dangerous urls', () => {
    const out = renderInline('[click](javascript:alert(1))');
    expect(out).not.toContain('<a');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('click');
  });

  it('escapes raw html in content (regression: escape was a no-op)', () => {
    const out = renderInline('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
});
