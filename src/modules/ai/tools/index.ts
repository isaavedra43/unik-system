/**
 * tools/index.ts — Central import point that triggers tool registration.
 *
 * Every tool file calls `registerTool()` at module load time. Those calls
 * only execute when the file is actually imported somewhere. This barrel
 * file imports all tool modules so their side-effects (registrations) run.
 *
 * The orchestrator and any other consumer imports from here to guarantee
 * all tools are registered before `getAvailableTools()` is called.
 */

// Sales tools (ventas, productos, vendedores, sucursales, tendencias)
import './sales-tools';

// Universal search (busca en toda la base de datos)
import './search-tools';

// System tools (usuario actual, módulos, hora del sistema)
import './system-tools';

// Inventory tools (productos, stock, alertas de inventario)
import './inventory-tools';

// Customer tools (clientes, top clientes, segmentación)
import './customer-tools';

// Finance tools (cuentas por cobrar/pagar, balances, morosidad)
import './finance-tools';

// Analytics tools (comparaciones, rankings, métricas avanzadas)
import './analytics-tools';

// Advanced analytics (cross-tab, forecast, alerts, retention, bundles, aging)
import './advanced-analytics-tools';

// Operations tools (order items, notifications, integration status, team performance, dashboard)
import './operations-tools';

// Zoho Inventory integration tools (packages, invoices, payments, vendors, products)
import './zoho-inventory-tools';

// Estimate creation tool
import './estimate-tools';

// Artifact tools (PDF, Excel, CSV, tablas, gráficas)
import './artifact-tools';

// Export the registry API for consumers
export * from './registry';
