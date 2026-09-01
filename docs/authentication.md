# Autenticación, usuarios, roles y permisos (FASE 6.1)

Única fuente de verdad sobre autenticación y autorización en UNIK System.

## Arquitectura

Sesiones respaldadas por PostgreSQL. Sin JWT con roles/permisos, sin proveedores externos.

```
Usuario → Login → verificación bcrypt → token aleatorio (crypto.randomBytes(32))
       → PostgreSQL guarda SOLO el SHA-256 del token (AuthSession.tokenHash)
       → cookie HttpOnly `unik_session` con el token original
Cada request server-side:
  cookie → SHA-256 → AuthSession → User + Roles + RolePermission → autorizar
```

Ventajas: logout real, revocación de sesiones, desactivación inmediata de usuarios,
cambios de roles/permisos efectivos en el siguiente request, nada sensible en la cookie.

## Modelos Prisma

- `User`: username único (lowercase), email opcional único (lowercase), passwordHash
  (bcrypt), isActive, mustChangePassword, failedLoginAttempts, lockedUntil,
  lastLoginAt, passwordChangedAt. Los usuarios NO se eliminan desde UI: se
  activan/desactivan.
- `Role`: key única e INMUTABLE (slug generado al crear), name visible editable,
  isSystem (super_admin), isActive.
- `UserRole`: puente userId+roleId (PK compuesta).
- `RolePermission`: roleId + permissionKey (string validado contra el registry de código).
- `AuthSession`: tokenHash único (SHA-256), expiresAt, revokedAt.
- `AuditLog`: actorUserId?, action, targetType, targetId?, metadata Json?.

## Constantes centrales

`src/modules/auth/constants.ts`:

- `MAX_LOGIN_ATTEMPTS = 5`
- `LOGIN_LOCK_MINUTES = 15`
- `AUTH_SESSION_TTL_HOURS = 12`
- `SESSION_COOKIE_NAME = 'unik_session'`
- `SUPER_ADMIN_ROLE_KEY = 'super_admin'`
- `PASSWORD_MIN_LENGTH = 12`, `PASSWORD_MAX_LENGTH = 128`

## Password hashing

`src/modules/auth/password.ts`: bcryptjs, cost 12. Helpers centralizados
`hashPassword()`, `verifyPassword()`, `generateTemporaryPassword()`
(`crypto.randomBytes(18)` → base64url ≈ 24 chars). Nunca se loggea ni persiste
una contraseña o token en claro.

Política de contraseñas: mínimo 12 caracteres, máximo 128, sin reglas de
composición arbitrarias (`passwordSchema` de Zod).

## Login

`src/modules/auth/auth-service.ts` → `login(identifier, password)`:

1. Normaliza identifier (trim + lowercase) y busca por username O email.
2. Usuario inexistente o inactivo → compara contra un hash dummy (mitiga
   enumeración por timing) y devuelve error genérico
   "Usuario o contraseña incorrectos".
3. `lockedUntil > now` → mensaje genérico de acceso temporalmente no disponible.
4. Password incorrecto → `failedLoginAttempts + 1`; al llegar a 5 se bloquea 15
   minutos (`lockedUntil`) y el contador se reinicia.
5. Password correcto → contador a 0, `lastLoginAt`, crea `AuthSession` y devuelve
   el token para la cookie.

La Server Action `loginAction` coloca la cookie y redirige a `/app` o a
`/change-password` si `mustChangePassword`.

## Cookie

`unik_session`: HttpOnly, `secure` en producción, `SameSite=Lax`, `Path=/`,
`maxAge` = 12 horas (TTL de la sesión).

## Validación de sesión

`getCurrentSession()` (`src/modules/auth/authorization.ts`):

- tokenHash existe, `revokedAt = null`, `expiresAt > now`, `user.isActive`.
- Carga roles ACTIVOS y sus permissionKeys desde DB en cada request.
- Nada de roles/permisos en la cookie → cambios administrativos inmediatos.

