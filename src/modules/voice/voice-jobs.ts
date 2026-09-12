import { registerJobHandler, JOB_PRIORITY } from '@/modules/jobs/job-queue';
import { registerRecurringJob } from '@/modules/jobs/scheduled-jobs';
import {
  runVoiceRetention,
  transcribeRecording,
  VOICE_COPILOT_JOB,
  VOICE_RETENTION_JOB,
  VOICE_SUMMARIZE_JOB,
  VOICE_TRANSCRIBE_JOB,
} from './voice-service';
import { runCopilot, summarizeCall } from './voice-ai-service';
// Registers recording/transcript access resolvers in the worker process too.
import './voice-access';

/**
 * Background jobs owned by the voice module.
 *
 * - voice.transcribe → after `egress_ended`: stream recording → STT → transcript object
 * - voice.summarize  → after a call ends (or after transcription): summary + tasks
 * - voice.copilot    → every N live segments: suggestions for the human agent
 * - voice.retention  → daily: expired recordings (30 d) and transcripts (90 d)
 *
 * Every handler re-checks `aiState`/`aiGeneration`: work started before
 * "Pausar IA" is discarded on arrival.
 */

interface CallGenerationPayload {
  callId: string;
  generation: number;
  upToCount?: number;
}

registerJobHandler<CallGenerationPayload>(
  VOICE_TRANSCRIBE_JOB,
  async (ctx) => {
    const result = await transcribeRecording(ctx.payload.callId, ctx.payload.generation);
    ctx.log('transcribed', { callId: ctx.payload.callId, ...result });
    return result;
  },
  { timeoutMs: 15 * 60 * 1000 }
);

registerJobHandler<CallGenerationPayload>(
  VOICE_SUMMARIZE_JOB,
  async (ctx) => {
    const result = await summarizeCall(ctx.payload.callId, ctx.payload.generation);
    ctx.log('summarized', { callId: ctx.payload.callId, skipped: result.skipped ?? null });
    return result;
  },
  { timeoutMs: 5 * 60 * 1000 }
);

registerJobHandler<CallGenerationPayload>(
  VOICE_COPILOT_JOB,
  async (ctx) => {
    const result = await runCopilot(
      ctx.payload.callId,
      ctx.payload.generation,
      ctx.payload.upToCount
    );
    ctx.log('copilot', { callId: ctx.payload.callId, skipped: result.skipped ?? null });
    return result;
  },
  { timeoutMs: 60 * 1000 }
);

registerJobHandler(
  VOICE_RETENTION_JOB,
  async (ctx) => {
    const result = await runVoiceRetention();
    ctx.log('retention', result);
    return result;
  },
  { timeoutMs: 30 * 60 * 1000 }
);

registerRecurringJob({
  type: VOICE_RETENTION_JOB,
  everyMs: 24 * 60 * 60 * 1000,
  priority: JOB_PRIORITY.maintenance,
});
