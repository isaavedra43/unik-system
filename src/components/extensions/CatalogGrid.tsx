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
  github: 'github',
  gitlab: 'gitlab',
  linear: 'linear',
  jira: 'jira',
  vercel: 'vercel',
  netlify: 'netlify',
  docker: 'docker',
  'docker-hub': 'docker',
  bitbucket: 'bitbucket',
  'azure-devops': 'azuredevops',
  'mcp-github': 'github',
  'mcp-gitlab': 'gitlab',
  'mcp-github-issues': 'github',
  'mcp-jira': 'jira',
  // Comunicaciones
  slack: 'slack',
  discord: 'discord',
  telegram: 'telegram',
  twilio: 'twilio',
  'whatsapp-business': 'whatsapp',
  'mcp-slack': 'slack',
  'mcp-discord': 'discord',
  vonage: 'vonage',
  messagebird: 'messagebird',
  pusher: 'pusher',
  ably: 'ably',
  'pusher-2': 'pusher',
  'ably-2': 'ably',
  pubnub: 'pubnub',
  'pusher-beams': 'pusher',
  // Productividad
  notion: 'notion',
  'google-calendar': 'googlecalendar',
  asana: 'asana',
  trello: 'trello',
  clickup: 'clickup',
  todoist: 'todoist',
  ticktick: 'ticktick',
  'any-do': 'anydo',
  monday: 'mondaydotcom',
  smartsheet: 'smartsheet',
  coda: 'coda',
  calendly: 'calendly',
  cron: 'cron',
  'mcp-notion': 'notion',
  'mcp-notion-db': 'notion',
  'mcp-linear': 'linear',
  'mcp-todoist': 'todoist',
  'mcp-obsidian': 'obsidian',
  // Pagos
  stripe: 'stripe',
  paypal: 'paypal',
  mercadopago: 'mercadopago',
  square: 'square',
  conekta: 'conekta',
  kushki: 'kushki',
  lemonsqueezy: 'lemonsqueezy',
  paddle: 'paddle',
  'mcp-stripe': 'stripe',
  plaid: 'plaid',
  // IA
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'googlegemini',
  mistral: 'mistralai',
  cohere: 'cohere',
  groq: 'groq',
  perplexity: 'perplexity',
  'together-ai': 'together',
  'fireworks-ai': 'fireworks',
  openrouter: 'openrouter',
  'novita-ai': 'novita',
  huggingface: 'huggingface',
  replicate: 'replicate',
  'stability-ai': 'stabilityai',
  'together-ai-2': 'together',
  'fireworks-ai-2': 'fireworks',
  'openrouter-2': 'openrouter',
  ai21: 'ai21',
  'aleph-alpha': 'alephalpha',
  'voyage-ai': 'voyageai',
  'jina-ai': 'jinaai',
  grok: 'x',
  deepseek: 'deepseek',
  'whisper-api': 'openai',
  dalle: 'openai',
  'midjourney-api': 'midjourney',
  'leonardo-ai': 'leonardoai',
  // CRM
  hubspot: 'hubspot',
  salesforce: 'salesforce',
  pipedrive: 'pipedrive',
  'zoho-crm': 'zoho',
  attio: 'attio',
  folk: 'folk',
  'hubspot-marketing': 'hubspot',
  'mcp-hubspot': 'hubspot',
  'mcp-salesforce': 'salesforce',
  // Comercio
  shopify: 'shopify',
  woocommerce: 'woocommerce',
  mercadolibre: 'mercadolibre',
  'amazon-sp': 'amazon',
  bigcommerce: 'bigcommerce',
  magento: 'magento',
  etsy: 'etsy',
  wix: 'wix',
  squarespace: 'squarespace',
  'mcp-shopify': 'shopify',
  // Datos
  'mcp-postgres': 'postgresql',
  'mcp-sqlite': 'sqlite',
  'mcp-filesystem': 'files',
  airtable: 'airtable',
  supabase: 'supabase',
  planetscale: 'planetscale',
  neon: 'neon',
  'redis-cloud': 'redis',
  fauna: 'fauna',
  cockroachdb: 'cockroachlabs',
  turso: 'turso',
  xata: 'xata',
  'mcp-airtable': 'airtable',
  'mcp-supabase': 'supabase',
  'mcp-mongodb': 'mongodb',
  'mcp-elasticsearch': 'elasticsearch',
  'mcp-neo4j': 'neo4j',
  'mcp-algolia': 'algolia',
  'planetscale-2': 'planetscale',
  'neon-2': 'neon',
  'supabase-auth': 'supabase',
  'supabase-hosting': 'supabase',
  firebase: 'firebase',
  appwrite: 'appwrite',
  // Búsqueda
  'mcp-brave-search': 'brave',
  'mcp-brave': 'brave',
  'mcp-puppeteer': 'puppeteer',
  'mcp-tavily': 'tavily',
  'mcp-exa': 'exa',
  'mcp-serper': 'serper',
  // Almacenamiento
  'aws-s3': 'amazonwebservices',
  'google-drive': 'googledrive',
  dropbox: 'dropbox',
  onedrive: 'microsoftonedrive',
  'mcp-google-drive': 'googledrive',
  'mcp-gdrive': 'googledrive',
  'mcp-dropbox': 'dropbox',
  'mcp-aws-s3': 'amazonwebservices',
  backblaze: 'backblaze',
  wasabi: 'wasabi',
  storj: 'storj',
  'backblaze-2': 'backblaze',
  'wasabi-2': 'wasabi',
  // Email
  sendgrid: 'twiliosendgrid',
  mailgun: 'mailgun',
  resend: 'resend',
  postmark: 'postmark',
  mailjet: 'mailjet',
  'amazon-ses': 'amazonwebservices',
  plunk: 'plunk',
  brevo: 'brevo',
  activecampaign: 'activecampaign',
  'mcp-sendgrid': 'twiliosendgrid',
  // Analítica
  'google-analytics': 'googleanalytics',
  mixpanel: 'mixpanel',
  amplitude: 'amplitude',
  hotjar: 'hotjar',
  posthog: 'posthog',
  klaviyo: 'klaviyo',
  customerio: 'customerio',
  // Monitoreo
  datadog: 'datadog',
  sentry: 'sentry',
  pagerduty: 'pagerduty',
  grafana: 'grafana',
  prometheus: 'prometheus',
  'better-stack': 'betterstack',
  uptimerobot: 'uptimerobot',
  statuspage: 'statuspage',
  checkly: 'checkly',
  cronitor: 'cronitor',
  'healthchecks-io': 'healthchecks',
  'sentry-self-hosted': 'sentry',
  glitchtip: 'glitchtip',
  'mcp-sentry': 'sentry',
  'mcp-datadog': 'datadog',
  // Marketing
  mailchimp: 'mailchimp',
  // Soporte
  intercom: 'intercom',
  zendesk: 'zendesk',
  freshdesk: 'freshdesk',
  helpscout: 'helpscout',
  crisp: 'crisp',
  tawkto: 'tawkto',
  // Documentación
  confluence: 'confluence',
  // Diseño
  figma: 'figma',
  canva: 'canva',
  'mcp-figma': 'figma',
  // Video
  mux: 'mux',
  cloudinary: 'cloudinary',
  tmdb: 'themoviedb',
  omdb: 'themoviedb',
  // Seguridad
  cloudflare: 'cloudflare',
  auth0: 'auth0',
  '1password': '1password',
  okta: 'okta',
  vault: 'hashicorp',
  virustotal: 'virustotal',
  haveibeenpwned: 'haveibeenpwned',
  shodan: 'shodan',
  securitytrails: 'securitytrails',
  'cloudflare-dns': 'cloudflare',
  // Social
  'twitter-x': 'x',
  linkedin: 'linkedin',
  instagram: 'instagram',
  facebook: 'facebook',
  youtube: 'youtube',
  mastodon: 'mastodon',
  bluesky: 'bluesky',
  // Mapas
  'google-maps': 'googlemaps',
  mapbox: 'mapbox',
  openstreetmap: 'openstreetmap',
  'google-places': 'googlemaps',
  'mapbox-2': 'mapbox',
  'openstreetmap-2': 'openstreetmap',
  'mcp-google-maps': 'googlemaps',
  // HR
  bamboohr: 'bamboohr',
  workday: 'workday',
  deputy: 'deputy',
  gusto: 'gusto',
  // Contabilidad
  quickbooks: 'quickbooks',
  xero: 'xero',
  freshbooks: 'freshbooks',
  'quickbooks-2': 'quickbooks',
  'xero-2': 'xero',
  'freshbooks-2': 'freshbooks',
  // Automatización
  zapier: 'zapier',
  make: 'make',
  n8n: 'n8n',
  'n8n-2': 'n8n',
  activepieces: 'activepieces',
  // Formularios
  typeform: 'typeform',
  'google-forms': 'googleforms',
  jotform: 'jotform',
  'typeform-2': 'typeform',
  fillout: 'fillout',
  // Encuestas
  'survey-monkey': 'surveymonkey',
  surveymonkey: 'surveymonkey',
  qualtrics: 'qualtrics',
  'qualtrics-2': 'qualtrics',
  // Webhooks
  svix: 'svix',
  hookdeck: 'hookdeck',
  'svix-2': 'svix',
  'hookdeck-2': 'hookdeck',
  // CMS
  wordpress: 'wordpress',
  contentful: 'contentful',
  strapi: 'strapi',
  prismic: 'prismic',
  sanity: 'sanity',
  storyblok: 'storyblok',
  'contentful-2': 'contentful',
  'strapi-2': 'strapi',
  // Hosting
  digitalocean: 'digitalocean',
  linode: 'linode',
  hetzner: 'hetzner',
  fly: 'fly',
  render: 'render',
  railway: 'railway',
  // CI/CD
  circleci: 'circleci',
  buildkite: 'buildkite',
  drone: 'drone',
  woodpecker: 'woodpeckerci',
  // Cloud
  aws: 'amazonwebservices',
  gcp: 'googlecloud',
  azure: 'microsoftazure',
  'mcp-aws': 'amazonwebservices',
  // Traducción
  deepl: 'deepl',
  'deepl-2': 'deepl',
  'google-translate': 'googletranslate',
  'yandex-translate': 'yandex',
  lingva: 'lingva',
  libretranslate: 'libretranslate',
  // OCR
  'google-vision': 'googlecloud',
  'google-vision-2': 'googlecloud',
  'aws-textract': 'amazonwebservices',
  'aws-textract-2': 'amazonwebservices',
  // Audio
  elevenlabs: 'elevenlabs',
  assemblyai: 'assemblyai',
  'elevenlabs-2': 'elevenlabs',
  'assemblyai-2': 'assemblyai',
  'minimax-tts': 'minimax',
  // Imagen
  unsplash: 'unsplash',
  pexels: 'pexels',
  'remove-bg': 'removebg',
  // Notificaciones
  pushover: 'pushover',
  ntfy: 'ntfy',
  onesignal: 'onesignal',
  expo: 'expo',
  courier: 'courier',
  // Clima
  openweather: 'openweather',
  weatherapi: 'weatherapi',
  'tomorrow-io': 'tomorrow',
  'visual-crossing': 'visualcrossing',
  // Noticias
  newsapi: 'newsapi',
  gnews: 'gnews',
  mediastack: 'mediastack',
  newsdata: 'newsdata',
  // Cripto
  coinbase: 'coinbase',
  coingecko: 'coingecko',
  binance: 'binance',
  kraken: 'kraken',
  'gemini-2': 'gemini',
  moralis: 'moralis',
  alchemy: 'alchemy',
  // Salud
  fitbit: 'fitbit',
  strava: 'strava',
  'apple-health': 'apple',
  'google-fit': 'googlefit',
  // Educación
  'canvas-lms': 'canvas',
  moodle: 'moodle',
  'google-classroom': 'googleclassroom',
  'khan-academy': 'khanacademy',
  // Legal
  docusign: 'docusign',
  ironclad: 'ironclad',
  'panda-docs': 'pandadocs',
  hellosign: 'hellosign',
  // Restaurantes
  'open-table': 'opentable',
  'the-fork': 'thefork',
  yelp: 'yelp',
  // Música
  spotify: 'spotify',
  'apple-music': 'applemusic',
  lastfm: 'lastfm',
  // Libros
  'google-books': 'googlebooks',
  'open-library': 'openlibrary',
  // Ciencia
  crossref: 'crossref',
  arxiv: 'arxiv',
  pubmed: 'pubmed',
  nasa: 'nasa',
  spacex: 'spacex',
  'wolfram-alpha': 'wolframmathematica',
  'numbers-api': 'numbersapi',
  // Finanzas
  'alpha-vantage': 'alphavantage',
  polygon: 'polygon',
  'open-exchange-rates': 'openexchangerates',
  fixer: 'fixer',
  'currency-api': 'currencyapi',
  // DevOps
  kubernetes: 'kubernetes',
  'terraform-cloud': 'terraform',
  // Mobile/QA
  browserstack: 'browserstack',
  saucelabs: 'saucelabs',
  // Networking
  ns1: 'ns1',
  // Travel
  amadeus: 'amadeus',
  skyscanner: 'skyscanner',
  booking: 'bookingdotcom',
  // Gaming
  igdb: 'igdb',
  rawg: 'rawg',
  'api-sports': 'apisports',
  espn: 'espn',
  // Food
  spoonacular: 'spoonacular',
  edamam: 'edamam',
  // Sports
  // Gobierno
  'sat-mexico': 'sat',
  'ine-mexico': 'ine',
  // Facturación
  facturapi: 'facturapi',
  'facturapi-2': 'facturapi',
  'sw-sat': 'sw',
  'sw-sat-2': 'sw',
  // Logística
  estafeta: 'estafeta',
  dhl: 'dhl',
  fedex: 'fedex',
  easypost: 'easypost',
  shippo: 'shippo',
  shipengine: 'shipengine',
  // Utilidades
  clearbit: 'clearbit',
  ipinfo: 'ipinfo',
  hunter: 'hunter',
  'rest-countries': 'restcountries',
  nationalize: 'nationalize',
  genderize: 'genderize',
  agify: 'agify',
  jsonplaceholder: 'jsonplaceholder',
  httpbin: 'httpbin',
  ipapi: 'ipapi',
  ipstack: 'ipstack',
  numverify: 'numverify',
  mailboxlayer: 'mailboxlayer',
  csvbox: 'csvbox',
  quickchart: 'quickchart',
  // Pets
  petfinder: 'petfinder',
  // QR
  'qr-server': 'qrserver',
  'qr-server-2': 'qrserver',
  // Skills genéricos con marcas
  'skill-mermaid': 'mermaid',
  'skill-plantuml': 'plantuml',
  // Otros
  hasura: 'hasura',
  imgix: 'imgix',
  // MCP servers genéricos con tecnología subyacente
  'mcp-memory': 'memory',
  'mcp-fetch': 'fetch',
  'mcp-time': 'time',
  'mcp-sequential-thinking': 'openai',
  'mcp-everart': 'openai',
  'mcp-google-sheets': 'googlesheets',
  'mcp-excel': 'microsoftexcel',
  'mcp-twilio': 'twilio',
  // Plugins con tecnología reconocible
  'plugin-rss': 'rss',
  'plugin-ical': 'icalendar',
  'plugin-markdown': 'markdown',
  'plugin-qr-generator': 'qrserver',
  'plugin-jwt': 'jwt',
  // Skills con tecnología reconocible
  'skill-yaml-parser': 'yaml',
  'skill-toml-parser': 'toml',
  'skill-xml-parser': 'xml',
  'skill-sql-builder': 'postgresql',
  'skill-json-transformer': 'json',
  'skill-csv-parser': 'csv',
  'skill-api-tester': 'postman',
  'skill-text-summarizer': 'openai',
  'skill-translator': 'deepl',
  'skill-code-formatter': 'prettier',
  'skill-diff-viewer': 'git',
  'skill-regex-generator': 'regex',
  'skill-web-scraper': 'puppeteer',
  'skill-data-validator': 'json',
  'skill-pdf-generator': 'pdf',
  'skill-sentiment': 'openai',
  'skill-keyword-extractor': 'openai',
  'skill-env-parser': 'dotenv',
  'skill-markdown-table': 'markdown',
  'skill-regex-tester': 'regex',
  // Plugins con tecnología reconocible
  'plugin-base64': 'base64',
  'plugin-hash': 'hash',
  'plugin-uuid': 'uuid',
  'plugin-emoji': 'emoji',
  'plugin-timestamp': 'time',
  'plugin-cron-parser': 'cron',
  'plugin-mock-data': 'json',
  'plugin-color-picker': 'color',
  'plugin-lorem-ipsum': 'lipsum',
  'plugin-sluggify': 'slug',
  'plugin-regex-tester': 'regex',
  // Otros con marca
  zillow: 'zillow',
  urlscan: 'urlscan',
  censys: 'censys',
  abuseipdb: 'abuseipdb',
  barcodelookup: 'barcodelookup',
  pdfco: 'pdfco',
  cloudmersive: 'cloudmersive',
  // Rive y Office
  rive: 'rive',
  'microsoft-office': 'microsoftoffice',
  'mcp-office': 'microsoftoffice',
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

