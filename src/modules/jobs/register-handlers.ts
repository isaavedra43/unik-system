/**
 * Barrel that registers every background job handler and recurring job.
 * Import it once (instrumentation.ts and the internal job endpoints) before
 * the worker starts so handlers exist when jobs are claimed.
 */
import '@/modules/storage/storage-jobs';
import '@/modules/extensions/extensions-jobs';
import '@/modules/copilot/copilot-jobs';
import '@/modules/voice/voice-jobs';
import '@/modules/campaigns/campaigns-jobs';
import '@/modules/comms/comms-jobs';
