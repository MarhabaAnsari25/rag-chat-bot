export const databaseUpdateMessage =
  "The database needs an update before this can work. Open Supabase, go to the SQL Editor, run the full script in supabase_setup.sql, then try again.";

export function readableError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  const message = apiMessage(raw) || raw || fallback;

  if (/quota exceeded|rate limit|RESOURCE_EXHAUSTED/i.test(message)) {
    return "The Gemini free-tier limit has been reached. Please try again later.";
  }

  return message;
}

function apiMessage(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;

  try {
    const parsed = JSON.parse(raw.slice(start)) as { error?: { message?: string } };
    return parsed.error?.message ?? null;
  } catch {
    return null;
  }
}

export function withDatabaseHint(error: unknown, fallback: string): string {
  const message = readableError(error, fallback);
  if (
    message.includes("list_documents") ||
    message.includes("filter_filename") ||
    message.includes("created_at") ||
    /permission denied for table documents/i.test(message)
  ) {
    return databaseUpdateMessage;
  }

  return message;
}