## Autorización (deny by default)

Helpers server-side:

- `getCurrentSession()` / `getCurrentUser()`
- `requireAuthenticatedUser()` → redirect `/login`
- `hasPermission(user, key)` / `hasAnyPermission` / `hasAllPermissions`
- `requirePermission(key)` / `requireAnyPermission` / `requireAllPermissions`
  → para pages/layouts (redirect)
- `assertPermission(user, key)` / `assertAnyPermission` / `assertAllPermissions`
  → para Server Actions/services (lanzan `AuthorizationError`)

Regla: si el usuario NO es super_admin y ninguno de sus roles activos tiene el
permissionKey → **denegado**. No se asumen permisos.

### super_admin

`hasPermission` devuelve `true` para cualquier permiso si el usuario tiene el rol
`super_admin`. NO se llenan filas de RolePermission para super_admin: cualquier
permiso futuro aplica automáticamente. El rol es `isSystem`, no se puede
eliminar, ni editar, ni modificar sus permisos manualmente.

### UI visibility ≠ seguridad

El nav solo muestra "Usuarios"/"Roles y permisos" si el usuario tiene
`users.view`/`roles.view`, pero cada page/layout/action vuelve a validar
server-side con `requirePermission`/`assertPermission`. Ocultar un link nunca es
el control de acceso real.

## Permission Registry (code-first)

`src/modules/auth/permissions.ts`. No hay tabla Permission ni enum Prisma; las
definiciones viven en código y `RolePermission.permissionKey` se valida contra el
registry antes de persistir (`isKnownPermission`).

Permisos iniciales:

- `users.view`, `users.create`, `users.update`, `users.change_status`,
  `users.assign_roles`, `users.reset_password`
- `roles.view`, `roles.create`, `roles.update`, `roles.delete`,
  `roles.manage_permissions`

### Cómo agregar permisos de un módulo futuro (ejemplo: Inventory)

SIN migración de schema, SIN tocar User/Role:

1. Crear `src/modules/inventory/permissions.ts`:

   ```ts
   import { PermissionDefinition } from '@/modules/auth/permissions';

   export const INVENTORY_PERMISSIONS: PermissionDefinition[] = [
     {
       key: 'inventory.view',
       group: 'Inventario',
       label: 'Ver inventario',
       description: 'Permite visualizar el inventario',
     },
     {
       key: 'inventory.adjust',
       group: 'Inventario',
       label: 'Ajustar inventario',
       description: 'Permite realizar ajustes de inventario',
     },
   ];
   ```

2. Registrarlas en `PERMISSION_REGISTRY` (spread en
   `src/modules/auth/permissions.ts`).
3. Proteger la página: `await requirePermission('inventory.view')`.
4. Proteger cada Server Action: `assertPermission(actor, 'inventory.adjust')`.
5. Sidebar: mostrar el link solo con `hasPermission(user, 'inventory.view')`.
6. Ir a Administración → Roles y asignar los nuevos permisos.

## Gestión de usuarios (`/app/admin/users`)

- Requiere `users.view`; cada acción requiere su permiso específico.
- Crear usuario: name, username (inmutable después), email opcional, roles. El
  sistema genera una contraseña temporal segura que se muestra UNA sola vez
  (nunca se guarda en claro). `mustChangePassword = true`.
- Editar: solo name/email. Username inmutable desde UI (identificador estable).
- Activar/desactivar: al desactivar se revocan todas sus sesiones en la misma
  transacción. Un usuario desactivado no puede hacer login y sus sesiones dejan
  de validar inmediatamente.
- Asignar roles: reemplazo transaccional. No requiere revocar sesiones: los
  permisos se leen de DB en cada request.
- Reset de contraseña (users.reset_password): nueva temporal, mustChangePassword,
  revoca TODAS las sesiones del usuario, se muestra una sola vez.

### Protecciones

