import { buildHomeSpec, type HomeData } from '@/modules/ai/genui/home';
import { encodeWav } from '@/components/universo/voice/audio';

/**
 * Storybook-only fixtures + a network simulator for UNIVERSO. Mock data for
 * visual review — never imported by application code, never real data.
 */

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const storyUser = {
  id: 'user-demo',
  name: 'Iván Saavedra',
  username: 'ivan',
  isSuperAdmin: true,
  permissionKeys: [
    'assistant.use',
    'assistant.upload',
    'assistant.voice',
    'browser.use',
    'venue.exec',
    'venue.files',
  ],
};

export const agentsFixture = [
  {
    id: 'ag-principal',
    kind: 'principal',
    name: 'UNIK Central',
    purpose: 'Dirige a tu equipo y responde directo',
    icon: 'central',
    color: '0',
    status: 'active',
    sortOrder: 0,
  },
  {
    id: 'ag-prospector',
    kind: 'specialist',
    name: 'Prospector',
    purpose: 'Encuentra clientes nuevos y prepara el primer contacto',
    icon: 'sales',
    color: '3',
    status: 'active',
    sortOrder: 1,
  },
  {
    id: 'ag-cobranza',
    kind: 'specialist',
    name: 'Cobranza',
    purpose: 'Da seguimiento a saldos vencidos con tacto',
    icon: 'audit',
    color: '5',
    status: 'active',
    sortOrder: 2,
  },
  {
    id: 'ag-qa',
    kind: 'specialist',
    name: 'QA en producción',
    purpose: 'Prueba tu sistema en el navegador y reporta fallas',
    icon: 'code',
    color: '7',
    status: 'active',
    sortOrder: 3,
  },
  {
    id: 'ag-marketing',
    kind: 'specialist',
    name: 'Marketing',
    purpose: 'Campañas, contenido y sitios que venden',
    icon: 'msg',
    color: '2',
    status: 'active',
    sortOrder: 4,
  },
];

export const conversationsFixture = [
  {
    id: 'c-demo',
    title: 'Arranque del día y cotizaciones',
    isStarred: false,
    agentId: 'ag-principal',
    createdAt: iso(40 * MIN),
    updatedAt: iso(3 * MIN),
    lastMessageAt: null,
  },
  {
    id: 'c-2',
    title: 'Precios de mármol de la competencia',
    isStarred: true,
    agentId: 'ag-prospector',
    createdAt: iso(2 * DAY),
    updatedAt: iso(2 * DAY),
    lastMessageAt: null,
  },
  {
    id: 'c-3',
    title: 'Prueba del módulo de ventas en producción',
    isStarred: false,
    agentId: 'ag-qa',
    createdAt: iso(3 * HOUR),
    updatedAt: iso(2 * HOUR),
    lastMessageAt: null,
  },
  {
    id: 'c-4',
    title: 'Sitio de la promoción de otoño',
    isStarred: false,
    agentId: 'ag-marketing',
    createdAt: iso(26 * HOUR),
    updatedAt: iso(25 * HOUR),
    lastMessageAt: null,
  },
  {
    id: 'c-5',
    title: 'Facturas vencidas de septiembre',
    isStarred: false,
    agentId: 'ag-cobranza',
    createdAt: iso(5 * DAY),
    updatedAt: iso(5 * DAY),
    lastMessageAt: null,
  },
  {
    id: 'c-w1',
    title: '⚙ Investigar precios de 3 competidores',
    isStarred: false,
    agentId: 'ag-prospector',
    createdAt: iso(20 * MIN),
    updatedAt: iso(8 * MIN),
    lastMessageAt: null,
  },
];

const REASONING = `El usuario quiere el arranque del día y el estado de las cotizaciones.
1) Traigo ventas de ayer y pedidos atrasados de la base de datos.
2) Busco cotizaciones sin respuesta de más de 3 días y las ordeno por monto.
3) Delego al Prospector la revisión de precios de la competencia para no frenar la respuesta.
4) Preparo el PDF del arranque y propongo el seguimiento de la cotización más grande.`;

