# Extensiones del asistente: MCP, APIs, plugins, skills y conexiones

Única fuente de verdad sobre cómo UNIK amplía las capacidades del asistente sin ejecutar código arbitrario.

## 1. Conceptos

| Elemento | Definición en UNIK                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Conexión | Cuenta autorizada para acceder a un servicio (de equipo o personal). Secretos cifrados con AES-256-GCM y clave maestra fuera de PostgreSQL.                                                            |
| API      | Operaciones HTTP concretas (método, ruta, parámetros tipados, esquema del cuerpo, campos de respuesta). El modelo nunca recibe “llamar cualquier URL”.                                                 |
| MCP      | Servidor remoto (Streamable HTTP sobre HTTPS, SDK oficial) que expone herramientas. Descubrimiento como borrador; UNIK clasifica cada herramienta.                                                     |
| Skill    | Receta declarativa: entradas, instrucciones, referencias, herramientas admitidas, pasos con dependencias, condiciones de finalización, aprobaciones y límites. Sin `eval`, shell ni código descargado. |
| Plugin   | Paquete ZIP versionado (manifiesto JSON, skills, operaciones, plantillas, documentación, fixtures). Sin secretos ni código.                                                                            |

La primera versión **no** ejecuta scripts arbitrarios, no instala paquetes npm ni arranca servidores MCP locales aportados por usuarios.

## 2. Ejecutor común (`src/modules/ai/tools/registry.ts`)

Herramientas integradas y externas pasan por `executeTool`, que comprueba en orden:

1. Disponibilidad (extensión no suspendida, versión vigente, capacidad habilitada).
2. Habilitación: integradas por `enabledTools` del administrador; externas por capacidad aprobada + habilitada + rol permitido. **Las externas nunca se incorporan automáticamente a `enabledTools`: empiezan deshabilitadas.**
3. Permiso del actor.
4. Validación de argumentos (Zod; los esquemas JSON de MCP/OpenAPI se convierten con `json-schema-to-zod.ts`).
5. Clasificación de efecto y aprobación.
6. Timeout y límite de tamaño del resultado.
7. Auditoría (`ExtensionExecution`) y consumo (`UsageMeter`).

### Categorías de efecto

| Categoría        | Ejemplo                                         | Aprobación                                                                              |
| ---------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `read`           | Consultar una ficha                             | automática                                                                              |
| `draft`          | Preparar un documento privado (PDF/Excel/tabla) | automática                                                                              |
| `internal_task`  | Crear una solicitud autorizada                  | automática                                                                              |
| `external_send`  | Enviar un mensaje o archivo                     | **requiere aprobación**                                                                 |
| `business_write` | Crear una cotización oficial                    | **requiere aprobación**                                                                 |
| `destructive`    | Eliminar información                            | **requiere aprobación** (salvo mantenimiento marcado `auto`, p. ej. `cleanupArtifacts`) |

La clasificación la define UNIK tras revisión (`ExtensionCapability.effect`). Las anotaciones del servidor MCP o la descripción del modelo no otorgan confianza.

## 3. Propuestas y aprobación (`proposals-service.ts`)

Cuando una herramienta con efectos se invoca sin aprobación, el ejecutor crea un `AiProposal` y devuelve `needsApproval` al modelo, que debe pedir la aprobación al usuario (tarjeta en el chat). La aprobación queda ligada a:

- herramienta y versión; conexión; argumentos; destinatario; archivos y versiones; contexto comercial; usuario autorizador.

Cambiar cualquiera de esos elementos invalida la propuesta (hash recalculado al aprobar). `POST /app/assistant/api/proposals/:id/approve` ejecuta **exactamente** los argumentos guardados, una sola vez (reclamo atómico). Si el resultado es incierto (timeout tras posible envío), la propuesta queda `pending_review` y un operador la resuelve tras reconciliar; UNIK no afirma ejecución única garantizada.

## 4. Conexiones y comunicación externa

- Secretos cifrados con `UNIK_SECRETS_MASTER_KEY` (base64, 32 bytes); `UNIK_SECRETS_KEY_ID` identifica la clave para rotación (`*_PREVIOUS` para transición). Nunca se devuelven al navegador ni entran en prompts, resultados o logs (`redactDeep`).
- OAuth 2.0 con `state`, PKCE (S256) y callback registrado `/app/assistant/api/extensions/oauth/callback` (`APP_URL`). Bloqueo por conexión al refrescar tokens.
- Conexiones personales se ejecutan con la identidad del usuario; las de equipo con la política del administrador.
- Toda salida pasa por `safe-fetch.ts`: HTTPS, dominios y puertos aprobados por extensión, comprobación DNS (bloquea loopback, redes privadas, link-local, CGNAT y metadatos), redirecciones manuales revalidadas (sin credenciales entre orígenes), límites de tamaño/tipo y timeout. Los servicios internos de UNIK no se exponen por esta capa.

## 5. MCP remoto (`mcp-client-service.ts`)

- Transporte Streamable HTTP (HTTPS) con `fetch` policiado; cliente sin capacidades (sin sampling, roots ni elicitation).
- `Descubrir herramientas` crea una versión borrador; cada herramienta nace `pending`, `business_write`, `require_approval`, deshabilitada.
- Si el catálogo remoto cambia (nombre, descripción o esquema): la versión en uso se marca con nota, las herramientas alteradas o eliminadas se bloquean (`remoteChanged`) y sus propuestas pendientes se invalidan. No hay actualización automática de permisos.

