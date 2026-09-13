import { z } from 'zod';

const zohoConfigSchema = z.object({
  ZOHO_CLIENT_ID: z.string().min(1),
  ZOHO_CLIENT_SECRET: z.string().min(1),
  ZOHO_REFRESH_TOKEN: z.string().min(1),
  ZOHO_ORGANIZATION_ID: z.string().min(1),
  ZOHO_API_BASE_URL: z.string().url(),
  ZOHO_ACCOUNTS_BASE_URL: z.string().url(),
  ZOHO_BOOKS_ORGANIZATION_ID: z.string().optional(),
  ZOHO_BOOKS_MOCK: z.string().optional(),
});

export interface ZohoConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  organizationId: string;
  apiBaseUrl: string;
  accountsBaseUrl: string;
  /** Zoho Books org id. Defaults to ZOHO_ORGANIZATION_ID (same org for Books + Inventory). */
  booksOrganizationId: string | null;
  /** When true, Zoho Books writes (cotizaciones) are simulated locally. */
  booksMock: boolean;
}

let cachedConfig: ZohoConfig | null = null;

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Whether Zoho Books writes should be simulated. Safe to call even when the
 * rest of the Zoho env vars are missing (used by the quotes module in dev).
 */
export function isZohoBooksMockEnabled(): boolean {
  return parseBool(process.env.ZOHO_BOOKS_MOCK);
}

/**
 * Loads and validates the Zoho configuration from environment variables.
 * Validation happens lazily (on first use) so importing this module never
 * breaks builds where the Zoho integration is not exercised.
 * Error messages only reveal which variables are missing, never their values.
 */
export function getZohoConfig(): ZohoConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const result = zohoConfigSchema.safeParse({
    ZOHO_CLIENT_ID: process.env.ZOHO_CLIENT_ID,
    ZOHO_CLIENT_SECRET: process.env.ZOHO_CLIENT_SECRET,
    ZOHO_REFRESH_TOKEN: process.env.ZOHO_REFRESH_TOKEN,
    ZOHO_ORGANIZATION_ID: process.env.ZOHO_ORGANIZATION_ID,
    ZOHO_API_BASE_URL: process.env.ZOHO_API_BASE_URL,
    ZOHO_ACCOUNTS_BASE_URL: process.env.ZOHO_ACCOUNTS_BASE_URL,
    ZOHO_BOOKS_ORGANIZATION_ID: process.env.ZOHO_BOOKS_ORGANIZATION_ID,
    ZOHO_BOOKS_MOCK: process.env.ZOHO_BOOKS_MOCK,
  });

  if (!result.success) {
    const invalidVars = result.error.issues.map((issue) => issue.path.join('.'));
    throw new Error(`Invalid or missing Zoho environment variables: ${invalidVars.join(', ')}`);
  }

  cachedConfig = {
    clientId: result.data.ZOHO_CLIENT_ID,
    clientSecret: result.data.ZOHO_CLIENT_SECRET,
    refreshToken: result.data.ZOHO_REFRESH_TOKEN,
    organizationId: result.data.ZOHO_ORGANIZATION_ID,
    apiBaseUrl: result.data.ZOHO_API_BASE_URL,
    accountsBaseUrl: result.data.ZOHO_ACCOUNTS_BASE_URL,
    booksOrganizationId: result.data.ZOHO_BOOKS_ORGANIZATION_ID?.trim() || null,
    booksMock: parseBool(result.data.ZOHO_BOOKS_MOCK),
  };

  return cachedConfig;
}
