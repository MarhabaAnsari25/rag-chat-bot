import { NextResponse } from "next/server";
import { withDatabaseHint } from "@/lib/errors";
import { suggestQuestions } from "@/lib/gemini";
import { getSupabase } from "@/lib/supabase";

type ListedFile = {
  filename: string | null;
  chunk_count: number | string | null;
  uploaded_at: string | null;
};

type ChunkRow = {
  content: string | null;
};

const suggestionCache = new Map<string, string[]>();

export async function GET(request: Request) {
  try {
    const filename = new URL(request.url).searchParams.get("filename")?.trim() ?? "";
    if (filename.length > 500 || filename.includes("\0")) {
      return NextResponse.json({ error: "That file name is not valid." }, { status: 400 });
    }

    const supabase = getSupabase();
    const listed = await supabase.rpc("list_documents");
    if (listed.error) throw new Error(listed.error.message);

    const files = ((listed.data ?? []) as ListedFile[])
      .filter((file): file is ListedFile & { filename: string } => Boolean(file.filename))
      .map((file) => ({
        filename: file.filename,
        chunkCount: Number(file.chunk_count) || 0,
        uploadedAt: file.uploaded_at ?? "",
      }));

    const chosen = filename ? files.filter((file) => file.filename === filename) : files.slice(0, 4);
    if (filename && chosen.length === 0) {
      return NextResponse.json(
        { error: "That file is no longer in the library." },
        { status: 404 },
      );
    }

    if (chosen.length === 0) {
      return NextResponse.json({ questions: [] });
    }

    const cacheKey = chosen
      .map((file) => `${file.filename}\0${file.chunkCount}\0${file.uploadedAt}`)
      .join("\n");
    const cached = suggestionCache.get(cacheKey);
    if (cached) return NextResponse.json({ questions: cached });

    const excerpts: string[] = [];
    for (const file of chosen) {
      const chunks = await supabase
        .from("documents")
        .select("content")
        .eq("metadata->>filename", file.filename)
        .limit(2);

      if (chunks.error) throw new Error(chunks.error.message);

      for (const row of (chunks.data ?? []) as ChunkRow[]) {
        const content = row.content?.replace(/\s+/g, " ").trim();
        if (content) excerpts.push(`${file.filename}: ${content.slice(0, 700)}`);
      }
    }

    const generated = excerpts.length > 0 ? await suggestQuestions(excerpts).catch(() => []) : [];
    const questions = fillQuestions(generated, chosen.map((file) => file.filename));
    if (generated.length > 0) suggestionCache.set(cacheKey, questions);

    return NextResponse.json({ questions });
  } catch (error) {
    return NextResponse.json(
      { error: withDatabaseHint(error, "Could not suggest questions.") },
      { status: 500 },
    );
  }
}

function fillQuestions(questions: string[], filenames: string[]): string[] {
  const subject = filenames.length === 1 ? filenames[0] : "these files";
  const fallback = [
    `What is ${subject} about?`,
    `What are the main points in ${subject}?`,
    `What should I remember from ${subject}?`,
  ];
  const filled = [...questions];

  for (const question of fallback) {
    if (filled.length >= 3) break;
    if (!filled.includes(question)) filled.push(question);
  }

  return filled.slice(0, 3);
}
