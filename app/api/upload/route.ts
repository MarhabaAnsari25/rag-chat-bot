import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import { NextResponse } from "next/server";
import { chunkText } from "@/lib/chunk";
import { withDatabaseHint } from "@/lib/errors";
import { embedTexts } from "@/lib/gemini";
import { getSupabase } from "@/lib/supabase";
import { UPLOAD_STEPS, uploadExtension, uploadProblem } from "@/lib/upload";

export const maxDuration = 60;

const INSERT_BATCH = 40;

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Please choose a PDF, TXT, DOCX, or MD file." },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Please choose a PDF, TXT, DOCX, or MD file." },
      { status: 400 },
    );
  }

  const problem = uploadProblem(file.name, file.size);
  if (problem) {
    return NextResponse.json({ error: problem }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        send({ type: "status", message: UPLOAD_STEPS[0] });
        const chunks = chunkText(await readUpload(file));
        if (chunks.length === 0) {
          send({ type: "error", error: "No readable text was found in that file." });
          controller.close();
          return;
        }

        send({ type: "status", message: UPLOAD_STEPS[1] });
        const embeddings = await embedTexts(chunks, "RETRIEVAL_DOCUMENT");

        send({ type: "status", message: UPLOAD_STEPS[2] });
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

          if (error) throw new Error(error.message);
        }

        send({ type: "status", message: UPLOAD_STEPS[3] });
        send({
          type: "done",
          message: `Saved ${chunks.length} text pieces from ${file.name}.`,
          chunks: chunks.length,
          filename: file.name,
        });
        controller.close();
      } catch (error) {
        send({ type: "error", error: withDatabaseHint(error, "Upload failed.") });
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
}

async function readUpload(file: File): Promise<string> {
  const extension = uploadExtension(file.name);
  if (extension === ".txt" || extension === ".md") return file.text();
  if (extension === ".pdf") return readPdf(file);
  if (extension === ".docx") return readDocx(file);
  throw new Error("That file type is not supported. Please upload a PDF, TXT, DOCX, or MD file.");
}

async function readPdf(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await getDocumentProxy(bytes);
  const extracted = await extractText(pdf, { mergePages: true });
  return extracted.text;
}

async function readDocx(file: File): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const extracted = await mammoth.extractRawText({ buffer });
  return extracted.value;
}
