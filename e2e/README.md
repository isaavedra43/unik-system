# Pruebas end-to-end (Playwright)

Humo local del sistema. Estas pruebas **no** inician sesión, no necesitan datos sembrados y no llaman a
servicios externos (Zoho, Twilio, LiveKit, proveedores de IA).

| Archivo                     | Qué verifica                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `smoke.spec.ts`             | `GET /api/health` responde 200 con JSON; `/login` muestra el formulario; `/app` sin sesión redirige a `/login`                                                                                                           |
| `operations-visual.spec.ts` | Recorrido visual de operaciones en los cuatro anchos del plan (1366 / 1024 / 768 / 390): sin errores de consola, sin scroll horizontal, sin contenido recortado inalcanzable, sin `undefined`/`NaN` ni páginas en blanco |

`operations-visual.spec.ts` es la excepción a lo anterior: **sí** necesita sesión y datos sembrados, por eso se salta
entera cuando falta `PREVIEW_STORAGE_STATE`. Cómo levantar su vista previa está en `docs/pilot-runbook.md` §11.8;
`PREVIEW_WIDTHS=768` acota la corrida a un ancho cuando se persigue un breakpoint concreto.

La configuración está en `playwright.config.ts` (raíz): `testDir: './e2e'` y `baseURL: 'http://localhost:3000'`.
Playwright **no** levanta el servidor: debe estar corriendo antes de ejecutar las pruebas.

## Requisitos

1. Dependencias instaladas (`npm install`) y navegador de Playwright:

   ```bash
   npm run playwright:install
   ```

2. Una base PostgreSQL **local** en `DATABASE_URL` con las migraciones aplicadas (nunca la base de producción).
   `/api/health` ejecuta `SELECT 1`; sin base responde `503` y esa prueba falla.
3. No hacen falta credenciales de Zoho, Twilio ni IA. Deja `ZOHO_BOOKS_MOCK=true` si tu `.env.local` tiene
   variables de Zoho, para que nada escriba en Zoho al navegar manualmente.

## Ejecutar

En una terminal, el servidor en el puerto 3000:

```bash
npm run dev
# o, para probar el build de producción:
npm run build && npm run start
```

En otra terminal:

```bash
npx playwright test --project=chromium        # humo local
npx playwright test e2e/smoke.spec.ts --project=chromium --headed   # viendo el navegador
```

`npm run test:e2e` corre todos los proyectos definidos en `playwright.config.ts` (hoy sólo `chromium`).

No hay pruebas de regresión visual. Los scripts `test:visual` y `test:visual:update` y el proyecto `visual`
se retiraron porque no existía ninguna prueba `@visual` y siempre terminaban con "No tests found". Quien
agregue la primera prueba visual debe crear en el mismo cambio el proyecto, sus scripts y los snapshots de
referencia.

## Reglas para nuevas pruebas

- Sin servicios reales: nada de Zoho, Twilio, LiveKit ni proveedores de IA. Si una prueba necesita datos,
  usa fixtures locales y documenta cómo sembrarlos.
- Sin credenciales en el repositorio. Las pruebas que requieran sesión deben leer el usuario de variables de
  entorno locales y saltarse (`test.skip`) cuando no existan.
- Selectores por rol y texto visible en español (`getByRole`, `getByLabel`), no por clases CSS.
