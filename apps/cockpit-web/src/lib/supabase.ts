import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase client — Cockpit v2 / Sal Express
 *
 * URL e anon key são chaves publicáveis (seguras no client).
 * RLS no banco é o que protege os dados.
 */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Falha clara em vez de erro obscuro em runtime. Rode: cp .env.example .env.local
  throw new Error(
    "[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY não definidos. Rode: cp .env.example .env.local",
  );
}

export const isSupabaseConfigured = true;
export const SUPABASE_FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
export const SUPABASE_ANON_KEY_PUBLIC = SUPABASE_ANON_KEY;

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
