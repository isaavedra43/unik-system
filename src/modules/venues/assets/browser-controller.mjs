/**
 * UNIK browser controller — runs INSIDE the Daytona sandbox.
 *
 * Self-contained Node HTTP server on 127.0.0.1:3100 driving a headless
 * chromium via playwright-core. UNIK's server uploads this file, starts it
 * with UNIK_BROWSER_TOKEN set, and reaches it through Daytona's signed
 * preview link. Every request must carry `x-unik-token`.
 *
 * Security:
 *   - Binds localhost only; Daytona's preview proxy is the only way in.
 *   - Token required on every request — the URL is not a secret on its own.
 *   - Secrets (useCredential.secretValue) are only ever typed into the page —
 *     never echoed back, never logged.
 */
import http from 'node:http';
import { chromium } from 'playwright-core';

const PORT = 3100;
const TOKEN = process.env.UNIK_BROWSER_TOKEN || '';
const CHROME_PATH = process.env.UNIK_CHROME_PATH || '/usr/bin/chromium';
const MAX_CONTENT_CHARS = 40_000;

let browser = null;
let context = null;
const tabs = new Map(); // id -> Page
let activeTabId = null;
let nextTab = 1;

async function ensureBrowser() {
  if (browser) return;
  browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  context = await browser.newContext({
    viewport: { width: 1366, height: 850 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
}

async function newTab() {
  await ensureBrowser();
  const page = await context.newPage();
  const id = `t${nextTab++}`;
  tabs.set(id, page);
  activeTabId = id;
  return id;
}

function activePage() {
  if (activeTabId && tabs.has(activeTabId)) return tabs.get(activeTabId);
  return null;
}

async function tabList() {
  const out = [];
  for (const [id, page] of tabs) {
    out.push({ id, url: page.url(), title: await page.title().catch(() => ''), active: id === activeTabId });
  }
  return out;
}

/** Readable extraction without Readability: headings/paragraphs/lists/tables. */
async function extractReadable(page) {
  return page.evaluate(() => {
    const kill = ['script', 'style', 'noscript', 'iframe', 'form', 'nav', 'footer', 'header[role="banner"]'];
    const root = document.querySelector('main') || document.querySelector('article') || document.body;
    if (!root) return '';
    const clone = root.cloneNode(true);
    for (const sel of kill) for (const el of clone.querySelectorAll(sel)) el.remove();
    const parts = [];
    for (const el of clone.querySelectorAll('h1,h2,h3,h4,p,li,td,th,a[href]')) {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length < 2) continue;
      if (/^H[1-4]$/.test(el.tagName)) parts.push(`\n${'#'.repeat(Number(el.tagName[1]))} ${t}\n`);
      else if (el.tagName === 'A') parts.push(`[${t}](${el.href})`);
      else if (el.tagName === 'LI') parts.push(`- ${t}`);
      else parts.push(t);
    }
    return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  });
}

async function act(body) {
  const { action } = body;
  const timeoutMs = Math.min(Math.max(body.timeoutMs ?? 15_000, 1_000), 60_000);

  if (action === 'open' || action === 'newTab') {
    const url = String(body.url || '');
    if (!/^https?:\/\//.test(url)) return { ok: false, error: 'URL debe ser http(s)' };
    const id = action === 'newTab' || !activePage() ? await newTab() : activeTabId;
    const page = tabs.get(id);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    return { ok: true, url: page.url(), title: await page.title().catch(() => '') };
  }

  const page = activePage();
  if (!page) return { ok: false, error: 'No hay pestaña activa — usa open o newTab primero' };

  switch (action) {
    case 'back':
      await page.goBack({ timeout: timeoutMs }).catch(() => null);
      return { ok: true, url: page.url(), title: await page.title().catch(() => '') };
    case 'forward':
      await page.goForward({ timeout: timeoutMs }).catch(() => null);
      return { ok: true, url: page.url(), title: await page.title().catch(() => '') };
    case 'click': {
      if (!body.selector) return { ok: false, error: 'selector requerido' };
      await page.click(String(body.selector), { timeout: timeoutMs });
      return { ok: true, url: page.url(), title: await page.title().catch(() => '') };
    }
    case 'type': {
      if (!body.selector) return { ok: false, error: 'selector requerido' };
      await page.fill(String(body.selector), String(body.text ?? ''), { timeout: timeoutMs });
      return { ok: true };
    }
    case 'press': {
      await page.keyboard.press(String(body.key || 'Enter'));
      await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => null);
      return { ok: true, url: page.url(), title: await page.title().catch(() => '') };
    }
    case 'scroll': {
      const dir = body.direction || 'down';
      const amount = Math.min(Math.max(Number(body.amount) || 600, 50), 3000);
      const [dx, dy] = dir === 'down' ? [0, amount] : dir === 'up' ? [0, -amount] : dir === 'right' ? [amount, 0] : [-amount, 0];
      await page.mouse.wheel(dx, dy);
      return { ok: true };
    }
    case 'waitFor': {
      if (body.selector) await page.waitForSelector(String(body.selector), { timeout: timeoutMs });
      else await page.waitForTimeout(Math.min(timeoutMs, 10_000));
      return { ok: true, url: page.url() };
    }
    case 'extract': {
      const mode = body.extractMode || 'readable';
      let content;
      if (mode === 'readable') {
        content = await extractReadable(page);
      } else {
        const els = await page.$$(String(mode));
        const texts = await Promise.all(els.slice(0, 50).map((e) => e.textContent()));
        content = texts.map((t) => (t || '').trim()).filter(Boolean).join('\n');
      }
      return { ok: true, url: page.url(), title: await page.title().catch(() => ''), content: String(content || '').slice(0, MAX_CONTENT_CHARS) };
    }
    case 'screenshot': {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
      return { ok: true, url: page.url(), title: await page.title().catch(() => ''), screenshotBase64: buf.toString('base64') };
    }
    case 'pdf': {
      const buf = await page.pdf({ format: 'A4', printBackground: true });
      return { ok: true, url: page.url(), title: await page.title().catch(() => ''), pdfBase64: buf.toString('base64') };
    }
    case 'submit': {
      if (!body.selector) return { ok: false, error: 'selector requerido' };
      await page.click(String(body.selector), { timeout: timeoutMs });
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => null);
      return { ok: true, url: page.url(), title: await page.title().catch(() => '') };
    }
    case 'captureState': {
      // Full storageState (cookies + localStorage) — travels to the server,
      // which encrypts it into BrowserProfile. Never logged here.
      const state = await context.storageState();
      return { ok: true, stateJson: JSON.stringify(state) };
    }
    case 'applyState': {
      // Restore a saved profile live: cookies via addCookies, localStorage via
      // an init script that writes when a matching-origin page loads.
      try {
        const state = JSON.parse(String(body.stateJson || '{}'));
        if (Array.isArray(state.cookies) && state.cookies.length) {
          await context.addCookies(state.cookies);
        }
        if (Array.isArray(state.origins)) {
          for (const o of state.origins) {
            if (!o.origin || !Array.isArray(o.localStorage)) continue;
            const entries = o.localStorage;
            await context.addInitScript(({ origin, entries }) => {
              if (location.origin === origin) {
                for (const e of entries) {
                  try { localStorage.setItem(e.name, e.value); } catch {}
                }
              }
            }, { origin: o.origin, entries });
          }
        }
        return { ok: true, applied: true };
      } catch (err) {
        return { ok: false, error: `Estado inválido: ${String(err && err.message ? err.message : err).slice(0, 200)}` };
      }
    }
    case 'useCredential': {
      // The secret only exists inside fill() — it is never returned or logged.
      if (!body.selector || typeof body.secretValue !== 'string') {
        return { ok: false, error: 'selector y secretValue requeridos' };
      }
      await page.fill(String(body.selector), body.secretValue, { timeout: timeoutMs });
      return { ok: true };
    }
    case 'tabs':
      return { ok: true, tabs: await tabList() };
    case 'closeTab': {
      const id = body.tabId || activeTabId;
      const p = tabs.get(id);
      if (!p) return { ok: false, error: `Tab ${id} no existe` };
      await p.close().catch(() => null);
      tabs.delete(id);
      if (activeTabId === id) activeTabId = tabs.keys().next().value ?? null;
      return { ok: true, tabs: await tabList() };
    }
    default:
      return { ok: false, error: `Acción desconocida: ${action}` };
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.headers['x-unik-token'] !== TOKEN || !TOKEN) {
    res.writeHead(401);
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ ok: true, tabs: tabs.size }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/act') {
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
    return;
  }
  let raw = '';
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 256_000) req.destroy();
  });
  req.on('end', async () => {
    try {
      const body = JSON.parse(raw || '{}');
      // Never log the body — it may carry secretValue.
      const result = await act(body);
      if (result && 'secretValue' in result) delete result.secretValue;
      res.end(JSON.stringify(result));
    } catch (err) {
      res.end(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err).slice(0, 300) }));
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`unik-browser-controller listening on 127.0.0.1:${PORT}`);
});
