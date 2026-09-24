import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseSettings {
  url: string;
  anonKey: string;
  /** Solo para tests. */
  fetch?: typeof fetch;
}

export class DataError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DataError";
  }
}

/**
 * Cliente con la clave anon y el JWT del usuario: todas las consultas pasan por RLS.
 * Nunca se usa la service role.
 */
export function userClient(settings: SupabaseSettings, accessToken: string | null): SupabaseClient {
  return createClient(settings.url, settings.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      ...(settings.fetch ? { fetch: settings.fetch } : {}),
    },
  });
}

export async function pingSupabase(settings: SupabaseSettings): Promise<boolean> {
  try {
    const response = await (settings.fetch ?? fetch)(`${settings.url}/auth/v1/health`, {
      headers: { apikey: settings.anonKey },
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