/**
 * Entry logo: a Composio app's own logo URL wins, then the Simple Icons brand
 * map, then the Lucide fallback. Only http(s) logo URLs are rendered.
 */
function EntryLogo({ entry, size = 24 }: { entry: DisplayEntry; size?: number }) {
  const [error, setError] = useState(false);
  const safeLogo = entry.logoUrl && /^https?:\/\//i.test(entry.logoUrl) ? entry.logoUrl : null;

  if (safeLogo && !error) {
    return (
      <img
        src={safeLogo}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        referrerPolicy="no-referrer"
        style={{ display: 'block', objectFit: 'contain' }}
        onError={() => setError(true)}
      />
    );
  }
  return <BrandLogo entryId={entry.brandKey} icon={entry.icon} size={size} />;
}

// ---------------------------------------------------------------------------
// Composio apps — real integrations, fetched from the admin API
// ---------------------------------------------------------------------------

export interface ComposioAppItem {
  slug: string;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  authSchemes: string[];
  managedAuthSchemes: string[];
  toolsCount: number;
  appUrl: string | null;
  noAuth: boolean;
  /** Policy state: 'enabled' when an admin turned it on, 'configured' when it exists. */
  status?: 'enabled' | 'configured' | null;
}

/** Composio category names → Spanish (fallback keeps the raw name). */
const COMPOSIO_CATEGORY_ES: Record<string, string> = {
  'developer tools': 'Desarrollo',
  devtools: 'Desarrollo',
  development: 'Desarrollo',
  'api tools': 'Desarrollo',
  communication: 'Comunicaciones',
  messaging: 'Comunicaciones',
  chat: 'Comunicaciones',
  collaboration: 'Comunicaciones',
  productivity: 'Productividad',
  'project management': 'Productividad',
  'task management': 'Productividad',
  notes: 'Productividad',
  documents: 'Productividad',
  'file management': 'Almacenamiento',
  storage: 'Almacenamiento',
  crm: 'CRM',
  sales: 'Ventas',
  marketing: 'Marketing',
  'email marketing': 'Marketing',
  email: 'Email',
  calendar: 'Productividad',
  scheduling: 'Productividad',
  meetings: 'Productividad',
  payment: 'Pagos',
  payments: 'Pagos',
  billing: 'Pagos',
  invoicing: 'Pagos',
  accounting: 'Contabilidad',
  finance: 'Finanzas',
  'e-commerce': 'E-commerce',
  ecommerce: 'E-commerce',
  commerce: 'E-commerce',
  ai: 'IA',
  'artificial intelligence': 'IA',
  'machine learning': 'IA',
  analytics: 'Analítica',
  'data analytics': 'Analítica',
  database: 'Datos',
  databases: 'Datos',
  'data management': 'Datos',
  search: 'Búsqueda',
  social: 'Social',
  'social media': 'Social',
  support: 'Soporte',
  'customer support': 'Soporte',
  'customer service': 'Soporte',
  hr: 'RRHH',
  'human resources': 'RRHH',
  recruiting: 'RRHH',
  legal: 'Legal',
  security: 'Seguridad',
  identity: 'Seguridad',
  cms: 'CMS',
  'content management': 'CMS',
  forms: 'Formularios',
  surveys: 'Encuestas',
  automation: 'Automatización',
  workflows: 'Automatización',
  design: 'Diseño',
  video: 'Video',
  audio: 'Audio',
  images: 'Imagen',
  maps: 'Mapas',
  location: 'Mapas',
  news: 'Noticias',
  monitoring: 'Monitoreo',
  devops: 'DevOps',
  'ci/cd': 'DevOps',
  cloud: 'Cloud',
  hosting: 'Hosting',
  webhooks: 'Webhooks',
  spreadsheets: 'Datos',
  travel: 'Viajes',
  education: 'Educación',
  health: 'Salud',
  gaming: 'Gaming',
  weather: 'Clima',
  utilities: 'Utilidades',
  translation: 'Traducción',
  iot: 'IoT',
};

