export const databaseUpdateMessage =
  "The database needs an update before this can work. Open Supabase, go to the SQL Editor, run the full script in supabase_setup.sql, then try again.";

export function readableError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;

  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // The message is already plain text.
  }

  return raw || fallback;
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