export const demoMessages = [
  {
    id: 'm1',
    role: 'user',
    content: 'Dame el arranque del día y dime qué cotizaciones llevan más de 3 días sin respuesta.',
    createdAt: iso(12 * MIN),
  },
  {
    id: 'm2',
    role: 'assistant',
    createdAt: iso(11 * MIN),
    content: `## Arranque del día — viernes 26 de septiembre

Ayer cerraste **$482,300 MXN** en 31 pedidos, un **12% arriba** del promedio de la semana. Hay 3 decisiones para hoy:

1. **Constructora Norte** tiene la cotización más grande sin respuesta (**$186,400**, 5 días). Preparé el seguimiento.
2. **4 pedidos** van atrasados; el más crítico es la **OV-10482** (15 días) por falta de travertino en Monterrey.
3. El Prospector está revisando precios de 3 competidores; te aviso al terminar.

| Cotización | Cliente | Monto | Días sin respuesta |
|---|---|---:|---:|
| COT-2291 | Constructora Norte | $186,400 | 5 |
| COT-2288 | Hotel Brisas | $94,150 | 4 |
| COT-2275 | Arq. Paola Ríos | $38,900 | 6 |

> Recomendación: prioriza Constructora Norte hoy; su obra arranca en octubre.

Sugerencias: [Envía el seguimiento a Constructora Norte] · [Muéstrame los 4 pedidos atrasados] · [Programa este resumen diario a las 7:00]`,
    meta: {
      model: 'gpt-5',
      routing: { routed: true, tier: 'complex', reason: 'análisis con varias fuentes' },
      reasoning: REASONING,
      confidence: 'verified',
      sourcesLabel: 'base de datos UNIK · internet',
      agent: { id: 'ag-principal', name: 'UNIK Central', color: 0, icon: 'central' },
    },
    toolCallRecords: [
      {
        id: 't1',
        toolName: 'renderView',
        args: {},
        result: {
          view: {
            type: 'kpi',
            title: 'Ayer',
            items: [
              { label: 'Ventas', value: '$482,300', delta: '+12% vs semana', tone: 'success' },
              { label: 'Pedidos', value: '31', delta: '+4', tone: 'success' },
              { label: 'Atrasados', value: '4', delta: '1 crítico', tone: 'danger' },
              { label: 'Cobranza vencida', value: '$128,900', delta: '-8%', tone: 'warning' },
            ],
          },
        },
        durationMs: 40,
        success: true,
        errorCode: null,
      },
      {
        id: 't2',
        toolName: 'querySalesOrders',
        args: { dateFrom: 'ayer' },
        result: { total: 31 },
        durationMs: 820,
        success: true,
        errorCode: null,
      },
      {
        id: 't3',
        toolName: 'queryQuotes',
        args: { status: 'sent', olderThanDays: 3 },
        result: { total: 3 },
        durationMs: 610,
        success: true,
        errorCode: null,
      },
      {
        id: 't4',
        toolName: 'web_search',
        args: { query: 'precio mármol travertino m2 Monterrey 2026' },
        result: {
          results: [
            {
              url: 'https://www.marmolesdelnorte.mx/precios',
              title: 'Lista de precios 2026 — Mármoles del Norte',
              content: 'Travertino fiorito desde $689 m², mármol blanco carrara…',
            },
            {
              url: 'https://piedrasmx.com/travertino',
              title: 'Travertino al mejor precio | Piedras MX',
              content: 'Promoción de temporada 15% en travertino.',
            },
            {
              url: 'https://www.homedepot.com.mx/marmol',
              title: 'Mármol y piedra natural | The Home Depot México',
              content: 'Losetas de mármol desde $529 m².',
            },
          ],
        },
        durationMs: 1840,
        success: true,
        errorCode: null,
      },
      {
        id: 't5',
        toolName: 'delegateTask',
        args: { goal: 'Investigar precios de 3 competidores de mármol en Monterrey' },
        result: { taskId: 'task-1' },
        durationMs: 120,
        success: true,
        errorCode: null,
      },
      {
        id: 't6',
        toolName: 'generatePdfReport',
        args: { title: 'Arranque del día' },
        result: { artifactId: 'art-1' },
        durationMs: 2300,
        success: true,
        errorCode: null,
      },
    ],
    artifacts: [
      {
        artifactId: 'art-1',
        type: 'pdf',
        title: 'Arranque del día — 26 sep',
        filename: 'arranque-26-sep.pdf',
        downloadUrl: '/app/assistant/api/artifacts/art-1/download',
        sizeBytes: 184_320,
        pageCount: 3,
      },
    ],
    feedback: null,
  },
  {
    id: 'm3',
    role: 'user',
    content: 'Envíale el seguimiento a Constructora Norte.',
    createdAt: iso(4 * MIN),
  },
  {
    id: 'm4',
    role: 'assistant',
    createdAt: iso(3 * MIN),
    content:
      'Listo, preparé el mensaje para **Luis Pérez** de Constructora Norte con la cotización COT-2291 adjunta. Revísalo y apruébalo para enviarlo por WhatsApp.',
    meta: {
      model: 'gpt-5-mini',
      routing: { routed: true, tier: 'standard' },
      agent: { id: 'ag-principal', name: 'UNIK Central', color: 0, icon: 'central' },
    },
    toolCallRecords: [
      {
        id: 't7',
        toolName: 'getContactFile',
        args: { query: 'Constructora Norte' },
        result: {},
        durationMs: 540,
        success: true,
        errorCode: null,
      },
      {
        id: 't8',
        toolName: 'sendMessageToContact',
        args: { contact: 'Constructora Norte' },
        result: null,
        durationMs: 90,
        success: false,
        errorCode: 'needs_approval',
      },
    ],
    feedback: null,
  },
];

