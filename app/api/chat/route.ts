import { NextResponse } from "next/server";
import { withDatabaseHint } from "@/lib/errors";
import { embedTexts, rewriteSearchQuery, streamAnswer, type ChatTurn } from "@/lib/gemini";
import { getSupabase, type DocumentMatch } from "@/lib/supabase";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    const message =
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string"
        ? body.message.trim()
        : "";
    const filename =
      typeof body === "object" &&
      body !== null &&
      "filename" in body &&
      typeof body.filename === "string"
        ? body.filename.trim()
        : "";
    const history = readHistory(body);

    if (!message) {
      return NextResponse.json(
        { error: "Please type a question." },
        { status: 400 },
      );
    }

    if (message.length > 2000) {
      return NextResponse.json(
        { error: "Please keep your question under 2000 characters." },
        { status: 400 },
      );
    }

    if (filename.length > 500 || filename.includes("\0")) {
      return NextResponse.json(
        { error: "That file name is not valid." },
        { status: 400 },
      );
    }

    const searchQuery = await rewriteSearchQuery(message, history);
    const [queryEmbedding] = await embedTexts([searchQuery], "RETRIEVAL_QUERY");
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc("match_documents", {
      query_embedding: queryEmbedding,
      match_threshold: 0.3,
      match_count: 5,
      ...(filename ? { filter_filename: filename } : {}),
    });

    if (error) {
      throw new Error(error.message);
    }

    const matches = (data ?? []) as DocumentMatch[];
    const sources = matches.map((match) => ({
      filename: match.metadata?.filename ?? "Uploaded file",
      similarity: match.similarity,
      excerpt: match.content.slice(0, 240),
    }));
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };

        try {
          for await (const text of streamAnswer(
            message,
            matches.map((match) => match.content),
            history,
          )) {
            send({ type: "delta", text });
          }
          send({ type: "sources", sources });
          send({ type: "done" });
          controller.close();
        } catch (error) {
          send({ type: "error", error: withDatabaseHint(error, "Chat failed.") });
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: withDatabaseHint(error, "Chat failed.") },
      { status: 500 },
    );
  }
}

function readHistory(body: unknown): ChatTurn[] {
  if (typeof body !== "object" || body === null || !("history" in body)) return [];
  if (!Array.isArray(body.history)) return [];

  const turns: ChatTurn[] = [];
  for (const item of body.history.slice(-5)) {
    if (typeof item !== "object" || item === null) continue;
    if (!("role" in item) || !("content" in item)) continue;
    if (item.role !== "user" && item.role !== "assistant") continue;
    if (typeof item.content !== "string") continue;
    const content = item.content.trim().slice(0, 4000);
    if (!content) continue;
    turns.push({ role: item.role, content });
  }

  return turns;
}
