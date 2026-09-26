/**
 * UNIK browser controller — runs INSIDE the Daytona sandbox.
 *
 * Self-contained Node HTTP server on 0.0.0.0:3100 driving Chromium through
 * playwright-core. UNIK's server writes this file into the sandbox, starts it
 * with UNIK_BROWSER_TOKEN set, and reaches it through Daytona's signed preview
 * URL. Every request must carry `x-unik-token`.
 *
 * How the agent drives it (what modern browser agents do):
 *   1. `snapshot` numbers every interactive element on screen ([12] button
 *      "Buscar") and returns a readable text summary of the page;
 *   2. `click {ref:12}` / `type {ref:7, text}` / `select {ref, value}` act on
 *      those numbers — no brittle CSS selectors needed.
 * The user takes over from the workspace with coordinate events on the live
 * frame (`clickAt`, `typeText`, `key`, `wheel`) and gets a fresh frame back.
 *
 * Security:
 *   - Token required on every request — the preview URL is not a secret alone.
 *   - Secrets (useCredential.secretValue) are only ever typed into the page —
 *     never echoed back, never logged. Frames taken after a secret was typed
 *     are flagged `frameSensitive` until the page navigates away, and the
 *     server never forwards those frames to the model.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 3100;
const TOKEN = process.env.UNIK_BROWSER_TOKEN || '';
const CHROME_PATH = process.env.UNIK_CHROME_PATH || '/usr/bin/chromium';
const DOWNLOAD_DIR = process.env.UNIK_DOWNLOAD_DIR || '/tmp/unik/downloads';
const MAX_CONTENT_CHARS = 40_000;
const MAX_ELEMENTS = 160;
const VIEWPORT = { width: 1280, height: 800 };
const VERSION = 2;

let browser = null;
let context = null;
let launching = null;
const tabs = new Map(); // id -> { page, logs: [], sensitive: false }
let activeTabId = null;
let nextTab = 1;
const downloads = [];

function log(...args) {
  // Never log request bodies (they may carry secretValue) — only lifecycle.
  console.log(new Date().toISOString(), ...args);
}

function pushLog(tab, level, text, url) {
  tab.logs.push({ level, text: String(text || '').slice(0, 500), url, at: new Date().toISOString() });
  if (tab.logs.length > 200) tab.logs.splice(0, tab.logs.length - 200);
}

function adoptPage(page) {
  const id = `t${nextTab++}`;
  const tab = { page, logs: [], sensitive: false };
  tabs.set(id, tab);
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') pushLog(tab, type, msg.text(), page.url());
  });
  page.on('pageerror', (err) => pushLog(tab, 'pageerror', err?.message ?? err, page.url()));
  page.on('requestfailed', (req) => {
    const failure = req.failure();
    pushLog(tab, 'requestfailed', `${req.method()} ${req.url()} — ${failure?.errorText ?? 'failed'}`, page.url());
  });
  page.on('response', (res) => {
    if (res.status() >= 500) pushLog(tab, 'http', `${res.status()} ${res.url()}`, page.url());
  });
  page.on('framenavigated', (frame) => {
    // A navigation away from the page where a secret was typed clears the flag.
    if (frame === page.mainFrame()) tab.sensitive = false;
  });
  page.on('close', () => {
    tabs.delete(id);
    if (activeTabId === id) activeTabId = tabs.keys().next().value ?? null;
  });
  page.on('download', async (dl) => {
    try {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
      const name = (dl.suggestedFilename() || `descarga-${Date.now()}`).replace(/[^\w.\- ]+/g, '_');
      const target = path.join(DOWNLOAD_DIR, name);
      await dl.saveAs(target);
      downloads.push(target);
      if (downloads.length > 50) downloads.shift();
      log('download saved', target);
    } catch (err) {
      pushLog(tab, 'download', `falló la descarga: ${err?.message ?? err}`, page.url());
    }
  });
  activeTabId = id;
  return id;
}

async function ensureBrowser() {
  if (browser && browser.isConnected()) return;
  if (launching) return launching;
  launching = (async () => {
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      // Signals are handled by shutdown() below (Playwright's own handler
      // would close the browser but keep the process holding the port).
      handleSIGTERM: false,
      handleSIGINT: false,
      handleSIGHUP: false,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--lang=es-MX',
      ],
    });
    browser.on('disconnected', () => {
      browser = null;
      context = null;
      tabs.clear();
      activeTabId = null;
    });
    context = await browser.newContext({
      viewport: VIEWPORT,
      locale: 'es-MX',
      timezoneId: 'America/Mexico_City',
      acceptDownloads: true,
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    // Popups and target=_blank links become tabs the agent can see.
    context.on('page', (page) => {
      for (const t of tabs.values()) if (t.page === page) return;
      adoptPage(page);
    });
    log('browser launched');
  })();
  try {
    await launching;
  } finally {
    launching = null;
  }
}

async function newTab() {
  await ensureBrowser();
  const page = await context.newPage();
  for (const [id, t] of tabs) if (t.page === page) return (activeTabId = id);
  return adoptPage(page);
}

function activeTab() {
  if (activeTabId && tabs.has(activeTabId)) return tabs.get(activeTabId);
  return null;
}

async function tabList() {
  const out = [];
  for (const [id, t] of tabs) {
    out.push({ id, url: t.page.url(), title: await t.page.title().catch(() => ''), active: id === activeTabId });
  }
  return out;
}

async function settle(page, ms = 350) {
  await page.waitForLoadState('domcontentloaded', { timeout: 6_000 }).catch(() => null);
  await page.waitForTimeout(ms).catch(() => null);
}

function normalizeUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^127\.0\.0\.1(:\d+)?/.test(s)) return `http://${s}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return `https://${s}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(s)}`;
}

/** Readable extraction without Readability: headings/paragraphs/lists/tables. */
async function extractReadable(page) {
  return page.evaluate(() => {
    const kill = ['script', 'style', 'noscript', 'iframe', 'svg', 'nav', 'footer', 'header[role="banner"]'];
    const root = document.querySelector('main') || document.querySelector('article') || document.body;
    if (!root) return '';
    const clone = root.cloneNode(true);
    for (const sel of kill) for (const el of clone.querySelectorAll(sel)) el.remove();
    const parts = [];
    for (const el of clone.querySelectorAll('h1,h2,h3,h4,p,li,td,th,a[href],label,button')) {
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

/**
 * Numbers every visible interactive element (data-unik-ref) and returns them
 * with role/name so the model can act by number. Refs are reset on each call.
 */
async function snapshot(page) {
  const data = await page.evaluate((max) => {
    for (const el of document.querySelectorAll('[data-unik-ref]')) el.removeAttribute('data-unik-ref');
    const sel = [
      'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
      '[role=button]', '[role=link]', '[role=checkbox]', '[role=radio]', '[role=tab]',
      '[role=menuitem]', '[role=option]', '[role=switch]', '[role=combobox]', '[role=textbox]',
      '[contenteditable=""]', '[contenteditable=true]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
    ].join(',');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const out = [];
    let ref = 1;
    const seen = new Set();
    for (const el of document.querySelectorAll(sel)) {
      if (out.length >= max) break;
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
      // Keep elements in (or just below) the viewport — the agent scrolls for the rest.
      if (r.bottom < -40 || r.top > vh * 2.2 || r.right < 0 || r.left > vw) continue;
      const tag = el.tagName.toLowerCase();
      const role =
        el.getAttribute('role') ||
        (tag === 'a' ? 'link' : tag === 'select' ? 'combobox' : tag === 'textarea' ? 'textbox' : tag === 'input'
          ? ({ checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button' }[el.type] || 'textbox')
          : tag === 'button' || tag === 'summary' ? 'button' : 'generic');
      const isField = tag === 'input' || tag === 'select' || tag === 'textarea';
      const labelText = isField && el.labels && el.labels.length ? el.labels[0].innerText : '';
      const labelled =
        el.getAttribute('aria-label') || labelText || el.getAttribute('title') || el.getAttribute('placeholder') || '';
      // Fields are named by their label, never by their value/options (a select's
      // innerText is every option; a checkbox's value is "on").
      const fallback = isField ? el.getAttribute('name') || '' : el.innerText || el.getAttribute('alt') || '';
      let name = (labelled || fallback).replace(/\s+/g, ' ').trim();
      if (!name && tag === 'input' && (el.type === 'submit' || el.type === 'button')) name = String(el.value || '');
      el.setAttribute('data-unik-ref', String(ref));
      const item = { ref, role, name: name.slice(0, 90), tag };
      if (tag === 'input') item.type = el.type;
      if (tag === 'a' && el.href) item.href = el.href.slice(0, 200);
      const textLike = tag === 'textarea' || (tag === 'input' && !['checkbox', 'radio', 'password', 'submit', 'button', 'file'].includes(el.type));
      if (textLike && el.value) item.value = String(el.value).slice(0, 80);
      if (tag === 'select') item.value = el.options[el.selectedIndex]?.text?.slice(0, 80);
      if (el.type === 'checkbox' || el.type === 'radio') item.checked = Boolean(el.checked);
      if (el.disabled) item.disabled = true;
      out.push(item);
      ref++;
    }
    const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    return { elements: out, text: text.slice(0, 6000), scrollY: Math.round(window.scrollY), height: document.body?.scrollHeight ?? 0 };
  }, MAX_ELEMENTS);
  return data;
}


/**
 * Describes the element at a point (or the focused one) so a user
 * demonstration ("Enséñale") is recorded as a replayable step — a stable
 * selector + visible text — instead of fragile screen coordinates.
 */
async function describeElement(page, point) {
  return page
    .evaluate((pt) => {
      const el = pt ? document.elementFromPoint(pt.x, pt.y) : document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const target = el.closest('a,button,input,select,textarea,label,[role],[onclick],summary') || el;
      const tag = target.tagName.toLowerCase();
      const attr = (n) => target.getAttribute(n);
      const q = (v) => JSON.stringify(v);
      let selector = '';
      if (target.id && /^[A-Za-z][\w-]*$/.test(target.id)) selector = `#${target.id}`;
      else if (attr('name')) selector = `${tag}[name=${q(attr('name'))}]`;
      else if (attr('aria-label')) selector = `${tag}[aria-label=${q(attr('aria-label'))}]`;
      else if (attr('placeholder')) selector = `${tag}[placeholder=${q(attr('placeholder'))}]`;
      else if (attr('data-testid')) selector = `[data-testid=${q(attr('data-testid'))}]`;
      else {
        const parts = [];
        let node = target;
        while (node && node.nodeType === 1 && parts.length < 5 && node !== document.body) {
          const t = node.tagName.toLowerCase();
          const parent = node.parentElement;
          const same = parent ? Array.from(parent.children).filter((c) => c.tagName === node.tagName) : [];
          parts.unshift(same.length > 1 ? `${t}:nth-of-type(${same.indexOf(node) + 1})` : t);
          node = parent;
        }
        selector = parts.join(' > ');
      }
      const text = (target.innerText || target.value || attr('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      return { selector, text, tag, type: target.type || undefined, sensitive: target.type === 'password' };
    }, point ?? null)
    .catch(() => null);
}

class StaleRefError extends Error {}

/** Locator for ref/selector/target; a ref that no longer exists fails at once (no timeout wait). */
async function resolveTarget(page, body) {
  const loc = refLocator(page, body);
  if (!loc) return null;
  if (typeof body.ref === 'number' && (await loc.count()) === 0) {
    throw new StaleRefError(
      `La referencia ${body.ref} ya no existe en la página (cambió o navegó). Toma un snapshot nuevo y usa sus números.`
    );
  }
  return loc;
}

function refLocator(page, body) {
  if (typeof body.ref === 'number' && Number.isFinite(body.ref)) {
    return page.locator(`[data-unik-ref="${Math.floor(body.ref)}"]`).first();
  }
  if (body.selector) return page.locator(String(body.selector)).first();
  if (body.target) {
    const t = String(body.target);
    return page
      .getByRole('button', { name: t })
      .or(page.getByRole('link', { name: t }))
      .or(page.getByText(t, { exact: false }))
      .first();
  }
  return null;
}

async function pageState(page, extra = {}) {
  return {
    ok: true,
    url: page.url(),
    title: await page.title().catch(() => ''),
    viewport: page.viewportSize() ?? VIEWPORT,
    ...extra,
  };
}

async function performAct(body) {
  const { action } = body;
  const timeoutMs = Math.min(Math.max(body.timeoutMs ?? 20_000, 1_000), 60_000);

  if (action === 'open' || action === 'newTab') {
    const url = normalizeUrl(body.url);
    if (!url) return { ok: false, error: 'URL requerida' };
    if (!/^https?:\/\//.test(url)) return { ok: false, error: 'URL debe ser http(s)' };
    const id = action === 'newTab' || !activeTab() ? await newTab() : activeTabId;
    const { page } = tabs.get(id);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await settle(page, 500);
    return pageState(page, { tabs: await tabList() });
  }
  if (action === 'tabs') {
    await ensureBrowser();
    return { ok: true, tabs: await tabList() };
  }
  if (action === 'switchTab') {
    if (!body.tabId || !tabs.has(body.tabId)) return { ok: false, error: `Pestaña ${body.tabId} no existe` };
    activeTabId = body.tabId;
    const { page } = tabs.get(activeTabId);
    await page.bringToFront().catch(() => null);
    return pageState(page, { tabs: await tabList() });
  }
  if (action === 'captureState') {
    await ensureBrowser();
    const state = await context.storageState();
    return { ok: true, stateJson: JSON.stringify(state) };
  }
  if (action === 'applyState') {
    await ensureBrowser();
    try {
      const state = JSON.parse(String(body.stateJson || '{}'));
      if (Array.isArray(state.cookies) && state.cookies.length) await context.addCookies(state.cookies);
      if (Array.isArray(state.origins)) {
        for (const o of state.origins) {
          if (!o.origin || !Array.isArray(o.localStorage)) continue;
          const entries = o.localStorage;
          await context.addInitScript(
            ({ origin, entries }) => {
              if (location.origin === origin) {
                for (const e of entries) {
                  try {
                    localStorage.setItem(e.name, e.value);
                  } catch {}
                }
              }
            },
            { origin: o.origin, entries }
          );
        }
      }
      return { ok: true, applied: true };
    } catch (err) {
      return { ok: false, error: `Estado inválido: ${String(err?.message ?? err).slice(0, 200)}` };
    }
  }

  const tab = activeTab();
  if (!tab) {
    if (action === 'frame' || action === 'screenshot' || action === 'snapshot') {
      await ensureBrowser();
      return { ok: true, empty: true, tabs: [], viewport: VIEWPORT };
    }
    return { ok: false, error: 'No hay pestaña abierta — usa open con una URL primero' };
  }
  const page = tab.page;

  switch (action) {
    case 'back':
      await page.goBack({ timeout: timeoutMs }).catch(() => null);
      await settle(page);
      return pageState(page);
    case 'forward':
      await page.goForward({ timeout: timeoutMs }).catch(() => null);
      await settle(page);
      return pageState(page);
    case 'reload':
      await page.reload({ timeout: timeoutMs, waitUntil: 'domcontentloaded' }).catch(() => null);
      await settle(page);
      return pageState(page);
    case 'snapshot': {
      const snap = await snapshot(page);
      return pageState(page, {
        elements: snap.elements,
        content: `${snap.text}${snap.height > (page.viewportSize()?.height ?? 800) * 1.5 ? `\n\n[desplazamiento ${snap.scrollY}px de ${snap.height}px — usa scroll para ver más]` : ''}`,
        tabs: await tabList(),
      });
    }
    case 'click': {
      const loc = await resolveTarget(page, body);
      if (!loc) return { ok: false, error: 'Indica ref (de snapshot), target (texto visible) o selector' };
      await loc.scrollIntoViewIfNeeded({ timeout: 4_000 }).catch(() => null);
      await loc.click({ timeout: timeoutMs, button: body.button ?? 'left', clickCount: body.clickCount ?? 1 });
      await settle(page, 450);
      return pageState(page, { tabs: await tabList() });
    }
    case 'hover': {
      const loc = await resolveTarget(page, body);
      if (!loc) return { ok: false, error: 'Indica ref, target o selector' };
      await loc.hover({ timeout: timeoutMs });
      await page.waitForTimeout(250);
      return pageState(page);
    }
    case 'type': {
      const loc = await resolveTarget(page, body);
      if (!loc) return { ok: false, error: 'Indica ref, target o selector del campo' };
      await loc.fill(String(body.text ?? ''), { timeout: timeoutMs });
      return pageState(page);
    }
    case 'select': {
      const loc = await resolveTarget(page, body);
      if (!loc) return { ok: false, error: 'Indica ref o selector del select' };
      const v = String(body.value ?? body.text ?? '');
      // First option whose label OR value matches (single-select semantics).
      await loc.selectOption([{ label: v }, { value: v }], { timeout: timeoutMs });
      return pageState(page);
    }
    case 'press':
    case 'key': {
      await page.keyboard.press(String(body.key || 'Enter'));
      await settle(page, 400);
      return pageState(page, { tabs: await tabList() });
    }
    case 'typeText': {
      const focus = await describeElement(page, null);
      await page.keyboard.type(String(body.text ?? ''), { delay: 12 });
      // A password typed by the user marks the frames sensitive like useCredential.
      if (focus?.sensitive) tab.sensitive = true;
      return pageState(page, { hit: focus });
    }
    case 'clickAt': {
      const x = Number(body.x);
      const y = Number(body.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'x e y requeridos' };
      const hit = await describeElement(page, { x, y });
      await page.mouse.click(x, y, { button: body.button ?? 'left', clickCount: body.clickCount ?? 1 });
      await settle(page, 400);
      return pageState(page, { tabs: await tabList(), hit });
    }
    case 'wheel': {
      const x = Number.isFinite(Number(body.x)) ? Number(body.x) : VIEWPORT.width / 2;
      const y = Number.isFinite(Number(body.y)) ? Number(body.y) : VIEWPORT.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.wheel(Number(body.deltaX) || 0, Number(body.deltaY) || 0);
      await page.waitForTimeout(200);
      return pageState(page);
    }
    case 'scroll': {
      const dir = body.direction || 'down';
      const amount = Math.min(Math.max(Number(body.amount) || 650, 50), 4000);
      const [dx, dy] = dir === 'down' ? [0, amount] : dir === 'up' ? [0, -amount] : dir === 'right' ? [amount, 0] : [-amount, 0];
      await page.mouse.wheel(dx, dy);
      await page.waitForTimeout(250);
      return pageState(page);
    }
    case 'waitFor': {
      if (body.selector) await page.waitForSelector(String(body.selector), { timeout: timeoutMs });
      else if (body.target) await page.getByText(String(body.target)).first().waitFor({ timeout: timeoutMs });
      else await page.waitForTimeout(Math.min(timeoutMs, 10_000));
      return pageState(page);
    }
    case 'extract': {
      const mode = body.extractMode || 'readable';
      let content;
      if (mode === 'readable') {
        content = await extractReadable(page);
      } else {
        const els = await page.$$(String(mode));
        const texts = await Promise.all(els.slice(0, 80).map((e) => e.textContent()));
        content = texts.map((t) => (t || '').trim()).filter(Boolean).join('\n');
      }
      return pageState(page, { content: String(content || '').slice(0, MAX_CONTENT_CHARS) });
    }
    case 'frame':
    case 'screenshot': {
      const quality = Math.min(Math.max(Number(body.quality) || (action === 'frame' ? 55 : 70), 20), 90);
      const buf = await page.screenshot({ type: 'jpeg', quality });
      return pageState(page, {
        screenshotBase64: buf.toString('base64'),
        frameSensitive: tab.sensitive || undefined,
        tabs: await tabList(),
      });
    }
    case 'pdf': {
      const buf = await page.pdf({ format: 'A4', printBackground: true });
      return pageState(page, { pdfBase64: buf.toString('base64') });
    }
    case 'submit': {
      const loc = await resolveTarget(page, body);
      if (!loc) return { ok: false, error: 'Indica ref, target o selector del botón' };
      await loc.click({ timeout: timeoutMs });
      await settle(page, 800);
      return pageState(page, { tabs: await tabList() });
    }
    case 'evaluate': {
      const script = String(body.script || '');
      if (!script) return { ok: false, error: 'script requerido' };
      const value = await Promise.race([
        page.evaluate((src) => {
          // eslint-disable-next-line no-eval
          const out = (0, eval)(src);
          return Promise.resolve(out).then((v) => {
            try {
              return JSON.parse(JSON.stringify(v ?? null));
            } catch {
              return String(v);
            }
          });
        }, script),
        new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate excedió 10 s')), 10_000)),
      ]);
      const text = JSON.stringify(value ?? null);
      return pageState(page, { value: text.length > 20_000 ? `${text.slice(0, 20_000)}…` : value });
    }
    case 'console': {
      const logs = tab.logs.slice(-80);
      return pageState(page, { logs, downloads: downloads.slice(-10) });
    }
    case 'upload': {
      const loc = await resolveTarget(page, body);
      if (!loc) return { ok: false, error: 'Indica ref o selector del input de archivo' };
      const files = Array.isArray(body.files) ? body.files.map(String).slice(0, 10) : [];
      if (!files.length) return { ok: false, error: 'files requerido (rutas dentro de la computadora virtual)' };
      await loc.setInputFiles(files, { timeout: timeoutMs });
      return pageState(page);
    }
    case 'useCredential': {
      // The secret only exists inside fill() — it is never returned or logged.
      const loc = await resolveTarget(page, body);
      if (!loc || typeof body.secretValue !== 'string') return { ok: false, error: 'selector/ref y secretValue requeridos' };
      await loc.fill(body.secretValue, { timeout: timeoutMs });
      tab.sensitive = true;
      return { ok: true };
    }
    case 'closeTab': {
      const id = body.tabId || activeTabId;
      const t = tabs.get(id);
      if (!t) return { ok: false, error: `Pestaña ${id} no existe` };
      await t.page.close().catch(() => null);
      tabs.delete(id);
      if (activeTabId === id) activeTabId = tabs.keys().next().value ?? null;
      return { ok: true, tabs: await tabList() };
    }
    default:
      return { ok: false, error: `Acción desconocida: ${action}` };
  }
}

// Actions whose result must NOT get a frame appended (binary payloads of their
// own, pure state plumbing, or right after a secret was typed).
const NO_FRAME_ACTIONS = new Set([
  'screenshot', 'frame', 'pdf', 'captureState', 'applyState', 'tabs', 'console', 'useCredential', 'evaluate',
]);

/**
 * Every successful navigation/interaction returns the current frame so the
 * user's live view updates on each action. Failures return the frame too when
 * a page exists: seeing WHERE it failed is the point of a live view.
 */
async function act(body) {
  let result;
  try {
    result = await performAct(body);
  } catch (err) {
    const msg = String(err?.message ?? err).split('\n')[0].slice(0, 300);
    const hint = /data-unik-ref/.test(msg)
      ? ' — el elemento ya no existe: toma un snapshot nuevo.'
      : /Timeout/i.test(msg)
        ? ' — la página tardó demasiado o el elemento no está visible.'
        : '';
    result = { ok: false, error: `${msg}${hint}` };
  }
  if (NO_FRAME_ACTIONS.has(body.action) || result.screenshotBase64 || result.empty) return result;
  const tab = activeTab();
  if (!tab) return result;
  try {
    const buf = await tab.page.screenshot({ type: 'jpeg', quality: 55 });
    result.screenshotBase64 = buf.toString('base64');
    result.url = result.url ?? tab.page.url();
    result.viewport = result.viewport ?? tab.page.viewportSize() ?? VIEWPORT;
    if (tab.sensitive) result.frameSensitive = true;
  } catch {
    // Frame capture is best-effort — never fail the action over a screenshot.
  }
  return result;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (!TOKEN || req.headers['x-unik-token'] !== TOKEN) {
    res.writeHead(401);
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ ok: true, version: VERSION, tabs: tabs.size, browser: Boolean(browser) }));
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
    if (raw.length > 512_000) req.destroy();
  });
  req.on('end', async () => {
    try {
      const body = JSON.parse(raw || '{}');
      // Never log the body — it may carry secretValue.
      const result = await act(body);
      if (result && 'secretValue' in result) delete result.secretValue;
      res.end(JSON.stringify(result));
    } catch (err) {
      res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err).slice(0, 300) }));
    }
  });
});

// Playwright hooks SIGTERM to close its browser but leaves this process (and
// the port) alive — a respawn then dies with EADDRINUSE. Exit explicitly.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutdown (${signal})`);
  server.close();
  await browser?.close().catch(() => null);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
server.on('error', (err) => {
  log(`server error: ${err?.code ?? ''} ${err?.message ?? err}`);
  process.exit(1);
});

// 0.0.0.0 — Daytona's preview proxy reaches the sandbox from outside the
// loopback interface; binding 127.0.0.1 turns every call into a 502.
server.listen(PORT, '0.0.0.0', () => {
  log(`unik-browser-controller v${VERSION} listening on 0.0.0.0:${PORT}`);
  // Warm the browser so the first action does not pay the launch.
  ensureBrowser().catch((err) => log('warm launch failed:', err?.message ?? err));
});