export const proposalsFixture = [
  {
    id: 'p1',
    toolName: 'sendMessageToContact',
    summary: 'Enviar WhatsApp a Luis Pérez (Constructora Norte) con la cotización COT-2291.',
    effect: 'external_send',
    expiresAt: new Date(now + 2 * HOUR).toISOString(),
    status: 'pending',
    args: {
      contact: 'Luis Pérez · Constructora Norte',
      body: 'Hola Luis, buen día. Te comparto de nuevo la cotización COT-2291 del mármol travertino para la obra de San Pedro. Podemos respetar el precio hasta el 30 de septiembre y entregar en 10 días hábiles. ¿Te parece si lo revisamos hoy?',
      attachments: { artifactIds: ['cot-2291'] },
    },
  },
];

export const tasksFixture = [
  {
    taskId: 'task-1',
    status: 'running',
    title: 'Investigar precios de 3 competidores de mármol en Monterrey',
    agentId: 'ag-prospector',
    conversationId: 'c-demo',
    reportPreview: null,
    durationMs: null,
    updatedAt: now - 2 * MIN,
  },
  {
    taskId: 'task-2',
    status: 'done',
    title: 'Revisar facturas vencidas de más de 30 días',
    agentId: 'ag-cobranza',
    conversationId: 'c-demo',
    reportPreview:
      '7 facturas vencidas por $128,900. Preparé 5 recordatorios; 2 clientes ya prometieron pago esta semana.',
    durationMs: 184_000,
    updatedAt: now - 9 * MIN,
  },
];

export const missionsFixture = [
  {
    id: 'mi-1',
    goal: 'Recuperar las 12 cotizaciones sin respuesta de septiembre',
    status: 'active',
    plan: {
      steps: [
        { title: 'Priorizar por monto', status: 'done' },
        { title: 'Redactar seguimiento', status: 'done' },
        { title: 'Enviar con aprobación', status: 'running' },
        { title: 'Reportar resultados', status: 'pending' },
      ],
    },
    conversationId: 'c-demo',
    createdAt: iso(2 * HOUR),
  },
  {
    id: 'mi-2',
    goal: 'Arranque del día',
    status: 'active',
    schedule: 'daily:07:00',
    plan: null,
    conversationId: 'c-demo',
    createdAt: iso(3 * DAY),
  },
];

