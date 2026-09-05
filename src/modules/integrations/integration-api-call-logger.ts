import { prisma } from '@/lib/prisma';

/**
 * Integration API call logger.
 *
 * Records every outbound HTTP call made to an external integration (Zoho,
 * future APIs, etc.) into the IntegrationApiCall table. This gives the admin
 * UI a full, queryable history of:
 *   - which endpoint was called
 *   - the HTTP method and status
 *   - the duration
 *   - whether it succeeded or failed
 *   - a truncated response preview for debugging
 *
 * Logging is fire-and-forget: a failed log write must never break the actual
 * API call. We also cap the response preview to avoid storing huge payloads.
 */

const MAX_PREVIEW_LENGTH = 4096;

export interface LogApiCallInput {
  source: string;
  method: string;
  path: string;
  httpStatus?: number;
  durationMs: number;
  success: boolean;
  errorCode?: string;
  responsePreview?: string;
}

/**
 * Persists one API call row. Never throws — a logging failure is swallowed
 * and logged to stderr so it doesn't break the caller's flow.
 */
export function logIntegrationApiCall(input: LogApiCallInput): void {
  const preview = input.responsePreview
    ? input.responsePreview.length > MAX_PREVIEW_LENGTH
      ? input.responsePreview.slice(0, MAX_PREVIEW_LENGTH) + '…[truncated]'
      : input.responsePreview
    : null;

  void prisma.integrationApiCall
    .create({
      data: {
        source: input.source,
        method: input.method,
        path: input.path,
        httpStatus: input.httpStatus ?? null,
        durationMs: input.durationMs,
        success: input.success,
        errorCode: input.errorCode ?? null,
        responsePreview: preview,
      },
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          event: 'integration.api_call.log_failed',
          source: input.source,
          path: input.path,
          error: error instanceof Error ? error.message : 'unknown',
        })
      );
    });
}

/** Returns recent API calls for a source, newest first. */
export async function listIntegrationApiCalls(
  source: string,
  options: { limit?: number; onlyErrors?: boolean; offset?: number } = {}
) {
  const { limit = 100, onlyErrors = false, offset = 0 } = options;
  return prisma.integrationApiCall.findMany({
    where: onlyErrors ? { source, success: false } : { source },
    orderBy: { createdAt: 'desc' },
    take: limit,
    skip: offset,
  });
}

export interface ApiCallStats {
  totalCalls: number;
  successCount: number;
  errorCount: number;
  avgDurationMs: number;
  last24hCount: number;
  last24hErrorCount: number;
}

/** Aggregated stats for the monitoring dashboard. */
export async function getApiCallStats(source: string): Promise<ApiCallStats> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [total, success, last24h, last24hErrors, avgAgg] = await Promise.all([
    prisma.integrationApiCall.count({ where: { source } }),
    prisma.integrationApiCall.count({ where: { source, success: true } }),
    prisma.integrationApiCall.count({ where: { source, createdAt: { gte: since24h } } }),
    prisma.integrationApiCall.count({
      where: { source, success: false, createdAt: { gte: since24h } },
    }),
    prisma.integrationApiCall.aggregate({
      where: { source },
      _avg: { durationMs: true },
    }),
  ]);

  return {
    totalCalls: total,
    successCount: success,
    errorCount: total - success,
    avgDurationMs: avgAgg._avg.durationMs ?? 0,
    last24hCount: last24h,
    last24hErrorCount: last24hErrors,
  };
}
