import { z } from 'zod';

const zohoConfigSchema = z.object({
  ZOHO_CLIENT_ID: z.string().min(1),
  ZOHO_CLIENT_SECRET: z.string().min(1),
  ZOHO_REFRESH_TOKEN: z.string().min(1),
  ZOHO_ORGANIZATION_ID: z.string().min(1),
  ZOHO_API_BASE_URL: z.string().url(),
  ZOHO_ACCOUNTS_BASE_URL: z.string().url(),
});

export interface ZohoConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  organizationId: string;
  apiBaseUrl: string;
  accountsBaseUrl: string;
}

let cachedConfig: ZohoConfig | null = null;

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
  };

  return cachedConfig;
}
