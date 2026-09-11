import { registerTool, emptyParameters } from './registry';
// 'z' import removed — not needed for system tools without params

/**
 * System tools: provide context about the current user and system state.
 * These do NOT require module permissions (they only return data about the
 * actor themselves).
 */

registerTool({
  name: 'getCurrentUserContext',
  description:
    'Devuelve el contexto del usuario actual: nombre, username, roles, permisos y módulos accesibles.',
  category: 'system',
  enabledByDefault: true,
  parameters: emptyParameters,
  execute: async (actor) => {
    return {
      name: actor.name,
      username: actor.username,
      email: actor.email,
      isSuperAdmin: actor.isSuperAdmin,
      roleKeys: actor.roleKeys,
      permissionKeys: actor.permissionKeys,
    };
  },
});

registerTool({
  name: 'getModuleList',
  description:
    'Lista los módulos de negocio accesibles para el usuario actual según sus permisos.',
  category: 'system',
  enabledByDefault: true,
  parameters: emptyParameters,
  execute: async (actor) => {
    const modules: Array<{ key: string; label: string; accessible: boolean }> = [];
    const has = (k: string) => actor.permissionKeys.includes(k as never) || actor.isSuperAdmin;
    modules.push({
      key: 'sales_orders',
      label: 'Órdenes de Venta',
      accessible: has('sales_orders.view'),
    });
    modules.push({
      key: 'analytics',
      label: 'Analytics (KPIs, rankings, tendencias, pronósticos)',
      accessible: has('sales_orders.view'),
    });
    modules.push({
      key: 'customers',
      label: 'Clientes (top, segmentación, retención)',
      accessible: has('sales_orders.view'),
    });
    modules.push({
      key: 'finance',
      label: 'Finanzas (cuentas por cobrar, ingresos, antigüedad)',
      accessible: has('sales_orders.view'),
    });
    modules.push({
      key: 'inventory',
      label: 'Inventario (productos, stock, bundles)',
      accessible: has('sales_orders.view'),
    });
    modules.push({
      key: 'purchase_orders',
      label: 'Órdenes de Compra — pedidos a proveedores, items, fechas de entrega',
      accessible: has('purchase_orders.view'),
    });
    modules.push({
      key: 'bills',
      label: 'Facturas de Compra — facturas de proveedores, saldos, vencimientos',
      accessible: has('bills.view'),
    });
    modules.push({
      key: 'vendor_credits',
      label: 'Créditos de Proveedor — notas de crédito de proveedores',
      accessible: has('vendor_credits.view'),
    });
    modules.push({
      key: 'payments',
      label: 'Pagos — pagos recibidos de clientes, métodos de pago',
      accessible: has('payments.view'),
    });
    modules.push({
      key: 'invoices',
      label: 'Facturas — facturas a clientes, CFDI, saldos',
      accessible: has('invoices.view'),
    });
    modules.push({
      key: 'packages',
      label: 'Paquetes — envíos, tracking, carriers, direcciones',
      accessible: has('packages.view'),
    });
    modules.push({
      key: 'products',
      label: 'Productos — catálogo, stock, categorías, marcas',
      accessible: has('products.view'),
    });
    modules.push({
      key: 'customers',
      label: 'Clientes — saldos, créditos, direcciones',
      accessible: has('customers.view'),
    });
    modules.push({
      key: 'vendors',
      label: 'Proveedores — saldos, créditos',
      accessible: has('vendors.view'),
    });
    modules.push({ key: 'users', label: 'Usuarios', accessible: has('users.view') });
    modules.push({ key: 'roles', label: 'Roles y permisos', accessible: has('roles.view') });
    modules.push({
      key: 'integrations',
      label: 'Integraciones (Zoho, sincronización)',
      accessible: has('integrations.view'),
    });
    modules.push({
      key: 'notifications',
      label: 'Notificaciones (alertas, cambios)',
      accessible: true,
    });
    return { modules };
  },
});

registerTool({
  name: 'getSystemTime',
  description: 'Devuelve la fecha y hora actual del servidor, zona horaria y locale.',
  category: 'system',
  enabledByDefault: true,
  parameters: emptyParameters,
  execute: async () => {
    const now = new Date();
    return {
      iso: now.toISOString(),
      locale: 'es-MX',
      timezone: 'America/Mexico_City',
      dateOnly: now.toISOString().slice(0, 10),
      fullDate: now.toLocaleString('es-MX', { dateStyle: 'full', timeStyle: 'short' }),
    };
  },
});
