import { expect, test } from '@playwright/test';

/**
 * Local smoke tests. No login, no seeded data and no external services (Zoho, Twilio, AI).
 * Needs the app running on http://localhost:3000 with a local database — see e2e/README.md.
 */

test.describe('Humo local', () => {
  test('GET /api/health responde 200 con JSON', async ({ request }) => {
    const response = await request.get('/api/health');

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'ok', service: 'unik-system', database: 'connected' });
    expect(typeof body.timestamp).toBe('string');
  });

  test('/login renderiza el formulario', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByLabel('Usuario o correo')).toBeVisible();
    await expect(page.getByLabel('Contraseña', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible();
  });

  test('/app sin sesión redirige a /login', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/app');

    await expect(page).toHaveURL(/\/login(\?.*)?$/);
    await expect(page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible();
  });
});