export const triggersFixture = [
  {
    id: 'tr-1',
    agentId: 'ag-principal',
    type: 'time',
    spec: { atHour: 6, atMinute: 0, tz: 'America/Mexico_City' },
    action: { kind: 'run', goal: 'Arranque del día: ventas, pendientes, cobranza y alertas' },
    enabled: true,
    lastFiredAt: iso(5 * HOUR),
  },
  {
    id: 'tr-2',
    agentId: 'ag-cobranza',
    type: 'time',
    spec: { everyMinutes: 240 },
    action: { kind: 'run', goal: 'Revisar pagos recibidos y conciliar' },
    enabled: false,
    lastFiredAt: iso(DAY),
  },
];

export const modelsFixture = [
  {
    id: 'gpt-5',
    provider: 'openai',
    providerLabel: 'OpenAI',
    label: 'GPT-5',
    power: 10,
    bestFor: 'Análisis profundo, código y trabajo con la computadora',
    speed: 'slow',
    capabilities: ['reasoning', 'vision', 'tool_use'],
    description: '',
  },
  {
    id: 'gpt-5-mini',
    provider: 'openai',
    providerLabel: 'OpenAI',
    label: 'GPT-5 mini',
    power: 7,
    bestFor: 'Preguntas y tareas del día a día',
    speed: 'fast',
    capabilities: ['reasoning', 'vision', 'tool_use'],
    description: '',
  },
  {
    id: 'claude-sonnet',
    provider: 'anthropic',
    providerLabel: 'Anthropic',
    label: 'Claude Sonnet',
    power: 9,
    bestFor: 'Redacción y programación',
    speed: 'medium',
    capabilities: ['reasoning', 'vision', 'tool_use'],
    description: '',
  },
];

