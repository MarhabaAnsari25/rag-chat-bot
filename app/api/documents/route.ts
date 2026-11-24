import { NextResponse } from "next/server";
import { databaseUpdateMessage, withDatabaseHint } from "@/lib/errors";
import { getSupabase } from "@/lib/supabase";

type ListedFile = {
  filename: string | null;
  chunk_count: number | string | null;
  uploaded_at: string | null;
};

export async function GET() {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc("list_documents");

    if (error) {
      throw new Error(error.message);
    }

    const files = ((data ?? []) as ListedFile[])
      .filter((file): file is ListedFile & { filename: string } => Boolean(file.filename))
      .map((file) => ({
        filename: file.filename,
        chunkCount: toCount(file.chunk_count),
        uploadedAt: file.uploaded_at ?? "",
      }));

    return NextResponse.json({ files });
  } catch (error) {
    return NextResponse.json(
      { error: withDatabaseHint(error, "Could not load your files.") },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const filename = await readFilename(request);
    const invalid = filenameError(filename);
    if (invalid) {
      return NextResponse.json({ error: invalid }, { status: 400 });
    }

    const supabase = getSupabase();
    const existing = await supabase
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("metadata->>filename", filename);

    if (existing.error) {
      throw new Error(existing.error.message);
    }

    if (!existing.count) {
      return NextResponse.json(
        { error: "That file is no longer in the library." },
        { status: 404 },
      );
    }

    const deleted = await supabase
      .from("documents")
      .delete({ count: "exact" })
      .eq("metadata->>filename", filename);

    if (deleted.error) {
      throw new Error(deleted.error.message);
    }

    if (!deleted.count) {
      return NextResponse.json({ error: databaseUpdateMessage }, { status: 500 });
    }

    return NextResponse.json({
      message: `Deleted ${filename} (${deleted.count} ${deleted.count === 1 ? "chunk" : "chunks"}).`,
      filename,
      chunks: deleted.count,
    });
  } catch (error) {
    return NextResponse.json(
      { error: withDatabaseHint(error, "Could not delete that file.") },
      { status: 500 },
    );
  }
}

function toCount(value: number | string | null): number {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) ? count : 0;
}

async function readFilename(request: Request): Promise<string> {
  try {
    const body: unknown = await request.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "filename" in body &&
      typeof body.filename === "string"
    ) {
      return body.filename.trim();
    }
  } catch {
    return "";
  }

  return "";
}

function filenameError(filename: string): string | null {
  if (!filename) return "Please choose a file to delete.";
  if (filename.length > 500) return "That file name is too long.";
  if (filename.includes("\0")) return "That file name is not valid.";
  return null;
}
