import { registerJobHandler } from '@/modules/jobs/job-queue';
import { KNOWLEDGE_PROCESS_JOB, processVersion } from './knowledge-service';

interface ProcessPayload {
  versionId: string;
  allowedHosts?: string[];
}

registerJobHandler<ProcessPayload>(
  KNOWLEDGE_PROCESS_JOB,
  async (ctx) => processVersion(ctx.payload.versionId, ctx.payload.allowedHosts ?? []),
  { timeoutMs: 15 * 60 * 1000 }
);