/** A plausible web page (SVG) as the browser frame. */
export function browserFrameSvg(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
  <rect width="1280" height="800" fill="#f7f5f2"/>
  <rect width="1280" height="72" fill="#ffffff"/>
  <text x="48" y="45" font-family="Georgia,serif" font-size="26" fill="#2b2a28" font-weight="bold">Mármoles del Norte</text>
  <text x="760" y="44" font-family="Arial" font-size="16" fill="#5c5a57">Productos   Proyectos   Precios   Contacto</text>
  <rect x="48" y="112" width="1184" height="220" rx="16" fill="#e9e3da"/>
  <text x="88" y="190" font-family="Georgia,serif" font-size="44" fill="#2b2a28">Lista de precios 2026</text>
  <text x="88" y="236" font-family="Arial" font-size="20" fill="#5c5a57">Piedra natural para obra y residencial · Monterrey y área metropolitana</text>
  <rect x="88" y="264" width="180" height="44" rx="22" fill="#2b2a28"/>
  <text x="124" y="292" font-family="Arial" font-size="16" fill="#ffffff">Cotizar ahora</text>
  ${[0, 1, 2, 3]
    .map((i) => {
      const x = 48 + i * 300;
      const names = ['Travertino fiorito', 'Blanco Carrara', 'Crema marfil', 'Negro Marquina'];
      const prices = ['$689 m²', '$1,240 m²', '$845 m²', '$1,390 m²'];
      const fills = ['#d9c7a8', '#eeeeea', '#e8dcc4', '#3a3a3a'];
      return `<rect x="${x}" y="368" width="276" height="380" rx="14" fill="#ffffff"/>
      <rect x="${x + 16}" y="384" width="244" height="200" rx="10" fill="${fills[i]}"/>
      <text x="${x + 20}" y="624" font-family="Arial" font-size="19" fill="#2b2a28" font-weight="bold">${names[i]}</text>
      <text x="${x + 20}" y="656" font-family="Arial" font-size="16" fill="#5c5a57">Pulido · 60×40 cm</text>
      <text x="${x + 20}" y="712" font-family="Arial" font-size="24" fill="#8a5a2b" font-weight="bold">${prices[i]}</text>`;
    })
    .join('')}
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function desktopFrameSvg(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
  <rect width="1280" height="800" fill="#2d3340"/>
  <rect width="1280" height="28" fill="#1d212a"/>
  <text x="14" y="19" font-family="Arial" font-size="13" fill="#c9ced8">Aplicaciones   Lugares</text>
  <text x="1180" y="19" font-family="Arial" font-size="13" fill="#c9ced8">09:42</text>
  <rect x="120" y="90" width="760" height="470" rx="8" fill="#0f1218"/>
  <rect x="120" y="90" width="760" height="30" rx="8" fill="#232834"/>
  <text x="136" y="110" font-family="monospace" font-size="13" fill="#c9ced8">daytona@universo: ~/proyecto-web</text>
  <text x="136" y="150" font-family="monospace" font-size="14" fill="#8bd49c">$ npm run test</text>
  <text x="136" y="176" font-family="monospace" font-size="14" fill="#c9ced8">  ✓ carrito calcula impuestos (12 ms)</text>
  <text x="136" y="200" font-family="monospace" font-size="14" fill="#c9ced8">  ✓ checkout valida la dirección (31 ms)</text>
  <text x="136" y="224" font-family="monospace" font-size="14" fill="#c9ced8">  ✓ página de precios responde 200 (84 ms)</text>
  <text x="136" y="260" font-family="monospace" font-size="14" fill="#8bd49c">Tests: 3 passed, 3 total</text>
  <rect x="640" y="300" width="560" height="420" rx="8" fill="#f4f4f2"/>
  <rect x="640" y="300" width="560" height="30" rx="8" fill="#dedcd8"/>
  <text x="656" y="320" font-family="Arial" font-size="13" fill="#333">localhost:3000 — Promoción Otoño</text>
  <text x="680" y="380" font-family="Georgia,serif" font-size="30" fill="#2b2a28">Mármol de otoño</text>
  <text x="680" y="412" font-family="Arial" font-size="15" fill="#5c5a57">Hasta 20% en travertino y crema marfil</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export interface MockOptions {
  /** Venue power state for the workspace. */
  venue?: 'off' | 'booting' | 'ready' | 'desktop';
  /** POST /chat streams a long live turn (never finishes) for "working" screenshots. */
  liveTurn?: boolean;
  /**
   * Voice mode against fixtures: /voice/transcribe returns `transcript`,
   * /voice/speak a soft tone (no real voice) and /chat a short spoken answer
   * that stays in the conversation.
   */
  voice?: {
    transcript?: string;
    /** Voice turned off by the admin: every voice call answers 403. */
    blocked?: boolean;
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function venueState(mode: MockOptions['venue']) {
  if (mode === 'off') return { active: false };
  if (mode === 'booting') {
    return {
      active: true,
      sessionId: 'vs-1',
      paused: false,
      pendingInputs: [],
      teach: { recording: false, steps: 0 },
      browser: { ready: false, stage: 'provisioning', reason: null },
      desktop: { running: false },
    };
  }
  return {
    active: true,
    sessionId: 'vs-1',
    paused: false,
    pendingInputs: [],
    teach: { recording: false, steps: 0 },
    browser: {
      ready: true,
      stage: 'ready',
      frame: browserFrameSvg(),
      url: 'https://www.marmolesdelnorte.mx/precios',
      title: 'Lista de precios 2026 — Mármoles del Norte',
      tabs: [
        {
          id: 't1',
          url: 'https://www.marmolesdelnorte.mx/precios',
          title: 'Lista de precios 2026 — Mármoles del Norte',
          active: true,
        },
        {
          id: 't2',
          url: 'https://www.bing.com/search?q=travertino',
          title: 'travertino precio m2 — Buscar',
          active: false,
        },
      ],
      viewport: { width: 1280, height: 800 },
    },
    desktop:
      mode === 'desktop'
        ? { running: true, frame: desktopFrameSvg(), width: 1280, height: 800 }
        : { running: false },
  };
}

function liveTurnStream(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const script: Array<[number, unknown]> = [
    [200, { type: 'routing', data: { modelClass: 'deep' } }],
    [
      300,
      {
        type: 'reasoning',
        data: {
          delta:
            'Voy a revisar los precios públicos de la competencia y compararlos con nuestra lista. ',
        },
      },
    ],
    [
      300,
      {
        type: 'reasoning',
        data: {
          delta:
            'Primero busco en internet, luego abro cada sitio en el navegador para confirmar el precio vigente.',
        },
      },
    ],
    [
      300,
      {
        type: 'tool_call_start',
        data: { name: 'web_search', args: '{"query":"travertino precio m2 Monterrey"}' },
      },
    ],
    [700, { type: 'tool_call_end', data: { name: 'web_search', success: true, durationMs: 1420 } }],
    [
      200,
      {
        type: 'tool_call_start',
        data: {
          name: 'browser',
          args: '{"action":"open","url":"https://www.marmolesdelnorte.mx/precios"}',
        },
      },
    ],
  ];
  return new ReadableStream({
    async start(controller) {
      for (const [delay, ev] of script) {
        await new Promise((r) => setTimeout(r, delay));
        controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      }
      // Stays open: the screenshot captures the live state.
    },
  });
}

const VOICE_ANSWER = [
  'Ayer vendiste 482 mil pesos en 31 pedidos. ',
  'Norte lidera con 212 mil y Sur bajó 3 por ciento. ',
  '¿Quieres que te lo mande en PDF?',
];

/** A short spoken turn: one tool, then the answer in pieces, then done. */
function voiceTurnStream(onDone: (answer: string) => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const script: Array<[number, unknown]> = [
    [150, { type: 'routing', data: { modelClass: 'fast' } }],
    [
      150,
      {
        type: 'tool_call_start',
        data: { name: 'querySalesOrders', args: '{"from":"ayer","groupBy":"sucursal"}' },
      },
    ],
    [
      900,
      { type: 'tool_call_end', data: { name: 'querySalesOrders', success: true, durationMs: 880 } },
    ],
    ...VOICE_ANSWER.map((delta): [number, unknown] => [250, { type: 'token', data: { delta } }]),
  ];
  return new ReadableStream({
    async start(controller) {
      for (const [delay, ev] of script) {
        await new Promise((r) => setTimeout(r, delay));
        controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      }
      onDone(VOICE_ANSWER.join(''));
      controller.enqueue(enc.encode('data: {"type":"done","data":{"model":"gpt-5-mini"}}\n\n'));
      controller.close();
    },
  });
}

/** Stand-in for synthesized speech: a soft tone as long as the sentence. */
function toneWav(text: string): Uint8Array<ArrayBuffer> {
  const rate = 16_000;
  const seconds = Math.min(2.4, Math.max(0.4, text.length * 0.035));
  const samples = new Float32Array(Math.floor(rate * seconds));
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate;
    const envelope = Math.min(1, t * 20, (seconds - t) * 20);
    samples[i] = 0.08 * envelope * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(t * 9));
  }
  return encodeWav(samples, rate);
}

/** Home data for stories (fixtures only — never real data). */
export const homeFixture: HomeData = {
  firstName: 'Iván',
  agent: { name: 'Director', kind: 'principal' },
  proposals: [
    {
      id: 'p-1',
      summary: 'Enviar la cotización COT-2291 a Constructora Monterrey por WhatsApp',
      conversationId: 'c-demo',
      expiresAt: iso(-3 * HOUR),
    },
  ],
  stalled: [
    {
      kind: 'task',
      title: 'Comparar precios de travertino con 5 proveedores',
      status: 'failed',
      conversationId: 'c-demo',
      detail: 'El sitio de un proveedor no respondió',
    },
  ],
  working: 2,
  followUps: [
    {
      conversationId: 'c-demo',
      conversationTitle: 'Precios',
      text: 'Compara contra el mes pasado',
    },
    {
      conversationId: 'c-demo',
      conversationTitle: 'Precios',
      text: 'Prepara el PDF para dirección',
    },
  ],
  routines: [
    { title: 'Resumen de ventas de ayer', nextRunAt: iso(-16 * HOUR), paused: false },
    { title: 'Vigilar cotizaciones sin respuesta', nextRunAt: iso(-2 * HOUR), paused: false },
  ],
  frequent: [
    { text: 'Ventas de ayer por sucursal', count: 7 },
    { text: 'Cobranza vencida de más de 30 días', count: 4 },
  ],
  recent: [
    { id: 'c-demo', title: 'Precios de la competencia', updatedAt: iso(2 * HOUR), snippet: null },
  ],
  files: [
    {
      artifactId: 'a-1',
      name: 'Ventas septiembre.pdf',
      mimeType: 'application/pdf',
      createdAt: iso(20 * HOUR),
    },
  ],
  notifications: [
    {
      title: 'Pedido SO-1182 entregado',
      body: 'Entregado en obra',
      url: null,
      createdAt: iso(HOUR),
    },
  ],
  discover: [
    {
      id: 'computer',
      label: 'Su propia computadora',
      description: 'Abre sitios, llena formularios y corre código.',
      prompt: 'Abre el navegador y revisa mi sitio: ',
      icon: 'monitor',
    },
    {
      id: 'routine',
      label: 'Rutinas automáticas',
      description: 'Algo que corre solo cada día y te avisa.',
      prompt: 'Cada mañana a las 8 mándame el resumen de ventas.',
      icon: 'repeat',
    },
  ],
};

export const capabilitiesFixture = [
  {
    id: 'internet',
    label: 'Internet',
    items: [
      {
        id: 'builtin:web',
        group: 'internet',
        label: 'Búsqueda en internet',
        description: 'Busca, lee y cruza fuentes con citas.',
        state: 'ready',
        icon: 'globe',
        toolCount: 4,
      },
    ],
  },
  {
    id: 'computer',
    label: 'Computadora virtual',
    items: [
      {
        id: 'builtin:browser',
        group: 'computer',
        label: 'Navegador',
        description: 'Entra a sitios, hace clic y llena formularios.',
        state: 'ready',
        icon: 'mouse-pointer',
        toolCount: 3,
      },
      {
        id: 'builtin:computer',
        group: 'computer',
        label: 'Computadora virtual',
        description: 'Terminal, archivos y código.',
        state: 'ready',
        icon: 'terminal',
        toolCount: 5,
      },
    ],
  },
  {
    id: 'mcp',
    label: 'Servidores MCP',
    items: [
      {
        id: 'ext:notion',
        group: 'mcp',
        label: 'Notion',
        description: '12 herramientas',
        state: 'needs_connection',
        stateText: 'Conecta tu cuenta para usarlo.',
        icon: 'server',
        toolCount: 0,
        extensionId: 'notion',
        connect: { kind: 'oauth', target: 'notion' },
      },
      {
        id: 'ext:higgsfield',
        group: 'mcp',
        label: 'Higgsfield',
        description: 'Imágenes y video',
        state: 'down',
        stateText: 'No se pudo llegar al servidor. Se reintenta sola a las 12:04.',
        icon: 'server',
        toolCount: 0,
        extensionId: 'higgsfield',
      },
    ],
  },
  {
    id: 'skills',
    label: 'Habilidades',
    items: [
      {
        id: 'skill:cotizar',
        group: 'skills',
        label: 'Cotizar rápido',
        description: 'Arma una cotización con la lista de precios vigente.',
        state: 'ready',
        icon: 'sparkles',
        toolCount: 1,
      },
    ],
  },
];

/** Installs a fetch + EventSource simulator for the UNIVERSO APIs. */
export function installUniversoMocks(opts: MockOptions = {}): () => void {
  const w = window as unknown as {
    __uvFetch?: typeof fetch;
    __uvES?: typeof EventSource;
    __uvThreads?: Map<string, unknown[]>;
  };
  // Always wrap the REAL fetch (stories re-install on every render).
  w.__uvFetch ??= window.fetch;
  w.__uvES ??= window.EventSource;
  // Turns sent during the story (voice), per conversation.
  const threads = (w.__uvThreads ??= new Map<string, unknown[]>());
  const originalFetch = w.__uvFetch;
  const OriginalES = w.__uvES;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      window.location.origin
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const p = url.pathname;
    if (!p.startsWith('/app/assistant/api/')) return originalFetch(input, init);
    const r = p.replace('/app/assistant/api/', '');

    if (r === 'agents') return json({ agents: agentsFixture });
    if (r === 'conversations' && method === 'GET')
      return json({ conversations: conversationsFixture });
    if (r === 'conversations' && method === 'POST') return json({ id: `c-new-${Date.now()}` });
    if (r.startsWith('conversations/')) {
      const id = r.split('/')[1];
      if (method !== 'GET') return json({ ok: true });
      const conv = conversationsFixture.find((c) => c.id === id) ?? {
        id,
        title: 'Nueva conversación',
        agentId: null,
      };
      return json({
        conversation: conv,
        messages: id === 'c-demo' ? demoMessages : (threads.get(id) ?? []),
      });
    }
    if (r === 'proposals')
      return json({
        proposals:
          url.searchParams.get('conversationId') === 'c-demo' ||
          !url.searchParams.get('conversationId')
            ? proposalsFixture
            : [],
      });
    if (r === 'missions') return json({ missions: missionsFixture });
    if (r === 'tasks') return json({ tasks: tasksFixture });
    if (r === 'triggers') return json({ triggers: triggersFixture });
    if (r === 'usage')
      return json({ llm: 12.84, venue: 3.2, venueMinutes: 142, runs: 318, spent: 16.04 });
    if (r === 'models') return json({ models: modelsFixture, defaultModel: 'gpt-5-mini' });
    if (r === 'capabilities' && method === 'GET') return json({ groups: capabilitiesFixture });
    if (r === 'capabilities' && method === 'POST')
      return json({ ok: false, latencyMs: 2100, error: 'fetch failed' });
    if (r.startsWith('home')) return json({ empty: false, spec: buildHomeSpec(homeFixture) });
    if (r === 'sites')
      return json({
        sites: [
          {
            id: 's1',
            slug: 'promo-otono',
            name: 'Promoción Mármol de Otoño',
            status: 'published',
            fileCount: 5,
            visits: 128,
            url: 'https://unik.example/sites/promo-otono',
            updatedAt: iso(25 * HOUR),
          },
        ],
      });
    if (r === 'artifacts') return json({ artifacts: [] });
    if (r.startsWith('composio/toolkits')) {
      return json({
        configured: true,
        toolkits: [
          { slug: 'gmail', name: 'Gmail', logo: null, connected: true },
          { slug: 'googlecalendar', name: 'Google Calendar', logo: null, connected: true },
          { slug: 'slack', name: 'Slack', logo: null, connected: false },
          { slug: 'hubspot', name: 'HubSpot', logo: null, connected: false },
        ],
      });
    }
    if (r === 'tools')
      return json({
        categories: [
          {
            id: 'sales',
            label: 'Ventas',
            tools: [
              { name: 'querySalesOrders', description: 'Consulta órdenes de venta con filtros.' },
              { name: 'queryQuotes', description: 'Cotizaciones por estado y antigüedad.' },
            ],
          },
        ],
      });
    if (r.startsWith('venue/state')) return json(venueState(opts.venue ?? 'ready'));
    if (r.startsWith('venue/')) return json({ ok: true, frame: null });
    if (r.startsWith('voice/') && opts.voice?.blocked)
      return json({ error: 'La voz está desactivada por el administrador.' }, 403);
    if (r === 'voice/transcribe' && opts.voice)
      return json({ text: opts.voice.transcript ?? '¿Cuánto vendimos ayer por sucursal?' });
    if (r === 'voice/speak' && opts.voice) {
      const { text } = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
      return new Response(toneWav(text ?? ''), { headers: { 'Content-Type': 'audio/wav' } });
    }
    if (r === 'chat' && method === 'POST' && opts.voice) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        conversationId?: string;
        message?: string;
      };
      const convId = body.conversationId ?? 'c-voice';
      const thread = threads.get(convId) ?? [];
      const at = new Date().toISOString();
      thread.push({ id: `u-${thread.length}`, role: 'user', content: body.message, createdAt: at });
      threads.set(convId, thread);
      const stream = voiceTurnStream((answer) =>
        thread.push({
          id: `a-${thread.length}`,
          role: 'assistant',
          content: answer,
          createdAt: new Date().toISOString(),
          meta: { model: 'gpt-5-mini' },
        })
      );
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (r === 'chat' && method === 'POST') {
      if (opts.liveTurn)
        return new Response(liveTurnStream(), { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response('data: {"type":"done","data":{}}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return json({});
  };

  class SilentEventSource {
    readyState = 1;
    url: string;
    constructor(url: string) {
      this.url = url;
    }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  }
  (window as unknown as { EventSource: unknown }).EventSource = SilentEventSource;

  return () => {
    window.fetch = originalFetch;
    window.EventSource = OriginalES;
  };
}
