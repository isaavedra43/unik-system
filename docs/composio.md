# Composio: apps externas del asistente

Composio conecta el asistente con cientos de apps (Gmail, Google Calendar, Slack, GitHub, Notion, Sheets, Drive, HubSpot, Stripe…) sin instalar ni operar servidores MCP propios. Reemplaza las guías «MCP local» del catálogo antiguo (retiradas de la UI; el MCP remoto por HTTPS sigue en Admin → Extensiones → MCP, p. ej. Higgsfield).

## Configuración

| Dónde                              | Qué                                                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Railway → Variables                | `COMPOSIO_API_KEY` (obligatoria). `COMPOSIO_BASE_URL` (opcional). `APP_URL` ya existente: se usa para el callback.           |
| Migración                          | `20260924120000_composio_toolkit_policy` (aditiva: una tabla). La aplica el Pre-deploy de Railway (`prisma migrate deploy`). |
| Admin → Extensiones → **Composio** | Agregar apps del catálogo, habilitarlas, elegir roles y revisar/ajustar el efecto de cada herramienta.                       |
| Roles                              | `extensions.connect` permite conectar la cuenta propia; `assistant.use` usar el asistente; `extensions.manage` administrar.  |

Sin `COMPOSIO_API_KEY` las herramientas `composio*` no se ofrecen y el panel lo indica.

## Cómo funciona

```
Usuario → asistente → composioListToolkits / composioSearchTools → composioConnect (si falta la cuenta) → composioExecute
                                                       │
                              UNIK: política (toolkit habilitado + rol) → efecto clasificado por UNIK → aprobación si aplica → Composio
```

- **Cuatro herramientas estables** (no miles): `composioListToolkits`, `composioSearchTools` (búsqueda por caso de uso, con esquema y efecto), `composioConnect` (botón «Conectar» en el chat) y `composioExecute` (una herramienta por slug exacto).
- **Identidad**: cada persona usa su propia cuenta (`userId` de Composio = `unik_<id>`). UNIK no guarda tokens ni contraseñas; solo la política (`ComposioToolkitPolicy`).
- **Política**: un toolkit se usa solo si un administrador lo habilitó y el rol del usuario está permitido (vacío = solo super admin). La sesión de Composio se crea con esa misma lista, así que Composio también la aplica. «Agregar» en el catálogo lo crea ya habilitado (sin roles asignados = solo super admin), para que «Mi cuenta» → Conectar funcione de inmediato; el administrador ajusta los roles después en la pestaña Composio.
- **Efecto y aprobación**: lo decide UNIK (`composio-effects.ts`), nunca la herramienta ni sus etiquetas: verbo de lectura claro → `read` (directo); enviar/publicar → `external_send`; crear/actualizar → `business_write`; borrar/cancelar → `destructive`; desconocido → `business_write`. Las etiquetas de Composio solo pueden **subir** un efecto. El administrador puede fijar el efecto de cada herramienta y ocultar herramientas. Todo lo que no es lectura genera una tarjeta de aprobación ligada al slug y argumentos exactos.
- **Falla cerrada**: si el toolkit se revoca después de proponer, la aprobación ya no ejecuta.
- **Validación previa**: los argumentos se revisan contra el esquema antes de pedir aprobación (no se gasta una aprobación en una llamada mal formada).
- **Resultados**: acotados a 48 KB sin romper el JSON (arreglos recortados con conteo de omitidos), con secretos enmascarados y auditados en «Ejecuciones» (`composio:<SLUG>`). Un timeout de una escritura queda como `pending_review` (pudo completarse).
- **Datos = no instrucciones**: el prompt indica que correos, mensajes e issues son datos.

## Componentes generativos en el chat

Cuando una herramienta externa devuelve datos, el chat dibuja tarjetas en vez de JSON (`src/modules/ai/generative-ui/`, `src/components/assistant/generative/`):

| Componente           | Cuándo                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `records` / `record` | listas o fichas (correos, eventos, issues, mensajes…): título, subtítulo, fecha, badge, campos y enlace |
| `table`              | hojas de cálculo (`values`) o filas homogéneas                                                          |
| `notice`             | acción completada, error o resultado por confirmar                                                      |
| `connect`            | botón «Conectar» con espera y refresco automático; al conectar, el chat continúa solo                   |
| `mcp_ui`             | componente `ui://` de un servidor MCP (renderer oficial `@mcp-ui/client`)                               |

Seguridad del modelo de UI:

1. Ni el modelo ni un servidor externo escriben HTML/JSX que UNIK ejecute: los resultados se convierten en **datos** (spec JSON cerrada) y un registro fijo de componentes React los dibuja. Solo URLs `http(s)`.
2. `mcp_ui` es la única excepción: HTML de un servidor MCP en un iframe con `sandbox="allow-scripts"` (origen opaco: sin cookies, storage ni DOM de UNIK). Solo `text/html` (≤120 KB) y `text/uri-list` https. El HTML no se envía al modelo.
3. Lo que el iframe **pide** (enviar un prompt, abrir un enlace, ejecutar una herramienta) no ocurre hasta que el usuario lo confirma en la UI de UNIK; las herramientas pasan como mensaje normal del chat y por sus aprobaciones.
4. Las tarjetas se reconstruyen desde el historial persistido, así que se ven igual al recargar.

## Endpoints

| Ruta                                                    | Función                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /app/assistant/api/composio/toolkits`              | apps habilitadas para el usuario + estado de conexión                         |
| `POST /app/assistant/api/composio/connect`              | enlace de autorización de Composio (se crea al pulsar el botón; no se guarda) |
| `GET /app/assistant/api/composio/callback`              | regreso desde Composio; no confía en nada del query string                    |
| `DELETE /app/assistant/api/composio/connections/:id`    | desconectar una cuenta propia (se verifica pertenencia)                       |
| `GET/PUT /app/admin/extensions/api/composio`            | catálogo + política (`extensions.manage` para escribir)                       |
| `GET /app/admin/extensions/api/composio/tools?toolkit=` | herramientas del toolkit con su efecto                                        |

## Pruebas locales (sin Composio real)

`composio-effects.test.ts`, `validate-args.test.ts` (incluye `shrinkJson`), `tools/composio-tools.test.ts` (efecto dinámico, aprobación, falla cerrada), `generative-ui/build-ui.test.ts`.

## Pendiente de validación manual (requiere Composio real)

Cargar `COMPOSIO_API_KEY` en Railway y aplicar la migración; agregar y habilitar un toolkit; conectar una cuenta real desde el chat y desde «Mis apps»; una lectura real (p. ej. `GMAIL_FETCH_EMAILS`) y ver la tarjeta; un envío real con su tarjeta de aprobación; revocar el toolkit y comprobar que una propuesta pendiente deja de ejecutarse; confirmar las formas reales de respuesta de cada toolkit (las tarjetas usan heurísticas por nombre de campo: si alguna app se ve pobre, se ajusta `build-ui.ts`).