- **Escalación de privilegios**: solo un super_admin puede asignar/quitar
  super_admin o modificar (editar/desactivar/reset/roles) a otro super_admin.
  Validado server-side en `users-service`.
- **Último super_admin**: no se puede desactivar ni quitarle el rol al último
  super_admin ACTIVO.
- **Autoprotección**: nadie puede desactivarse a sí mismo desde User Management.

## Gestión de roles (`/app/admin/roles`)

- `roles.view` para ver; create/update/delete/manage_permissions granulares.
- Crear: name + description; `key` se genera como slug (`gerente_de_ventas`) y es
  inmutable.
- Editar: solo name/description de roles personalizados.
- Eliminar: solo roles personalizados SIN usuarios asignados (sin cascades
  silenciosos). Roles de sistema protegidos.
- `/app/admin/roles/[id]`: permisos agrupados por `group` con checkboxes;
  guardar reemplaza RolePermission en transacción validando cada key contra el
  registry. super_admin muestra "acceso total automático" sin checkboxes.

## Flujos de contraseña

- **First login / reset**: `mustChangePassword = true` → el layout `/app`
  redirige a `/change-password`. Tras el cambio: `mustChangePassword = false`,
  `passwordChangedAt = now`, se revocan las demás sesiones (la actual sigue viva)
  y se redirige a `/app`.
- **Cambio normal**: `/app/account/security` → requiere currentPassword +
  newPassword + confirmación; revoca las otras sesiones.
- **Cerrar sesión en todos los dispositivos**: revoca TODAS las sesiones (incluida
  la actual), borra cookie y redirige a `/login`.

## Logout

Server Action `logoutAction`: revoca la sesión de la cookie (revokedAt = now),
borra la cookie (aunque la sesión ya no exista en DB) y redirige a `/login`.

## Bootstrap del primer super_admin

`POST /api/internal/auth/bootstrap` — endpoint TÉCNICO protegido con
`X-UNIK-API-Key` (`UNIK_INTERNAL_API_KEY`). Solo funciona con `User.count() === 0`
(verificado también dentro de la transacción); después responde 409
`Bootstrap already completed` permanentemente. Crea/upserta el rol super_admin,
crea el usuario con `mustChangePassword = true` y asigna el rol. No devuelve ni
loggea la contraseña.

La API key interna NUNCA se usa desde el navegador; la app autenticada usa
services + Prisma server-side. La key queda solo para Postman/integraciones
técnicas.

## Audit log

`recordAuditEvent()` registra: `user.created`, `user.updated`, `user.disabled`,
`user.enabled`, `user.roles_changed`, `user.password_reset`, `role.created`,
`role.updated`, `role.deleted`, `role.permissions_changed`,
`auth.password_changed`, `auth.logout_all`. Nunca passwords, hashes, tokens,
cookies ni PII innecesaria en metadata. Sin UI todavía.

## Cómo proteger código nuevo

- **Server Component/Layout**: `const user = await requirePermission('x.y');`
- **Server Action**: `const session = await getCurrentSession(); if (!session) redirect('/login'); assertPermission(session.user, 'x.y');`
- **Route Handler interno técnico**: `isInternalApiKeyValid(request)` (solo
  integraciones, nunca browser).
- **Route Handler de app autenticada** (si llegara a necesitarse):
  `getCurrentSession()` + `assertPermission`.

## Límite cliente/servidor

Los Client Components NUNCA importan Prisma, password helpers, session service,
internals de authorization ni `UNIK_INTERNAL_API_KEY`. Solo reciben datos
serializados y llaman Server Actions. Todo lo que usa Prisma/bcrypt/crypto corre
en runtime Node (`export const runtime = 'nodejs'`), nunca Edge. No se usa
middleware como control de acceso.

## Limpieza de sesiones

Las sesiones expiradas simplemente dejan de validar (`expiresAt > now`). No hay
cron de limpieza por ahora; puede agregarse después si el volumen lo amerita.