function composioCategory(categories: string[]): string {
  for (const c of categories) {
    const mapped = COMPOSIO_CATEGORY_ES[c.toLowerCase()];
    if (mapped) return mapped;
  }
  return categories[0] ?? 'Apps';
}

/** Deterministic brand-ish color per slug (Composio doesn't ship colors). */
const APP_COLORS = [
  '#6366f1',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#3b82f6',
  '#84cc16',
  '#a855f7',
];
function appColor(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0;
  return APP_COLORS[Math.abs(h) % APP_COLORS.length];
}

/** Composio auth scheme → UNIK auth filter bucket + label. */
function schemeToAuth(scheme: string): { type: string; label: string } {
  const s = scheme.toUpperCase();
  if (s.startsWith('OAUTH')) return { type: 'oauth', label: 'OAuth' };
  if (s === 'API_KEY' || s.includes('API_KEY')) return { type: 'api_key', label: 'API Key' };
  if (s === 'BEARER_TOKEN' || s.includes('BEARER')) return { type: 'bearer', label: 'Bearer' };
  if (s === 'BASIC' || s === 'DIGEST' || s === 'BASIC_WITH_JWT')
    return { type: 'bearer', label: 'Usuario/clave' };
  if (s === 'NO_AUTH' || s === 'NONE') return { type: 'none', label: 'Sin credenciales' };
  return { type: 'api_key', label: 'Credenciales' };
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
  app: 'Composio',
};

