/**
 * Barrel of operational commands.
 *
 * `registerCommand` runs as a side effect when a module is imported, so every
 * entry point that executes commands by type (the offline batch endpoint
 * `POST /app/operations/api/commands/batch`, job handlers, AI tools) imports
 * this file once to have the whole catalog available.
 *
 * Each operational module adds exactly one line here with the file where it
 * registers its commands. Loaded by: the command routes
 * (`src/app/app/operations/api/commands/_shared.ts`), the job barrel
 * (`src/modules/jobs/register-handlers.ts`) and the operations server actions.
 *
 * Keep it free of logic; ordering does not matter (the modules have no
 * runtime import cycles between them).
 */

// Operations core
import '@/modules/operations/approvals-service';
import '@/modules/operations/evidence-service';
import '@/modules/operations/work-items-service';
import '@/modules/operations/area-requests-service';
import '@/modules/operations/incidents-service';
// Case engine (case.start/advance) and re-planning (case.replan/cancel)
import '@/modules/operations/case-service';
import '@/modules/operations/replan';
// System-only commands (rejected for any other actor type)
import '@/modules/operations/supervisor';
import '@/modules/operations/seed';
// Domains
import '@/modules/inventory/inventory-commands';
import '@/modules/logistics/logistics-commands';
import '@/modules/purchases/purchases-commands';
import '@/modules/manufacturing/manufacturing-commands';
import '@/modules/finance/finance-commands';
import '@/modules/crm/crm-commands';
// Cross-module reactions inside commands (a delivery consumes its stock reservations)
import '@/modules/inventory/delivery-consumption';

export {};
