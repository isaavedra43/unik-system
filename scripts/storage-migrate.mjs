#!/usr/bin/env node
/**
 * Legacy file migration driver (runs the steps through the internal API so it
 * works against Railway without a shell on the instance).
 *
 * Usage:
 *   UNIK_BASE_URL=https://unik.example UNIK_INTERNAL_API_KEY=... \
 *     node scripts/storage-migrate.mjs inventory|dry-run|copy|verify|reconcile [--batch 50]
 *
 * Every step is resumable and never deletes originals. Run them in order:
 *   inventory → dry-run → copy → verify → reconcile
 */
const [mode, ...rest] = process.argv.slice(2);
const MODES = ['inventory', 'dry-run', 'copy', 'verify', 'reconcile'];
if (!MODES.includes(mode)) {
  console.error(`Uso: node scripts/storage-migrate.mjs <${MODES.join('|')}> [--batch N]`);
  process.exit(1);
}
const baseUrl = (process.env.UNIK_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const apiKey = process.env.UNIK_INTERNAL_API_KEY;
if (!apiKey) {
  console.error('Falta UNIK_INTERNAL_API_KEY');
  process.exit(1);
}
const batchIdx = rest.indexOf('--batch');
const batch = batchIdx >= 0 ? Number(rest[batchIdx + 1]) : undefined;

const headers = { 'Content-Type': 'application/json', 'X-UNIK-API-Key': apiKey };
const res = await fetch(`${baseUrl}/api/internal/storage/migrate`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ mode, batch_size: batch, wait_seconds: 0 }),
});
const started = await res.json();
if (!res.ok) {
  console.error('Error:', started);
  process.exit(1);
}
console.log(
  `Job ${started.job_id} encolado (${mode})${started.deduplicated ? ' — ya estaba en curso' : ''}`
);

for (;;) {
  await new Promise((r) => setTimeout(r, 3000));
  const st = await fetch(`${baseUrl}/api/internal/storage/jobs/${started.job_id}`, { headers });
  const job = await st.json();
  process.stdout.write(`\r${job.status} ${job.progress ?? 0}%   `);
  if (['completed', 'failed', 'cancelled'].includes(job.status)) {
    console.log('');
    if (job.last_error) console.error('Error:', job.last_error);
    console.log(JSON.stringify(job.result, null, 2));
    process.exit(job.status === 'completed' ? 0 : 2);
  }
}