const KIND_FILTERS: { value: CatalogKind | 'app' | 'all'; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'app', label: 'Apps' },
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
// Unified display entry — curated template OR real Composio app
// ---------------------------------------------------------------------------

interface DisplayEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  kind: CatalogKind | 'app';
  /** Lucide icon name (fallback). */
  icon: string;
  /** Brand color for the icon tile. */
  color: string;
  /** Simple-Icons key (curated) or slug (app) for BRAND_LOGOS lookup. */
  brandKey: string;
  /** Direct logo URL (Composio). Takes precedence over brand lookup. */
  logoUrl: string | null;
  /** Auth filter buckets this entry satisfies. */
  authTypes: string[];
  authLabel: string;
  functionsLabel: string;
  verified: boolean;
  curated: CuratedEntry | null;
  app: ComposioAppItem | null;
  haystack: string;
}

function curatedToDisplay(e: CuratedEntry): DisplayEntry {
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    category: e.category,
    kind: e.kind,
    icon: e.icon,
    color: e.color,
    brandKey: e.id,
    logoUrl: null,
    authTypes: [e.authType],
    authLabel: AUTH_LABELS[e.authType] ?? e.authType,
    functionsLabel: `${e.capabilities.length} funciones`,
    verified: e.verified,
    curated: e,
    app: null,
    haystack: [
      e.name,
      e.description,
      e.longDescription,
      e.category,
      e.kind,
      e.authType,
      ...e.capabilities,
    ]
      .join(' ')
      .toLowerCase(),
  };
}

