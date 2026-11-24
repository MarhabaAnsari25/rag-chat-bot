import { createClient } from "@supabase/supabase-js";

export type DocumentMatch = {
  id: number;
  content: string;
  metadata: {
    filename?: string;
    chunk_index?: number;
  } | null;
  similarity: number;
};

export function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing Supabase keys. Open .env.local, paste NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, save, and restart the app.",
    );
  }

  return createClient(url, key);
}
