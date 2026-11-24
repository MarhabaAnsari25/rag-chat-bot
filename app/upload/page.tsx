"use client";

import { FormEvent, useRef, useState } from "react";
import { useUploadedFiles } from "@/components/useUploadedFiles";

type Status =
  | { type: "idle" }
  | { type: "loading"; message: string }
  | { type: "success"; message: string }
  | { type: "error"; message: string };

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>({ type: "idle" });
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { files, error: filesError, loading: filesLoading, reload } = useUploadedFiles();

  function chooseFile(nextFile: File | null) {
    setFile(nextFile);
    setStatus({ type: "idle" });
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || status.type === "loading") return;

    setStatus({ type: "loading", message: "Reading the file and saving it..." });

    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/upload", { method: "POST", body });
      const data = (await response.json()) as { message?: string; error?: string };

      if (!response.ok || !data.message) {
        throw new Error(data.error || "Upload failed.");
      }

      setStatus({ type: "success", message: data.message });
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      await reload();
    } catch (caught) {
      setStatus({
        type: "error",
        message: caught instanceof Error ? caught.message : "Upload failed.",
      });
    }
  }

  async function deleteFile(filename: string) {
    if (deleting) return;
    const confirmed = window.confirm(
      `Delete ${filename} and all of its saved chunks?`,
    );
    if (!confirmed) return;

    setDeleting(filename);
    setDeleteError("");

    try {
      const response = await fetch("/api/documents", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename }),
      });
      const data = (await response.json()) as { message?: string; error?: string };

      if (!response.ok) {
        throw new Error(data.error || "Could not delete that file.");
      }

      await reload();
    } catch (caught) {
      setDeleteError(
        caught instanceof Error ? caught.message : "Could not delete that file.",
      );
    } finally {
      setDeleting(null);
    }
  }

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-y-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Upload</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Add a PDF or TXT file. The app will split it into pieces and save them
          so you can ask questions on the Chat screen.
        </p>
      </div>

      <form
        onSubmit={onSubmit}
        className="rounded-2xl border border-white/10 bg-[#12181e] p-6"
      >
        <label
          htmlFor="file"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            chooseFile(event.dataTransfer.files?.[0] ?? null);
          }}
          className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-white/15 bg-black/20 px-6 py-14 text-center"
        >
          <span className="text-sm font-medium text-white">
            {file ? file.name : "Drop a file here, or click to choose one"}
          </span>
          <span className="mt-2 text-xs text-zinc-400">PDF or TXT, up to 4 MB</span>
          <input
            id="file"
            ref={inputRef}
            type="file"
            accept=".pdf,.txt,application/pdf,text/plain"
            className="sr-only"
            onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
          />
        </label>

        <button
          type="submit"
          disabled={!file || status.type === "loading"}
          className="mt-5 h-12 w-full rounded-full bg-[#3dd6c6] text-sm font-semibold text-[#06211e] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status.type === "loading" ? "Saving..." : "Upload and save"}
        </button>

        {status.type !== "idle" ? (
          <p
            role="status"
            className={`mt-4 rounded-xl px-3 py-2 text-sm ${
              status.type === "error"
                ? "border border-red-400/30 bg-red-400/10 text-red-200"
                : status.type === "success"
                  ? "border border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                  : "border border-white/10 bg-white/5 text-zinc-300"
            }`}
          >
            {status.message}
          </p>
        ) : null}
      </form>

      <section className="mt-6" aria-labelledby="your-files">
        <h2 id="your-files" className="text-lg font-semibold tracking-tight text-white">
          Your files
        </h2>
        <p className="mt-1 text-sm text-zinc-400">
          Each file is stored as chunks. Deleting a file removes all of its chunks.
        </p>

        {filesError ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200"
          >
            {filesError}
          </p>
        ) : null}
        {deleteError ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200"
          >
            {deleteError}
          </p>
        ) : null}

        {filesLoading ? (
          <p className="mt-4 text-sm text-zinc-400" role="status">
            Loading files...
          </p>
        ) : files.length > 0 ? (
          <ul className="mt-4 space-y-3">
            {files.map((uploaded) => (
              <li
                key={uploaded.filename}
                className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-[#12181e] px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-white" title={uploaded.filename}>
                    {uploaded.filename}
                  </p>
                  <p className="mt-1 text-xs text-zinc-400">
                    {formatUploadedAt(uploaded.uploadedAt)}
                    <span className="mx-1.5 text-zinc-600">·</span>
                    {uploaded.chunkCount} {uploaded.chunkCount === 1 ? "chunk" : "chunks"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void deleteFile(uploaded.filename)}
                  disabled={deleting !== null}
                  className="h-9 shrink-0 rounded-full border border-red-400/40 px-4 text-xs font-semibold text-red-200 hover:bg-red-400/10 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label={`Delete ${uploaded.filename}`}
                >
                  {deleting === uploaded.filename ? "Deleting..." : "Delete"}
                </button>
              </li>
            ))}
          </ul>
        ) : filesError ? null : (
          <p className="mt-4 rounded-2xl border border-white/10 bg-[#12181e] px-4 py-6 text-sm text-zinc-400">
            No files yet. Upload a PDF or TXT file and it will show up here.
          </p>
        )}
      </section>
    </main>
  );
}

function formatUploadedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