## 6. APIs personalizadas (`api-runtime.ts`, `openapi-importer.ts`)

- Importación OpenAPI 3.x (JSON) con selección de operaciones; solo se resuelven `$ref` locales, las externas se ignoran y se reportan.
- Cada operación aprobada es una herramienta tipada: parámetros de ruta/consulta/cuerpo, selección de campos de respuesta, timeout, reintentos solo en operaciones idempotentes.
- Pruebas: lecturas en vivo; escrituras muestran el destino exacto y requieren `confirmWrite`; fixtures para pruebas controladas.

## 7. Skills (`skills-service.ts`, `skill-runner.ts`)

Definición (Zod-validada): `inputs`, `instructions`, `references`, `allowedTools`, `steps` (`tool` / `check` / `note` con `dependsOn`, `when`, `requireApproval`), `completion`, `limits`. Las plantillas `{{inputs.x}}` / `{{steps.id.result.path}}` son búsquedas de ruta puras. El runner rechaza cualquier paso que use una herramienta fuera de `allowedTools`, pausa en `waiting_approval` y reanuda cuando la propuesta se aprueba (`SkillRun` en PostgreSQL). Skills personales: sin permiso adicional; de equipo: `skills.manage` para publicar.

## 8. Plugins (`plugin-importer.ts`, `plugin-service.ts`)

Formato: ZIP con `manifest.json` (`manifestVersion: 1`, namespace, name, version, connections, api, operations, skills, templates, docs, contextTags). Validaciones al importar: tamaño (≤5 MB, ≤200 entradas), tipos (`.json .md .txt .hbs .html .csv`), rutas (sin `..`), sin secretos ni `<script>`. Versión identificada por hash de contenido. Estados: `draft → testing → pending_approval → approved → enabled → suspended`. Desinstalar (revocar) deshabilita capacidades, cancela jobs del grupo `extension:<id>`, revoca conexiones y conserva historial y auditoría.

## 9. Interfaz

- Administración: `/app/admin/extensions` (permisos `extensions.view` / `extensions.manage` / `skills.manage`) con pestañas **Catálogo · Conexiones · MCP · APIs · Skills · Plugins · Ejecuciones · Consumo** y, por extensión: quién la publicó, estado, versión, datos/efectos, roles autorizados, última prueba, errores, consumo y suspensión inmediata.
- Usuario: `/app/assistant/extensions` (catálogo aprobado, conectar/desconectar cuenta propia con `extensions.connect`, skills personales).
- En el asistente solo se cargan las capacidades disponibles para ese usuario y contexto (`contextTags`).

## 10. Contratos de API

| Endpoint                                             | Función                                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `POST /app/assistant/api/extensions`                 | Crear borrador (admin)                                                                        |
| `POST /app/assistant/api/extensions/:id/test`        | Prueba controlada (fixture / lectura / escritura confirmada)                                  |
| `POST /app/assistant/api/extensions/:id/approve`     | Aprobar versión (y opcionalmente habilitar)                                                   |
| `POST /app/assistant/api/extensions/:id/disable`     | Suspender (o revocar) de inmediato                                                            |
| `POST /app/assistant/api/proposals/:id/approve`      | Autorizar propuesta exacta                                                                    |
| `POST /app/assistant/api/proposals/:id/reject`       | Rechazar propuesta                                                                            |
| `GET /app/assistant/api/extensions/catalog`          | Catálogo del usuario                                                                          |
| `POST /app/assistant/api/extensions/:id/connections` | Conectar cuenta (personal/equipo)                                                             |
| `POST /app/assistant/api/extensions/:id/oauth/start` | Iniciar OAuth                                                                                 |
| `POST /app/assistant/api/skills[/:id/run]`           | Crear / ejecutar skill                                                                        |
| `/app/admin/extensions/api/*`                        | Transiciones, sync MCP, import OpenAPI, plugin, revisión de capacidades, ejecuciones, consumo |

Los identificadores no conceden permisos: cada ruta vuelve a resolver actor, ámbito y recurso.

## 11. Variables de entorno

```
UNIK_SECRETS_MASTER_KEY=            # base64 de 32 bytes: openssl rand -base64 32
UNIK_SECRETS_KEY_ID=k1
UNIK_SECRETS_MASTER_KEY_PREVIOUS=   # solo durante rotación
UNIK_SECRETS_KEY_ID_PREVIOUS=
APP_URL=https://tu-app              # callback OAuth
```

## 12. Pruebas locales

- `src/modules/ai/tools/registry.test.ts`: herramienta deshabilitada invocada directamente, sin permiso, rol no autorizado, suspendida, timeout, resultado recortado, resultado incierto, propuesta creada y ejecución única con propuesta aprobada, carga por contexto.
- `src/modules/extensions/extensions-core.test.ts`: cifrado/rotación, redacción de tokens, DNS/redirecciones/tamaños en egreso, JSON Schema→Zod, plantillas sin evaluación, OpenAPI con referencia remota no autorizada.
- `src/modules/extensions/skills-and-plugins.test.ts`: skill que intenta una herramienta fuera de su lista, pausa/reanudación por aprobación, condiciones, plugin con traversal/secretos/scripts.

Un servidor MCP real y una API real quedan **pendientes de validación manual** (mocks y fixtures aprobados no equivalen a integración validada).
