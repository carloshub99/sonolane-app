import { createClient } from '@supabase/supabase-js';

// These come from your Supabase project → Project Settings → API.
// The "anon" key is safe to expose in client-side code — it's the
// public key, protected by Row Level Security policies on each table.
// Never put the "service_role" key here or anywhere in this app.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // eslint-disable-next-line no-console
  console.warn(
    '[SonoLane] Supabase env vars are missing. Copy .env.example to .env ' +
    'and fill in VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY, then rebuild.'
  );
}

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');

// True once a real project is wired up (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
// are set). The app checks this to decide between real accounts+data and the
// original local-only demo mode — so the app keeps working standalone
// (e.g. as a Claude Artifact preview) even with no backend configured.
export const isSupabaseConfigured = !!(supabaseUrl && supabaseAnonKey);
