"use client";

import { useCallback, useEffect, useState } from "react";

export type UploadedFile = {
  filename: string;
  chunkCount: number;
  uploadedAt: string;
};

export function useUploadedFiles() {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const response = await fetch("/api/documents");
      const data = (await response.json()) as {
        files?: UploadedFile[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error || "Could not load your files.");
      }

      setFiles(data.files ?? []);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load your files.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { files, error, loading, reload };
}
