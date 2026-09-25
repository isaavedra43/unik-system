'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Brain,
  Calendar,
  CheckSquare,
  Clock,
  Cloud,
  Code2,
  CreditCard,
  Database,
  Download,
  FileText,
  GitBranch,
  HardDrive,
  Map as MapIcon,
  MessageSquare,
  Search,
  Send,
  Shield,
  ShoppingBag,
  Sparkles,
  Square,
  TrendingUp,
  Users,
  Video,
  X,
  Zap,
} from 'lucide-react';
import {
  ACTIVE_CATALOG,
  groupByCategory,
  type CatalogKind,
  type CuratedEntry,
} from '@/modules/extensions/curated-catalog';

// ---------------------------------------------------------------------------
// Brand logos — maps catalog entry IDs to Simple Icons slugs (official brand SVGs)
// https://cdn.simpleicons.org/{slug}/white  →  white SVG on colored background
// Falls back to Lucide icon on error or when no brand logo exists.
// ---------------------------------------------------------------------------

const BRAND_LOGOS: Record<string, string> = {
  // Desarrollo
  github: 'github', gitlab: 'gitlab', linear: 'linear', jira: 'jira',
  vercel: 'vercel', netlify: 'netlify', docker: 'docker', 'docker-hub': 'docker',
  bitbucket: 'bitbucket', 'azure-devops': 'azuredevops',
  'mcp-github': 'github', 'mcp-gitlab': 'gitlab', 'mcp-github-issues': 'github',
  'mcp-jira': 'jira',
  // Comunicaciones
  slack: 'slack', discord: 'discord', telegram: 'telegram', twilio: 'twilio',
  'whatsapp-business': 'whatsapp', 'mcp-slack': 'slack', 'mcp-discord': 'discord',
  vonage: 'vonage', messagebird: 'messagebird', pusher: 'pusher', ably: 'ably',
  'pusher-2': 'pusher', 'ably-2': 'ably', pubnub: 'pubnub', 'pusher-beams': 'pusher',
  // Productividad
  notion: 'notion', 'google-calendar': 'googlecalendar', asana: 'asana',
  trello: 'trello', clickup: 'clickup', todoist: 'todoist', ticktick: 'ticktick',
  'any-do': 'anydo', monday: 'mondaydotcom', smartsheet: 'smartsheet',
  coda: 'coda', calendly: 'calendly', cron: 'cron', 'mcp-notion': 'notion',
  'mcp-notion-db': 'notion', 'mcp-linear': 'linear', 'mcp-todoist': 'todoist',
  'mcp-obsidian': 'obsidian',
  // Pagos
  stripe: 'stripe', paypal: 'paypal', 'mercadopago': 'mercadopago', square: 'square',
  conekta: 'conekta', kushki: 'kushki', lemonsqueezy: 'lemonsqueezy', paddle: 'paddle',
  'mcp-stripe': 'stripe', plaid: 'plaid',
  // IA
  openai: 'openai', anthropic: 'anthropic', gemini: 'googlegemini', mistral: 'mistralai',
  cohere: 'cohere', groq: 'groq', perplexity: 'perplexity', 'together-ai': 'together',
  'fireworks-ai': 'fireworks', openrouter: 'openrouter', 'novita-ai': 'novita',
  huggingface: 'huggingface', replicate: 'replicate', 'stability-ai': 'stabilityai',
  'together-ai-2': 'together', 'fireworks-ai-2': 'fireworks', 'openrouter-2': 'openrouter',
  ai21: 'ai21', 'aleph-alpha': 'alephalpha', 'voyage-ai': 'voyageai', 'jina-ai': 'jinaai',
  grok: 'x', deepseek: 'deepseek', 'whisper-api': 'openai', dalle: 'openai',
  'midjourney-api': 'midjourney', 'leonardo-ai': 'leonardoai',
  // CRM
  hubspot: 'hubspot', salesforce: 'salesforce', pipedrive: 'pipedrive',
  'zoho-crm': 'zoho', attio: 'attio', folk: 'folk', 'hubspot-marketing': 'hubspot',
  'mcp-hubspot': 'hubspot', 'mcp-salesforce': 'salesforce',
  // Comercio
  shopify: 'shopify', woocommerce: 'woocommerce', mercadolibre: 'mercadolibre',
  'amazon-sp': 'amazon', bigcommerce: 'bigcommerce', magento: 'magento', etsy: 'etsy',
  wix: 'wix', squarespace: 'squarespace', 'mcp-shopify': 'shopify',
  // Datos
  'mcp-postgres': 'postgresql', 'mcp-sqlite': 'sqlite', 'mcp-filesystem': 'files',
  airtable: 'airtable', supabase: 'supabase', planetscale: 'planetscale', neon: 'neon',
  'redis-cloud': 'redis', fauna: 'fauna', cockroachdb: 'cockroachlabs', turso: 'turso',
  xata: 'xata', 'mcp-airtable': 'airtable', 'mcp-supabase': 'supabase',
  'mcp-mongodb': 'mongodb', 'mcp-elasticsearch': 'elasticsearch', 'mcp-neo4j': 'neo4j',
  'mcp-algolia': 'algolia', 'planetscale-2': 'planetscale', 'neon-2': 'neon',
  'supabase-auth': 'supabase', 'supabase-hosting': 'supabase', firebase: 'firebase',
  appwrite: 'appwrite',
  // Búsqueda
  'mcp-brave-search': 'brave', 'mcp-brave': 'brave', 'mcp-puppeteer': 'puppeteer',
  'mcp-tavily': 'tavily', 'mcp-exa': 'exa', 'mcp-serper': 'serper',
  // Almacenamiento
  'aws-s3': 'amazonwebservices', 'google-drive': 'googledrive', dropbox: 'dropbox',
  onedrive: 'microsoftonedrive', 'mcp-google-drive': 'googledrive', 'mcp-gdrive': 'googledrive',
  'mcp-dropbox': 'dropbox', 'mcp-aws-s3': 'amazonwebservices', backblaze: 'backblaze',
  wasabi: 'wasabi', storj: 'storj', 'backblaze-2': 'backblaze', 'wasabi-2': 'wasabi',
  // Email
  sendgrid: 'twiliosendgrid', mailgun: 'mailgun', resend: 'resend', postmark: 'postmark',
  mailjet: 'mailjet', 'amazon-ses': 'amazonwebservices', plunk: 'plunk',
  brevo: 'brevo', activecampaign: 'activecampaign', 'mcp-sendgrid': 'twiliosendgrid',
  // Analítica
  'google-analytics': 'googleanalytics', mixpanel: 'mixpanel', amplitude: 'amplitude',
  hotjar: 'hotjar', posthog: 'posthog', klaviyo: 'klaviyo', customerio: 'customerio',
  // Monitoreo
  datadog: 'datadog', sentry: 'sentry', pagerduty: 'pagerduty', grafana: 'grafana',
  prometheus: 'prometheus', 'better-stack': 'betterstack', uptimerobot: 'uptimerobot',
  statuspage: 'statuspage', checkly: 'checkly', cronitor: 'cronitor',
  'healthchecks-io': 'healthchecks', 'sentry-self-hosted': 'sentry', glitchtip: 'glitchtip',
  'mcp-sentry': 'sentry', 'mcp-datadog': 'datadog',
  // Marketing
  mailchimp: 'mailchimp',
  // Soporte
  intercom: 'intercom', zendesk: 'zendesk', freshdesk: 'freshdesk', helpscout: 'helpscout',
  crisp: 'crisp', tawkto: 'tawkto',
  // Documentación
  confluence: 'confluence',
  // Diseño
  figma: 'figma', canva: 'canva', 'mcp-figma': 'figma',
  // Video
  mux: 'mux', cloudinary: 'cloudinary', tmdb: 'themoviedb', omdb: 'themoviedb',
  // Seguridad
  cloudflare: 'cloudflare', auth0: 'auth0', '1password': '1password', okta: 'okta',
  vault: 'hashicorp', virustotal: 'virustotal', 'haveibeenpwned': 'haveibeenpwned',
  shodan: 'shodan', securitytrails: 'securitytrails', 'cloudflare-dns': 'cloudflare',
  // Social
  'twitter-x': 'x', linkedin: 'linkedin', instagram: 'instagram', facebook: 'facebook',
  youtube: 'youtube', mastodon: 'mastodon', bluesky: 'bluesky',
  // Mapas
  'google-maps': 'googlemaps', mapbox: 'mapbox', openstreetmap: 'openstreetmap',
  'google-places': 'googlemaps', 'mapbox-2': 'mapbox', 'openstreetmap-2': 'openstreetmap',
  'mcp-google-maps': 'googlemaps',
  // HR
  bamboohr: 'bamboohr', workday: 'workday', deputy: 'deputy', gusto: 'gusto',
  // Contabilidad
  quickbooks: 'quickbooks', xero: 'xero', freshbooks: 'freshbooks',
  'quickbooks-2': 'quickbooks', 'xero-2': 'xero', 'freshbooks-2': 'freshbooks',
  // Automatización
  zapier: 'zapier', make: 'make', n8n: 'n8n', 'n8n-2': 'n8n', activepieces: 'activepieces',
  // Formularios
  typeform: 'typeform', 'google-forms': 'googleforms', jotform: 'jotform',
  'typeform-2': 'typeform', fillout: 'fillout',
  // Encuestas
  'survey-monkey': 'surveymonkey', surveymonkey: 'surveymonkey', qualtrics: 'qualtrics',
  'qualtrics-2': 'qualtrics',
  // Webhooks
  svix: 'svix', hookdeck: 'hookdeck', 'svix-2': 'svix', 'hookdeck-2': 'hookdeck',
  // CMS
  wordpress: 'wordpress', contentful: 'contentful', strapi: 'strapi', prismic: 'prismic',
  sanity: 'sanity', storyblok: 'storyblok', 'contentful-2': 'contentful', 'strapi-2': 'strapi',
  // Hosting
  'digitalocean': 'digitalocean', linode: 'linode', hetzner: 'hetzner', fly: 'fly',
  render: 'render', railway: 'railway',
  // CI/CD
  circleci: 'circleci', buildkite: 'buildkite', drone: 'drone', woodpecker: 'woodpeckerci',
  // Cloud
  aws: 'amazonwebservices', gcp: 'googlecloud', azure: 'microsoftazure',
  'mcp-aws': 'amazonwebservices',
  // Traducción
  deepl: 'deepl', 'deepl-2': 'deepl', 'google-translate': 'googletranslate',
  'yandex-translate': 'yandex', lingva: 'lingva', libretranslate: 'libretranslate',
  // OCR
  'google-vision': 'googlecloud', 'google-vision-2': 'googlecloud',
  'aws-textract': 'amazonwebservices', 'aws-textract-2': 'amazonwebservices',
  // Audio
  elevenlabs: 'elevenlabs', assemblyai: 'assemblyai', 'elevenlabs-2': 'elevenlabs',
  'assemblyai-2': 'assemblyai', 'minimax-tts': 'minimax',
  // Imagen
  unsplash: 'unsplash', pexels: 'pexels', 'remove-bg': 'removebg',
  // Notificaciones
  pushover: 'pushover', ntfy: 'ntfy', onesignal: 'onesignal', expo: 'expo',
  courier: 'courier',
  // Clima
  openweather: 'openweather', weatherapi: 'weatherapi', 'tomorrow-io': 'tomorrow',
  'visual-crossing': 'visualcrossing',
  // Noticias
  newsapi: 'newsapi', gnews: 'gnews', mediastack: 'mediastack', newsdata: 'newsdata',
  // Cripto
  coinbase: 'coinbase', coingecko: 'coingecko', binance: 'binance', kraken: 'kraken',
  'gemini-2': 'gemini', moralis: 'moralis', alchemy: 'alchemy',
  // Salud
  fitbit: 'fitbit', strava: 'strava', 'apple-health': 'apple', 'google-fit': 'googlefit',
  // Educación
  'canvas-lms': 'canvas', moodle: 'moodle', 'google-classroom': 'googleclassroom',
  'khan-academy': 'khanacademy',
  // Legal
  docusign: 'docusign', ironclad: 'ironclad', 'panda-docs': 'pandadocs',
  hellosign: 'hellosign',
  // Restaurantes
  'open-table': 'opentable', 'the-fork': 'thefork', yelp: 'yelp',
  // Música
  spotify: 'spotify', 'apple-music': 'applemusic', lastfm: 'lastfm',
  // Libros
  'google-books': 'googlebooks', 'open-library': 'openlibrary',
  // Ciencia
  crossref: 'crossref', arxiv: 'arxiv', pubmed: 'pubmed', nasa: 'nasa', spacex: 'spacex',
  'wolfram-alpha': 'wolframmathematica', 'numbers-api': 'numbersapi',
  // Finanzas
  'alpha-vantage': 'alphavantage', polygon: 'polygon',
  'open-exchange-rates': 'openexchangerates', fixer: 'fixer', 'currency-api': 'currencyapi',
  // DevOps
  kubernetes: 'kubernetes', 'terraform-cloud': 'terraform',
  // Mobile/QA
  browserstack: 'browserstack', saucelabs: 'saucelabs',
  // Networking
  ns1: 'ns1',
  // Travel
  amadeus: 'amadeus', skyscanner: 'skyscanner', booking: 'bookingdotcom',
  // Gaming
  igdb: 'igdb', rawg: 'rawg', 'api-sports': 'apisports', espn: 'espn',
  // Food
  spoonacular: 'spoonacular', edamam: 'edamam',
  // Sports
  // Gobierno
  'sat-mexico': 'sat', 'ine-mexico': 'ine',
  // Facturación
  facturapi: 'facturapi', 'facturapi-2': 'facturapi', 'sw-sat': 'sw', 'sw-sat-2': 'sw',
  // Logística
  estafeta: 'estafeta', dhl: 'dhl', fedex: 'fedex', easypost: 'easypost',
  shippo: 'shippo', shipengine: 'shipengine',
  // Utilidades
  clearbit: 'clearbit', ipinfo: 'ipinfo', hunter: 'hunter',
  'rest-countries': 'restcountries', 'nationalize': 'nationalize', 'genderize': 'genderize',
  agify: 'agify', jsonplaceholder: 'jsonplaceholder', httpbin: 'httpbin',
  ipapi: 'ipapi', ipstack: 'ipstack', numverify: 'numverify', mailboxlayer: 'mailboxlayer',
  csvbox: 'csvbox', quickchart: 'quickchart',
  // Pets
  petfinder: 'petfinder',
  // QR
  'qr-server': 'qrserver', 'qr-server-2': 'qrserver',
  // Skills genéricos con marcas
  'skill-mermaid': 'mermaid', 'skill-plantuml': 'plantuml',
  // Otros
  hasura: 'hasura', imgix: 'imgix',
  // MCP servers genéricos con tecnología subyacente
  'mcp-memory': 'memory', 'mcp-fetch': 'fetch', 'mcp-time': 'time',
  'mcp-sequential-thinking': 'openai', 'mcp-everart': 'openai',
  'mcp-google-sheets': 'googlesheets', 'mcp-excel': 'microsoftexcel',
  'mcp-twilio': 'twilio',
  // Plugins con tecnología reconocible
  'plugin-rss': 'rss', 'plugin-ical': 'icalendar', 'plugin-markdown': 'markdown',
  'plugin-qr-generator': 'qrserver', 'plugin-jwt': 'jwt',
  // Skills con tecnología reconocible
  'skill-yaml-parser': 'yaml', 'skill-toml-parser': 'toml',
  'skill-xml-parser': 'xml', 'skill-sql-builder': 'postgresql',
  'skill-json-transformer': 'json', 'skill-csv-parser': 'csv',
  'skill-api-tester': 'postman', 'skill-text-summarizer': 'openai',
  'skill-translator': 'deepl', 'skill-code-formatter': 'prettier',
  'skill-diff-viewer': 'git', 'skill-regex-generator': 'regex',
  'skill-web-scraper': 'puppeteer', 'skill-data-validator': 'json',
  'skill-pdf-generator': 'pdf', 'skill-sentiment': 'openai',
  'skill-keyword-extractor': 'openai', 'skill-env-parser': 'dotenv',
  'skill-markdown-table': 'markdown', 'skill-regex-tester': 'regex',
  // Plugins con tecnología reconocible
  'plugin-base64': 'base64', 'plugin-hash': 'hash', 'plugin-uuid': 'uuid',
  'plugin-emoji': 'emoji', 'plugin-timestamp': 'time',
  'plugin-cron-parser': 'cron', 'plugin-mock-data': 'json',
  'plugin-color-picker': 'color', 'plugin-lorem-ipsum': 'lipsum',
  'plugin-sluggify': 'slug', 'plugin-regex-tester': 'regex',
  // Otros con marca
  zillow: 'zillow', urlscan: 'urlscan', censys: 'censys', abuseipdb: 'abuseipdb',
  barcodelookup: 'barcodelookup', pdfco: 'pdfco', cloudmersive: 'cloudmersive',
  // Rive y Office
  rive: 'rive', 'microsoft-office': 'microsoftoffice', 'mcp-office': 'microsoftoffice',
};

