export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export const UPLOAD_STEPS = [
  "Extracting text...",
  "Generating embeddings...",
  "Saving to Supabase...",
  "Done!",
] as const;

const EXTENSIONS = [".pdf", ".txt", ".docx", ".md"] as const;

export type UploadExtension = (typeof EXTENSIONS)[number];

export function uploadExtension(filename: string): UploadExtension | null {
  const lower = filename.toLowerCase();
  return EXTENSIONS.find((extension) => lower.endsWith(extension)) ?? null;
}

export function uploadProblem(filename: string, size: number): string | null {
  if (!filename.trim() || filename.includes("\0")) {
    return "Please choose a PDF, TXT, DOCX, or MD file.";
  }

  if (!uploadExtension(filename)) {
    return "That file type is not supported. Please upload a PDF, TXT, DOCX, or MD file.";
  }

  if (size <= 0) {
    return "That file is empty.";
  }

  if (size > MAX_UPLOAD_BYTES) {
    return "That file is too large. Please use a file under 4 MB.";
  }

  return null;
}
