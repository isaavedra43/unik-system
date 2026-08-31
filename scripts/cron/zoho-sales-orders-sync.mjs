#!/usr/bin/env node

/**
 * Railway Cron one-shot runner for Zoho Sales Orders sync.
 * Does NOT connect to Zoho or PostgreSQL directly.
 * It calls the internal UNIK endpoint exactly like a manual sync.
 */

const DEFAULT_MAX_DETAIL_FETCHES = 50;
const MIN_MAX_DETAIL_FETCHES = 1;
const MAX_MAX_DETAIL_FETCHES = 200;
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

function log(payload) {
  console.log(JSON.stringify(payload));
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getMaxDetailFetches() {
  const raw = process.env.ZOHO_SALES_ORDERS_CRON_MAX_DETAIL_FETCHES;
  if (!raw) {
    return DEFAULT_MAX_DETAIL_FETCHES;
  }

  const parsed = Number(raw);
  if (
    Number.isNaN(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < MIN_MAX_DETAIL_FETCHES ||
    parsed > MAX_MAX_DETAIL_FETCHES
  ) {
    throw new Error(
      `ZOHO_SALES_ORDERS_CRON_MAX_DETAIL_FETCHES must be an integer between ${MIN_MAX_DETAIL_FETCHES} and ${MAX_MAX_DETAIL_FETCHES}`
    );
  }

  return parsed;
}

function buildTargetUrl(baseUrl) {
  const trimmed = baseUrl.trim().replace(/\/$/, '');
  return `${trimmed}/api/internal/zoho/sync/sales-orders`;
}

async function main() {
  const startedAt = Date.now();

  try {
    const appUrl = getRequiredEnv('APP_URL');
    const apiKey = getRequiredEnv('UNIK_INTERNAL_API_KEY');
    const maxDetailFetches = getMaxDetailFetches();

    const targetUrl = buildTargetUrl(appUrl);

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-UNIK-API-Key': apiKey,
      },
      body: JSON.stringify({
        mode: 'sync',
        max_detail_fetches: maxDetailFetches,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 409) {
      log({
        event: 'zoho.sales_orders.cron.skipped',
        reason: 'sync_already_running',
        status: response.status,
        cronDurationMs: Date.now() - startedAt,
      });
      process.exitCode = 0;
      return;
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      // Non-JSON response; body intentionally not logged.
    }

    if (!response.ok) {
      const errorMessage = body && typeof body === 'object' && 'error' in body ? body.error : null;
      log({
        event: 'zoho.sales_orders.cron.failed',
        reason: 'http_error',
        status: response.status,
        error: typeof errorMessage === 'string' ? errorMessage : null,
        cronDurationMs: Date.now() - startedAt,
      });
      process.exitCode = 1;
      return;
    }

    if (!body || typeof body !== 'object' || body.status !== 'completed' || body.mode !== 'sync') {
      log({
        event: 'zoho.sales_orders.cron.failed',
        reason: 'unexpected_response',
        error: 'Response did not indicate a completed sync',
        cronDurationMs: Date.now() - startedAt,
      });
      process.exitCode = 1;
      return;
    }

    log({
      event: 'zoho.sales_orders.cron.completed',
      runId: body.run_id ?? null,
      mode: body.mode,
      pagesScanned: body.pages_scanned ?? null,
      recordsSeen: body.records_seen ?? null,
      recordsPending: body.records_pending ?? null,
      detailsFetched: body.details_fetched ?? null,
      detailsFailed: body.details_failed ?? null,
      apiCalls: body.api_calls ?? null,
      cronDurationMs: Date.now() - startedAt,
    });

    process.exitCode = 0;
    return;
  } catch (error) {
    const reason = error && error.name === 'TimeoutError' ? 'timeout' : 'network_error';
    const apiKey = process.env.UNIK_INTERNAL_API_KEY || '';
    const rawMessage = error && typeof error.message === 'string' ? error.message : 'Unknown error';
    const safeMessage =
      apiKey && apiKey.length > 0 ? rawMessage.replaceAll(apiKey, '[REDACTED]') : rawMessage;

    log({
      event: 'zoho.sales_orders.cron.failed',
      reason,
      error: safeMessage,
      cronDurationMs: Date.now() - startedAt,
    });
    process.exitCode = 1;
    return;
  }
}

await main();