// ---------------------------------------------------------------------------
// Icon lookup — maps catalog icon names to lucide components (fallback)
// ---------------------------------------------------------------------------

const ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  Github: GitBranch,
  Gitlab: GitBranch,
  Square,
  Slack: MessageSquare,
  MessageSquare,
  Send,
  FileText,
  Calendar,
  CheckSquare,
  CreditCard,
  Sparkles,
  Brain,
  Users,
  Cloud,
  ShoppingBag,
  Database,
  HardDrive,
  Search,
  Download,
  Clock,
  Activity,
  AlertTriangle,
  TrendingUp,
  Video,
  Shield,
  Zap,
  Map: MapIcon,
};

function CatalogIcon({ name, size = 24 }: { name: string; size?: number }) {
  const Cmp = ICONS[name] ?? Zap;
  return <Cmp size={size} />;
}

/**
 * Brand logo with graceful fallback to Lucide icon.
 * Uses Simple Icons CDN (https://cdn.simpleicons.org/{slug}/white)
 * for official brand SVGs in white (for colored backgrounds).
 */
function BrandLogo({ entryId, icon, size = 24 }: { entryId: string; icon: string; size?: number }) {
  const slug = BRAND_LOGOS[entryId];
  const [error, setError] = useState(false);

  if (!slug || error) {
    return <CatalogIcon name={icon} size={size} />;
  }

  return (
    <img
      src={`https://cdn.simpleicons.org/${slug}/white`}
      alt=""
      width={size}
      height={size}
      style={{ display: 'block' }}
      onError={() => setError(true)}
    />
  );
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const AUTH_LABELS: Record<string, string> = {
  oauth: 'OAuth 2.0',
  api_key: 'API Key',
  bearer: 'Bearer Token',
  none: 'Sin credenciales',
};

const KIND_LABELS: Record<string, string> = {
  api: 'API',
  mcp: 'MCP Server',
  plugin: 'Plugin',
  skill: 'Skill',
};

const KIND_FILTERS: { value: CatalogKind | 'all'; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'api', label: 'APIs' },
  { value: 'mcp', label: 'MCP Servers' },
  { value: 'plugin', label: 'Plugins' },
  { value: 'skill', label: 'Skills' },
];

