import { describe, expect, it } from 'vitest';
import { findForbiddenUiCode } from './tools/interactive-ui-tools';
import { toolStepLabel } from '@/components/copilot/copilot-types';
import { detectRequiredCapabilities, describeSourcesUsed } from './capabilities';

describe('renderInteractiveUi sanitizer', () => {
  it('accepts a normal comparator interface', () => {
    const code = `<div class="cards"><h2>Tarifas</h2><button onclick="unik.prompt('más detalles')">Detalles</button></div><script>console.log('ok')</script>`;
    expect(findForbiddenUiCode(code)).toBeNull();
  });

  it('rejects password fields (credential phishing)', () => {
    expect(findForbiddenUiCode('<input type="password" name="pw">')).not.toBeNull();
    expect(findForbiddenUiCode("<input type='password'>")).not.toBeNull();
    expect(findForbiddenUiCode('<input type=password>')).not.toBeNull();
  });

  it('rejects browser credential/storage access', () => {
    expect(findForbiddenUiCode('x = document.cookie')).not.toBeNull();
    expect(findForbiddenUiCode('localStorage.getItem("k")')).not.toBeNull();
    expect(findForbiddenUiCode('sessionStorage.setItem("a",1)')).not.toBeNull();
  });

  it('rejects external form posts', () => {
    expect(findForbiddenUiCode('<form action="https://evil.test/x">')).not.toBeNull();
  });

  it('rejects hidden fields carrying data', () => {
    expect(findForbiddenUiCode('<input type="hidden" value="eyJhbGciOiJIUzI1NiJ9">')).not.toBeNull();
  });
});

describe('toolStepLabel', () => {
  it('surfaces the search query', () => {
    expect(toolStepLabel('web_search', { query: 'arena de gato' }, 'running')).toBe(
      'Buscando en internet: arena de gato'
    );
  });

  it('shows only the host for URLs', () => {
    expect(toolStepLabel('fetch_url', { url: 'https://x.com/a/status/123?ref=src' }, 'done')).toBe(
      'Leí la página: x.com'
    );
  });

  it('falls back to the plain label without args', () => {
    expect(toolStepLabel('querySalesOrders', null)).toBe('Órdenes revisadas');
  });
});

describe('interactive-ui capability', () => {
  it('detects comparator/calculator intent', () => {
    const caps = detectRequiredCapabilities('hazme una calculadora de precios').map((c) => c.cap);
    expect(caps).toContain('ui');
    expect(detectRequiredCapabilities('hazme un comparador de estas tarifas').map((c) => c.cap)).toContain('ui');
  });

  it('labels renderInteractiveUi as a real source', () => {
    expect(describeSourcesUsed(['renderInteractiveUi'])).toContain('interfaz interactiva');
  });
});
