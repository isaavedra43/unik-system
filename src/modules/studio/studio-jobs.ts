import { registerJobHandler } from '@/modules/jobs/job-queue';
import { runStudioExport, STUDIO_EXPORT_JOB } from './studio-export-service';
// Registers the `studio_document` upload target and the `document` access resolver.
import './studio-storage-access';

/**
 * Background jobs owned by the studio.
 *
 * - studio.export → render + verify + store one StudioExport (interactive priority).
 *
 * PENDING INTEGRATION: `import '@/modules/studio/studio-jobs';` in
 * src/modules/jobs/register-handlers.ts.
 */

interface ExportPayload {
  exportId: string;
}

registerJobHandler<ExportPayload>(
  STUDIO_EXPORT_JOB,
  async (ctx) => {
    const result = await runStudioExport(ctx.payload.exportId);
    ctx.log('studio_export', { exportId: ctx.payload.exportId, status: result.status });
    return { status: result.status, storageObjectId: result.storageObjectId };
  },
  { timeoutMs: 5 * 60 * 1000 }
);