const AUTH_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'Cualquier auth' },
  { value: 'oauth', label: 'OAuth 2.0' },
  { value: 'api_key', label: 'API Key' },
  { value: 'bearer', label: 'Bearer' },
  { value: 'none', label: 'Sin credenciales' },
];

// ---------------------------------------------------------------------------
// Precomputed search index for fast lookup
// ---------------------------------------------------------------------------

interface SearchableEntry {
  entry: CuratedEntry;
  haystack: string; // precomputed lowercase haystack
}

const SEARCH_INDEX: SearchableEntry[] = ACTIVE_CATALOG.map((entry) => ({
  entry,
  haystack: [
    entry.name,
    entry.description,
    entry.longDescription,
    entry.category,
    entry.kind,
    entry.authType,
    ...entry.capabilities,
  ]
    .join(' ')
    .toLowerCase(),
}));

// ---------------------------------------------------------------------------
// Highlight helper
// ---------------------------------------------------------------------------

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const q = query.trim().toLowerCase();
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="catalog-highlight">{text.slice(idx, idx + q.length)}</mark>
      {text.slice(idx + q.length)}
    </>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CatalogGridProps {
  /** Called when the user clicks "Conectar" on a catalog entry. */
  onConnect: (entry: CuratedEntry) => void;
  /** IDs of extensions already created (to show "Conectado" badge). */
  connectedNamespaces?: string[];
  /** Filter by kind. */
  kindFilter?: CatalogKind | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CatalogGrid({
  onConnect,
  connectedNamespaces = [],
  kindFilter = null,
}: CatalogGridProps) {
  const [selected, setSelected] = useState<CuratedEntry | null>(null);
  const [query, setQuery] = useState('');
  const [kindChip, setKindChip] = useState<CatalogKind | 'all'>('all');
  const [authChip, setAuthChip] = useState<string>('all');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Keyboard shortcut: "/" to focus search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === '/' &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA'
      ) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === 'Escape' && query) {
        setQuery('');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [query]);

  // Sync external kindFilter prop with internal chip
  useEffect(() => {
    if (kindFilter) setKindChip(kindFilter);
  }, [kindFilter]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list: CuratedEntry[] = [];

    for (const item of SEARCH_INDEX) {
      // Kind filter (external prop takes precedence)
      const effectiveKind = kindFilter ?? kindChip;
      if (effectiveKind !== 'all' && item.entry.kind !== effectiveKind) continue;
      // Auth filter
      if (authChip !== 'all' && item.entry.authType !== authChip) continue;
      // Query filter
      if (q && !item.haystack.includes(q)) continue;
      list.push(item.entry);
    }

    return list;
  }, [kindFilter, kindChip, authChip, query]);

  const grouped = useMemo(() => groupByCategory(filtered), [filtered]);

  // Category index with counts (for sidebar)
  const categoryIndex = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of SEARCH_INDEX) {
      const effectiveKind = kindFilter ?? kindChip;
      if (effectiveKind !== 'all' && item.entry.kind !== effectiveKind) continue;
      if (authChip !== 'all' && item.entry.authType !== authChip) continue;
      const q = query.trim().toLowerCase();
      if (q && !item.haystack.includes(q)) continue;
      counts.set(item.entry.category, (counts.get(item.entry.category) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [kindFilter, kindChip, authChip, query]);

  const isConnected = (entry: CuratedEntry) =>
    connectedNamespaces.some((ns) => ns === entry.id || ns.includes(entry.id));

  const scrollToCategory = (category: string) => {
    setActiveCategory(category);
    const el = document.getElementById(`catalog-cat-${category.replace(/\s+/g, '-')}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="catalog-grid-container">
      {/* Search bar */}
      <div className="catalog-search-bar">
        <Search size={16} className="catalog-search-icon" />
        <input
          ref={searchInputRef}
          type="text"
          className="catalog-search-input"
          placeholder="Buscar por nombre, función o categoría…  ( / para enfocar)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Buscar integración"
        />
        {query && (
          <button
            type="button"
            className="catalog-search-clear"
            onClick={() => setQuery('')}
            aria-label="Limpiar búsqueda"
          >
            <X size={14} />
          </button>
        )}
        <span className="catalog-search-count">{filtered.length} disponibles</span>
      </div>

      {/* Filter chips */}
      <div className="catalog-filters">
        <div className="catalog-filter-group">
          <span className="catalog-filter-label">Tipo:</span>
          {KIND_FILTERS.map((k) => {
            const effectiveKind = kindFilter ?? kindChip;
            const active = effectiveKind === k.value;
            return (
              <button
                key={k.value}
                type="button"
                className={`catalog-chip ${active ? 'catalog-chip-active' : ''}`}
                onClick={() => setKindChip(k.value)}
                disabled={!!kindFilter}
              >
                {k.label}
              </button>
            );
          })}
        </div>
        <div className="catalog-filter-group">
          <span className="catalog-filter-label">Auth:</span>
          {AUTH_FILTERS.map((a) => (
            <button
              key={a.value}
              type="button"
              className={`catalog-chip ${authChip === a.value ? 'catalog-chip-active' : ''}`}
              onClick={() => setAuthChip(a.value)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>

      <div className="catalog-layout">
        {/* Category sidebar */}
        <aside className="catalog-sidebar">
          <div className="catalog-sidebar-title">Categorías</div>
          <button
            type="button"
            className={`catalog-sidebar-item ${activeCategory === null ? 'catalog-sidebar-item-active' : ''}`}
            onClick={() => setActiveCategory(null)}
          >
            <span>Todas</span>
            <span className="catalog-sidebar-count">{filtered.length}</span>
          </button>
          {categoryIndex.map(([category, count]) => (
            <button
              key={category}
              type="button"
              className={`catalog-sidebar-item ${activeCategory === category ? 'catalog-sidebar-item-active' : ''}`}
              onClick={() => scrollToCategory(category)}
            >
              <span>{category}</span>
              <span className="catalog-sidebar-count">{count}</span>
            </button>
          ))}
        </aside>

        {/* Category groups */}
        <div className="catalog-content">
          {Object.entries(grouped).map(([category, entries]) => (
            <div
              key={category}
              id={`catalog-cat-${category.replace(/\s+/g, '-')}`}
              className="catalog-category-group"
            >
              <h3 className="catalog-category-title">
                {category} <span className="catalog-category-count">({entries.length})</span>
              </h3>
              <div className="catalog-grid">
                {entries.map((entry) => {
                  const connected = isConnected(entry);
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      className={`catalog-card ${connected ? 'catalog-card-connected' : ''}`}
                      onClick={() => setSelected(entry)}
                      aria-label={`Ver detalles de ${entry.name}`}
                    >
                      <div className="catalog-card-header">
                        <div
                          className="catalog-card-icon"
                          style={{ backgroundColor: entry.color }}
                        >
                          <BrandLogo entryId={entry.id} icon={entry.icon} size={22} />
                        </div>
                        {entry.verified && (
                          <span className="catalog-card-verified" title="Verificado por UNIK">
                            <Shield size={12} />
                          </span>
                        )}
                        {connected && (
                          <span className="catalog-card-connected-badge">Conectado</span>
                        )}
                      </div>
                      <div className="catalog-card-body">
                        <div className="catalog-card-name">
                          <Highlight text={entry.name} query={query} />
                        </div>
                        <div className="catalog-card-kind">{KIND_LABELS[entry.kind]}</div>
                        <div className="catalog-card-desc">
                          <Highlight text={entry.description} query={query} />
                        </div>
                        <div className="catalog-card-tags">
                          <span className="catalog-card-tag">{AUTH_LABELS[entry.authType]}</span>
                          <span className="catalog-card-tag">{entry.capabilities.length} funciones</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {filtered.length === 0 && (
            <div className="catalog-empty">
              <Search size={32} />
              <p>No se encontraron integraciones para &ldquo;{query}&rdquo;</p>
              <button
                type="button"
                className="catalog-empty-reset"
                onClick={() => {
                  setQuery('');
                  setKindChip('all');
                  setAuthChip('all');
                }}
              >
                Limpiar filtros
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Detail modal */}
      {selected && (
        <CatalogDetailModal
          entry={selected}
          connected={isConnected(selected)}
          onClose={() => setSelected(null)}
          onConnect={() => {
            onConnect(selected);
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail modal
// ---------------------------------------------------------------------------

function CatalogDetailModal({
  entry,
  connected,
  onClose,
  onConnect,
}: {
  entry: CuratedEntry;
  connected: boolean;
  onClose: () => void;
  onConnect: () => void;
}) {
  return (
    <div className="catalog-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="catalog-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="catalog-modal-close"
          onClick={onClose}
          aria-label="Cerrar"
        >
          <X size={20} />
        </button>

        {/* Header */}
        <div className="catalog-modal-header">
          <div
            className="catalog-modal-icon"
            style={{ backgroundColor: entry.color }}
          >
            <BrandLogo entryId={entry.id} icon={entry.icon} size={32} />
          </div>
          <div className="catalog-modal-title-block">
            <div className="catalog-modal-name">
              {entry.name}
              {entry.verified && (
                <span className="catalog-modal-verified" title="Verificado por UNIK">
                  <Shield size={14} /> Verificado
                </span>
              )}
            </div>
            <div className="catalog-modal-meta">
              <span className="catalog-modal-kind">{KIND_LABELS[entry.kind]}</span>
              <span className="catalog-modal-cat">{entry.category}</span>
              <span className="catalog-modal-auth">{AUTH_LABELS[entry.authType]}</span>
            </div>
          </div>
        </div>

        {/* Description */}
        <p className="catalog-modal-desc">{entry.longDescription}</p>

        {/* Capabilities */}
        <div className="catalog-modal-section">
          <h4 className="catalog-modal-section-title">
            <Zap size={14} /> ¿Qué puede hacer?
          </h4>
          <ul className="catalog-modal-capabilities">
            {entry.capabilities.map((cap, i) => (
              <li key={i} className="catalog-modal-capability">
                <CheckSquare size={14} className="catalog-modal-check" />
                {cap}
              </li>
            ))}
          </ul>
        </div>

        {/* Connection steps */}
        <div className="catalog-modal-section">
          <h4 className="catalog-modal-section-title">
            <Code2 size={14} /> Cómo conectar rápido
          </h4>
          <ol className="catalog-modal-steps">
            {entry.connectionSteps.map((step, i) => (
              <li key={i} className="catalog-modal-step">
                <span className="catalog-modal-step-num">{i + 1}</span>
                <span className="catalog-modal-step-text">{step}</span>
              </li>
            ))}
          </ol>
        </div>

        {/* Security */}
        <div className="catalog-modal-section catalog-modal-security-section">
          <h4 className="catalog-modal-section-title">
            <Shield size={14} /> Seguridad y privacidad
          </h4>
          <p className="catalog-modal-security">{entry.securityInfo}</p>
          {entry.allowedHosts.length > 0 && (
            <div className="catalog-modal-hosts">
              <span className="catalog-modal-hosts-label">Dominios aprobados:</span>
              {entry.allowedHosts.map((h) => (
                <code key={h} className="catalog-modal-host">{h}</code>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="catalog-modal-actions">
          <a
            href={entry.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="catalog-modal-docs-btn"
          >
            Ver documentación
          </a>
          <button
            type="button"
            className="catalog-modal-connect-btn"
            onClick={onConnect}
            disabled={connected}
          >
            {connected ? 'Ya conectado' : 'Conectar ahora'}
          </button>
        </div>
      </div>
    </div>
  );
}
