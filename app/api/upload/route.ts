import { extractText, getDocumentProxy } from "unpdf";
import { NextResponse } from "next/server";
import { chunkText } from "@/lib/chunk";
import { readableError } from "@/lib/errors";
import { embedTexts } from "@/lib/gemini";
import { getSupabase } from "@/lib/supabase";

export const maxDuration = 60;

const MAX_BYTES = 4 * 1024 * 1024;
const INSERT_BATCH = 40;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "Please choose a PDF or TXT file." },
        { status: 400 },
      );
    }

    const filename = file.name.toLowerCase();
    const isPdf = filename.endsWith(".pdf");
    const isTxt = filename.endsWith(".txt");

    if (!isPdf && !isTxt) {
      return NextResponse.json(
        { error: "Only PDF and TXT files are supported." },
        { status: 400 },
      );
    }

    if (file.size === 0) {
      return NextResponse.json({ error: "That file is empty." }, { status: 400 });
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "That file is too large. Please use a file under 4 MB." },
        { status: 400 },
      );
    }

    const rawText = isTxt ? await file.text() : await readPdf(file);
    const chunks = chunkText(rawText);

    if (chunks.length === 0) {
      return NextResponse.json(
        { error: "No readable text was found in that file." },
        { status: 400 },
      );
    }

    const embeddings = await embedTexts(chunks, "RETRIEVAL_DOCUMENT");
    const supabase = getSupabase();
    const rows = chunks.map((content, index) => ({
      content,
      metadata: { filename: file.name, chunk_index: index },
      embedding: embeddings[index],
    }));

    for (let index = 0; index < rows.length; index += INSERT_BATCH) {
      const { error } = await supabase
        .from("documents")
        .insert(rows.slice(index, index + INSERT_BATCH));

      if (error) {
        throw new Error(error.message);
      }
    }

    return NextResponse.json({
      message: `Saved ${chunks.length} text pieces from ${file.name}.`,
      chunks: chunks.length,
      filename: file.name,
    });
  } catch (error) {
    return NextResponse.json({ error: readableError(error, "Upload failed.") }, { status: 500 });
  }
}

async function readPdf(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocumentProxy(bytes);
  const extracted = await extractText(pdf, { mergePages: true });
  return extracted.text;
}