function appToDisplay(a: ComposioAppItem): DisplayEntry {
  const auths = a.noAuth
    ? [{ type: 'none', label: 'Sin credenciales' }]
    : [
        ...new Map(
          (a.authSchemes.length ? a.authSchemes : ['API_KEY']).map((s) => {
            const m = schemeToAuth(s);
            return [m.type, m] as const;
          })
        ).values(),
      ];
  const category = composioCategory(a.categories);
  return {
    id: `composio:${a.slug}`,
    name: a.name,
    description: a.description || `${a.name} vía Composio`,
    category,
    kind: 'app',
    icon: 'Zap',
    color: appColor(a.slug),
    brandKey: a.slug,
    logoUrl: a.logo,
    authTypes: auths.map((x) => x.type),
    authLabel: auths[0].label,
    functionsLabel: a.toolsCount > 0 ? `${a.toolsCount} herramientas` : 'Herramientas',
    verified: false,
    curated: null,
    app: a,
    haystack: [a.name, a.slug, a.description, category, ...a.categories, 'app composio']
      .join(' ')
      .toLowerCase(),
  };
}

const CURATED_DISPLAY: DisplayEntry[] = ACTIVE_CATALOG.map(curatedToDisplay);

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
  /** Called when the user clicks "Conectar" on a curated template. */
  onConnect: (entry: CuratedEntry) => void;
  /** IDs of extensions already created (to show "Conectado" badge). */
  connectedNamespaces?: string[];
  /** Filter by kind. */
  kindFilter?: CatalogKind | 'app' | null;
  /** Real Composio toolkits (already merged with policy status). */
  composioApps?: ComposioAppItem[];
  composioConfigured?: boolean;
  composioLoading?: boolean;
  composioError?: string | null;
  /** "Agregar" a Composio toolkit → creates its policy (disabled until roles are set). */
  onAddComposio?: (slug: string) => void;
  /** Jump to the Composio tab to manage an added app. */
  onManageComposio?: () => void;
  /** Slug currently being added (button shows a busy state). */
  addingToolkit?: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const INITIAL_PER_CATEGORY = 40;

