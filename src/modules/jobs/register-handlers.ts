/**
 * Barrel that registers every background job handler and recurring job.
 * Import it once (instrumentation.ts and the internal job endpoints) before
 * the worker starts so handlers exist when jobs are claimed.
 */
// Operational commands executed by job handlers (case engine, supervisor, logistics, inventory).
import '@/modules/operations/register-commands';
import '@/modules/storage/storage-jobs';
import '@/modules/extensions/extensions-jobs';
import '@/modules/copilot/copilot-jobs';
import '@/modules/voice/voice-jobs';
import '@/modules/campaigns/campaigns-jobs';
import '@/modules/comms/comms-jobs';
import '@/modules/ai/ai-jobs';
import '@/modules/notifications/notification-jobs';
import '@/modules/operations/operations-jobs';
import '@/modules/logistics/logistics-jobs';
import '@/modules/purchases/purchases-jobs';
import '@/modules/manufacturing/manufacturing-jobs';
import '@/modules/finance/finance-jobs';
import '@/modules/crm/crm-jobs';
import '@/modules/sales/close-tickets-jobs';
// Coordinated AI layer: agents.dispatch / stuck_scan / control_tower_digest handlers, and the
// dispatcher subscription to operational events, new cases and @mentions of bot users.
import '@/modules/agents/agents-jobs';