export function CatalogGrid({
  onConnect,
  connectedNamespaces = [],
  kindFilter = null,
  composioApps,
  composioConfigured,
  composioLoading = false,
  composioError = null,
  onAddComposio,
  onManageComposio,
  addingToolkit = null,
}: CatalogGridProps) {
  const [selected, setSelected] = useState<DisplayEntry | null>(null);
  const [query, setQuery] = useState('');
  const [kindChip, setKindChip] = useState<CatalogKind | 'app' | 'all'>('all');
  const [authChip, setAuthChip] = useState<string>('all');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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

  const allEntries = useMemo(() => {
    const apps = (composioApps ?? []).map(appToDisplay);
    return [...apps, ...CURATED_DISPLAY];
  }, [composioApps]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const effectiveKind = kindFilter ?? kindChip;
    return allEntries.filter((e) => {
      if (effectiveKind !== 'all' && e.kind !== effectiveKind) return false;
      if (authChip !== 'all' && !e.authTypes.includes(authChip)) return false;
      if (q && !e.haystack.includes(q)) return false;
      return true;
    });
  }, [allEntries, kindFilter, kindChip, authChip, query]);

  const grouped = useMemo(() => {
    return filtered.reduce<Record<string, DisplayEntry[]>>((acc, e) => {
      (acc[e.category] ??= []).push(e);
      return acc;
    }, {});
  }, [filtered]);

  // Category index with counts (for sidebar)
  const categoryIndex = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of filtered) {
      counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0], 'es'));
  }, [filtered]);

  const isConnected = (entry: DisplayEntry) =>
    entry.curated
      ? connectedNamespaces.some((ns) => ns === entry.curated!.id || ns.includes(entry.curated!.id))
      : false;

  const appStatus = (entry: DisplayEntry) => entry.app?.status ?? null;

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
        <span className="catalog-search-count">
          {composioLoading ? 'Cargando…' : `${filtered.length} disponibles`}
        </span>
      </div>

      {/* Composio load states */}
      {composioError && (
        <div className="catalog-empty" role="alert">
          <AlertTriangle size={20} />
          <p>{composioError}</p>
        </div>
      )}
      {composioConfigured === false && (
        <p className="assistant-admin-muted" role="note">
          Composio no está configurado en el servidor — las apps reales aparecen aquí cuando haya{' '}
          <code>COMPOSIO_API_KEY</code>.
        </p>
      )}

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
          {composioLoading && (
            <div className="catalog-category-group" aria-busy="true" aria-live="polite">
              <h3 className="catalog-category-title">Apps de Composio</h3>
              <div className="catalog-grid">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="catalog-card catalog-card-skeleton" aria-hidden="true">
                    <div className="catalog-card-header">
                      <div className="catalog-card-icon catalog-skeleton-block" />
                    </div>
                    <div className="catalog-card-body">
                      <div className="catalog-skeleton-line" style={{ width: '70%' }} />
                      <div className="catalog-skeleton-line" style={{ width: '40%' }} />
                      <div className="catalog-skeleton-line" style={{ width: '90%' }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {Object.entries(grouped).map(([category, entries]) => {
            const isOpen = expanded.has(category);
            const visible = isOpen ? entries : entries.slice(0, INITIAL_PER_CATEGORY);
            const hiddenCount = entries.length - visible.length;
            return (
              <div
                key={category}
                id={`catalog-cat-${category.replace(/\s+/g, '-')}`}
                className="catalog-category-group"
              >
                <h3 className="catalog-category-title">
                  {category} <span className="catalog-category-count">({entries.length})</span>
                </h3>
                <div className="catalog-grid">
                  {visible.map((entry) => {
                    const connected = isConnected(entry);
                    const status = appStatus(entry);
                    const statusLabel =
                      status === 'enabled'
                        ? 'Habilitada'
                        : status === 'configured'
                          ? 'Configurada'
                          : null;
                    return (
                      <button
                        key={entry.id}
                        type="button"
                        className={`catalog-card ${connected || status === 'enabled' ? 'catalog-card-connected' : ''}`}
                        onClick={() => setSelected(entry)}
                        aria-label={`Ver detalles de ${entry.name}`}
                      >
                        <div className="catalog-card-header">
                          <div
                            className="catalog-card-icon"
                            style={{ backgroundColor: entry.color }}
                          >
                            <EntryLogo entry={entry} size={22} />
                          </div>
                          {entry.verified && (
                            <span className="catalog-card-verified" title="Verificado por UNIK">
                              <Shield size={12} />
                            </span>
                          )}
                          {(connected || statusLabel) && (
                            <span className="catalog-card-connected-badge">
                              {statusLabel ?? 'Conectado'}
                            </span>
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
                            <span className="catalog-card-tag">{entry.authLabel}</span>
                            <span className="catalog-card-tag">{entry.functionsLabel}</span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
                {hiddenCount > 0 && (
                  <button
                    type="button"
                    className="catalog-empty-reset"
                    onClick={() => setExpanded((s) => new Set(s).add(category))}
                  >
                    Ver todas ({entries.length})
                  </button>
                )}
                {isOpen && entries.length > INITIAL_PER_CATEGORY && (
                  <button
                    type="button"
                    className="catalog-empty-reset"
                    onClick={() =>
                      setExpanded((s) => {
                        const n = new Set(s);
                        n.delete(category);
                        return n;
                      })
                    }
                  >
                    Ver menos
                  </button>
                )}
              </div>
            );
          })}

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
            if (selected.curated) onConnect(selected.curated);
            setSelected(null);
          }}
          onAddComposio={onAddComposio}
          onManageComposio={onManageComposio}
          adding={selected.app ? addingToolkit === selected.app.slug : false}
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
  onAddComposio,
  onManageComposio,
  adding,
}: {
  entry: DisplayEntry;
  connected: boolean;
  onClose: () => void;
  onConnect: () => void;
  onAddComposio?: (slug: string) => void;
  onManageComposio?: () => void;
  adding: boolean;
}) {
  const app = entry.app;
  const curated = entry.curated;

  return (
    <div className="catalog-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="catalog-modal" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="catalog-modal-close" onClick={onClose} aria-label="Cerrar">
          <X size={20} />
        </button>

        {/* Header */}
        <div className="catalog-modal-header">
          <div className="catalog-modal-icon" style={{ backgroundColor: entry.color }}>
            <EntryLogo entry={entry} size={32} />
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
              <span className="catalog-modal-auth">{entry.authLabel}</span>
            </div>
          </div>
        </div>

        {/* Description */}
        <p className="catalog-modal-desc">{curated?.longDescription ?? entry.description}</p>

        {app ? (
          <>
            {/* Composio app details */}
            <div className="catalog-modal-section">
              <h4 className="catalog-modal-section-title">
                <Zap size={14} /> ¿Qué incluye?
              </h4>
              <ul className="catalog-modal-capabilities">
                <li className="catalog-modal-capability">
                  <CheckSquare size={14} className="catalog-modal-check" />
                  {app.toolsCount > 0
                    ? `${app.toolsCount} herramientas disponibles para el asistente`
                    : 'Herramientas disponibles para el asistente'}
                </li>
                <li className="catalog-modal-capability">
                  <CheckSquare size={14} className="catalog-modal-check" />
                  {app.noAuth
                    ? 'Sin autenticación — funciona sin conectar cuenta'
                    : `Autenticación: ${entry.authLabel}${
                        app.authSchemes.length > 1 ? ` (+${app.authSchemes.length - 1})` : ''
                      }`}
                </li>
                {app.managedAuthSchemes.length > 0 && (
                  <li className="catalog-modal-capability">
                    <CheckSquare size={14} className="catalog-modal-check" />
                    OAuth gestionado por Composio — sin configurar credenciales
                  </li>
                )}
                {app.categories.length > 0 && (
                  <li className="catalog-modal-capability">
                    <CheckSquare size={14} className="catalog-modal-check" />
                    Categorías: {app.categories.slice(0, 3).join(', ')}
                  </li>
                )}
              </ul>
            </div>

            {/* How it works */}
            <div className="catalog-modal-section">
              <h4 className="catalog-modal-section-title">
                <Code2 size={14} /> Cómo funciona
              </h4>
              <ol className="catalog-modal-steps">
                <li className="catalog-modal-step">
                  <span className="catalog-modal-step-num">1</span>
                  <span className="catalog-modal-step-text">
                    Agrega la app al catálogo de Composio de UNIK
                  </span>
                </li>
                <li className="catalog-modal-step">
                  <span className="catalog-modal-step-num">2</span>
                  <span className="catalog-modal-step-text">
                    Habilítala y asigna qué roles la pueden usar en la pestaña Composio
                  </span>
                </li>
                <li className="catalog-modal-step">
                  <span className="catalog-modal-step-num">3</span>
                  <span className="catalog-modal-step-text">
                    Cada usuario conecta su propia cuenta (OAuth o credenciales)
                  </span>
                </li>
              </ol>
            </div>

            {/* Security */}
            <div className="catalog-modal-section catalog-modal-security-section">
              <h4 className="catalog-modal-section-title">
                <Shield size={14} /> Seguridad y privacidad
              </h4>
              <p className="catalog-modal-security">
                Las cuentas se conectan por usuario directamente en Composio — UNIK no guarda tokens
                ni credenciales de terceros. Las herramientas de escritura, envío externo o acciones
                destructivas pasan por aprobación antes de ejecutarse.
              </p>
            </div>

            {/* Actions */}
            <div className="catalog-modal-actions">
              {app.appUrl && (
                <a
                  href={app.appUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="catalog-modal-docs-btn"
                >
                  Sitio del proveedor
                </a>
              )}
              {app.status === 'enabled' ? (
                <button
                  type="button"
                  className="catalog-modal-connect-btn"
                  onClick={() => {
                    onClose();
                    onManageComposio?.();
                  }}
                >
                  Gestionar en Composio
                </button>
              ) : app.status === 'configured' ? (
                <button
                  type="button"
                  className="catalog-modal-connect-btn"
                  onClick={() => {
                    onClose();
                    onManageComposio?.();
                  }}
                >
                  Habilitar en Composio
                </button>
              ) : (
                <button
                  type="button"
                  className="catalog-modal-connect-btn"
                  disabled={adding}
                  onClick={() => onAddComposio?.(app.slug)}
                >
                  {adding ? 'Agregando…' : 'Agregar'}
                </button>
              )}
            </div>
          </>
        ) : curated ? (
          <>
            {/* Capabilities */}
            <div className="catalog-modal-section">
              <h4 className="catalog-modal-section-title">
                <Zap size={14} /> ¿Qué puede hacer?
              </h4>
              <ul className="catalog-modal-capabilities">
                {curated.capabilities.map((cap, i) => (
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
                {curated.connectionSteps.map((step, i) => (
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
              <p className="catalog-modal-security">{curated.securityInfo}</p>
              {curated.allowedHosts.length > 0 && (
                <div className="catalog-modal-hosts">
                  <span className="catalog-modal-hosts-label">Dominios aprobados:</span>
                  {curated.allowedHosts.map((h) => (
                    <code key={h} className="catalog-modal-host">
                      {h}
                    </code>
                  ))}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="catalog-modal-actions">
              <a
                href={curated.docsUrl}
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
          </>
        ) : null}
      </div>
    </div>
  );
}
