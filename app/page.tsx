"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useUploadedFiles } from "@/components/useUploadedFiles";

const CHAT_STORAGE_KEY = "rag-chat-history";

type Source = {
  filename: string;
  similarity: number;
  excerpt: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
};

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [historyReady, setHistoryReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const { files, error: filesError, loading: filesLoading } = useUploadedFiles();

  useEffect(() => {
    setMessages(readStoredMessages());
    setHistoryReady(true);
  }, []);

  useEffect(() => {
    if (!historyReady) return;

    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages));
      setStorageError("");
    } catch {
      setStorageError("This browser could not save the conversation.");
    }
  }, [historyReady, messages]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread || !loading) return;
    thread.scrollTop = thread.scrollHeight;
  }, [messages, loading, streamingId]);

  function clearChat() {
    if (!historyReady || messages.length === 0 || loading) return;
    setMessages([]);
    setError("");
  }

  useEffect(() => {
    if (!historyReady || messages.length > 0 || filesLoading || files.length === 0) return;

    const controller = new AbortController();
    setSuggestions([]);
    setSuggestionsLoading(true);

    const params = new URLSearchParams();
    if (selectedFile) params.set("filename", selectedFile);
    const query = params.toString();

    fetch(`/api/suggestions${query ? `?${query}` : ""}`, { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json()) as { questions?: unknown; error?: string };
        if (!response.ok) throw new Error(data.error || "Could not suggest questions.");
        if (!Array.isArray(data.questions)) return;
        setSuggestions(
          data.questions
            .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            .slice(0, 3),
        );
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setSuggestions([]);
        setError(caught instanceof Error ? caught.message : "Could not suggest questions.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setSuggestionsLoading(false);
      });

    return () => controller.abort();
  }, [historyReady, messages.length, filesLoading, files.length, selectedFile]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question);
  }

  async function ask(rawMessage: string) {
    const message = rawMessage.trim();
    if (!message || loading) return;

    setQuestion("");
    setError("");
    setLoading(true);
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: "user", content: message },
    ]);

    const assistantId = crypto.randomUUID();

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          history: messages.slice(-5).map((item) => ({
            role: item.role,
            content: item.content,
          })),
          ...(selectedFile ? { filename: selectedFile } : {}),
        }),
      });
      const contentType = response.headers.get("content-type") ?? "";

      if (!response.ok || contentType.includes("application/json")) {
        const data = (await response.json()) as { error?: string };
        throw new Error(data.error || "The chat request failed.");
      }

      flushSync(() => {
        setStreamingId(assistantId);
        setMessages((current) => [
          ...current,
          { id: assistantId, role: "assistant", content: "" },
        ]);
      });

      const incoming: IncomingAnswer = { text: "", sources: null, done: false, error: "" };
      const typing = typeAnswer(incoming, (content) => {
        setMessages((current) =>
          current.map((item) => (item.id === assistantId ? { ...item, content } : item)),
        );
      });

      try {
        await readChatStream(response, (event) => {
          if (event.type === "delta" && typeof event.text === "string" && event.text.length > 0) {
            incoming.text += event.text;
            return;
          }

          if (event.type === "sources" && Array.isArray(event.sources)) {
            incoming.sources = event.sources.filter(isSource);
            return;
          }

          if (event.type === "error" && event.error) incoming.error = event.error;
        });
      } finally {
        incoming.done = true;
      }

      await typing;
      if (incoming.error) throw new Error(incoming.error);
      if (!incoming.text.trim()) throw new Error("Gemini returned an empty answer.");

      if (incoming.sources && incoming.sources.length > 0) {
        const sources = incoming.sources;
        setStreamingId(null);
        setMessages((current) =>
          current.map((item) => (item.id === assistantId ? { ...item, sources } : item)),
        );
      }
    } catch (caught) {
      setMessages((current) =>
        current.filter((item) => item.id !== assistantId || item.content.trim().length > 0),
      );
      setError(caught instanceof Error ? caught.message : "The chat request failed.");
    } finally {
      setStreamingId(null);
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4 py-4">
      <div className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-white">Chat</h1>
          <p className="mt-1 break-words text-sm text-zinc-400">
            {selectedFile
              ? `Ask a question about ${selectedFile}.`
              : "Ask a question about the files you uploaded."}
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-end">
          <div className="w-full sm:w-72">
            <label htmlFor="file-filter" className="mb-1.5 block text-xs font-medium text-zinc-400">
              Search in
            </label>
            <select
              id="file-filter"
              value={selectedFile}
              onChange={(event) => setSelectedFile(event.target.value)}
              disabled={filesLoading}
              className="h-10 w-full rounded-full border border-white/10 bg-[#12181e] px-4 text-sm text-white outline-none scheme-dark focus:border-[#3dd6c6] disabled:opacity-60"
            >
              <option value="">All files</option>
              {files.map((file) => (
                <option key={file.filename} value={file.filename}>
                  {file.filename}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={clearChat}
            disabled={!historyReady || messages.length === 0 || loading}
            className="h-10 w-fit shrink-0 rounded-full border border-white/15 px-4 text-sm font-medium text-zinc-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear chat
          </button>
        </div>
      </div>
      {filesError ? (
        <p
          className="mb-4 rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200"
          role="alert"
        >
          {filesError}
        </p>
      ) : null}
      {storageError ? (
        <p
          className="mb-4 rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200"
          role="alert"
        >
          {storageError}
        </p>
      ) : null}

      <div
        ref={threadRef}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto rounded-2xl border border-white/10 bg-[#12181e] p-4"
      >
        {!historyReady ? (
          <p className="m-auto text-sm text-zinc-400" role="status">
            Loading conversation...
          </p>
        ) : messages.length === 0 ? (
          filesLoading ? (
            <p className="m-auto text-sm text-zinc-400" role="status">
              Checking your files...
            </p>
          ) : files.length === 0 ? (
            <p className="m-auto max-w-sm text-center text-sm text-zinc-400">
              Nothing here yet. Upload a PDF, TXT, DOCX, or MD file first, then ask a
              question about it.
            </p>
          ) : (
            <Suggestions
              questions={suggestions}
              loading={suggestionsLoading}
              disabled={loading}
              onAsk={(nextQuestion) => void ask(nextQuestion)}
              summary={
                selectedFile
                  ? `Summarize ${selectedFile}.`
                  : "Summarize the uploaded documents."
              }
            />
          )
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-6 ${
                message.role === "user"
                  ? "ml-auto bg-[#3dd6c6] text-[#06211e]"
                  : "bg-white/5 text-zinc-100"
              }`}
            >
              {message.id === streamingId && message.content.length === 0 ? (
                <TypingIndicator />
              ) : (
                <p className="whitespace-pre-wrap">
                  {message.content}
                  {message.id === streamingId ? (
                    <span className="ml-0.5 inline-block h-4 w-px animate-pulse bg-[#3dd6c6] align-middle" />
                  ) : null}
                </p>
              )}
              {message.sources && message.sources.length > 0 ? (
                <ul className="mt-3 space-y-2 border-t border-white/10 pt-3 text-xs text-zinc-400">
                  {message.sources.map((source, index) => (
                    <li key={`${message.id}-${index}`}>
                      <span className="font-medium text-zinc-200">
                        {source.filename}
                      </span>
                      <span className="ml-2">
                        {Math.round(source.similarity * 100)}% match
                      </span>
                      <p className="mt-1 line-clamp-2">{source.excerpt}</p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))
        )}
        {loading && !streamingId ? (
          <p className="text-sm text-zinc-400" role="status">
            {selectedFile ? `Looking through ${selectedFile}...` : "Looking through your files..."}
          </p>
        ) : null}
      </div>

      <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
        {error ? (
          <p className="rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-200" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <label className="sr-only" htmlFor="question">
            Your question
          </label>
          <input
            id="question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={
              selectedFile ? `Ask something about ${selectedFile}` : "Ask something about your files"
            }
            className="h-12 flex-1 rounded-full border border-white/10 bg-[#12181e] px-4 text-sm text-white outline-none placeholder:text-zinc-500 focus:border-[#3dd6c6]"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || question.trim().length === 0}
            className="h-12 rounded-full bg-[#3dd6c6] px-5 text-sm font-semibold text-[#06211e] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </main>
  );
}

type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "done" }
  | { type: "error"; error: string };

type IncomingAnswer = {
  text: string;
  sources: Source[] | null;
  done: boolean;
  error: string;
};

function Suggestions({
  questions,
  loading,
  disabled,
  summary,
  onAsk,
}: {
  questions: string[];
  loading: boolean;
  disabled: boolean;
  summary: string;
  onAsk: (question: string) => void;
}) {
  return (
    <div className="m-auto flex w-full max-w-lg flex-col items-center gap-4 text-center">
      <p className="text-sm text-zinc-400">Try a suggestion, or type your own question.</p>
      {loading ? (
        <p className="text-sm text-zinc-500" role="status">
          Finding questions in your files...
        </p>
      ) : (
        <div className="flex flex-wrap justify-center gap-2" aria-label="Suggested questions">
          {questions.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => onAsk(item)}
              disabled={disabled}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-left text-sm text-zinc-100 hover:border-[#3dd6c6] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {item}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => onAsk(summary)}
        disabled={disabled}
        className="rounded-full bg-[#3dd6c6] px-4 py-2 text-sm font-semibold text-[#06211e] disabled:cursor-not-allowed disabled:opacity-50"
      >
        Summarize this document
      </button>
    </div>
  );
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function typeAnswer(incoming: IncomingAnswer, publish: (content: string) => void) {
  let shown = 0;

  while (true) {
    if (shown < incoming.text.length) {
      const remaining = incoming.text.length - shown;
      const count = remaining > 180 ? 4 : remaining > 70 ? 2 : 1;
      shown += count;
      publish(incoming.text.slice(0, shown));
      await wait(count === 1 ? 28 : 16);
      continue;
    }

    if (incoming.done || incoming.error) return;
    await wait(40);
  }
}

async function readChatStream(
  response: Response,
  onEvent: (event: ChatEvent) => void | Promise<void>,
) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The chat response could not be read.");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const line = part.split("\n").find((item) => item.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6)) as ChatEvent;
      if (event.type === "done") {
        await reader.cancel();
        return;
      }
      await onEvent(event);
    }
  }
}

function TypingIndicator() {
  return (
    <span className="inline-flex h-5 items-center gap-1" role="status" aria-label="Writing a reply">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400 [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400 [animation-delay:300ms]" />
    </span>
  );
}

function readStoredMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isChatMessage);
  } catch {
    return [];
  }
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  if (!("id" in value) || !("role" in value) || !("content" in value)) return false;
  const message = value as ChatMessage;
  if (typeof message.id !== "string" || message.id.length === 0) return false;
  if (message.role !== "user" && message.role !== "assistant") return false;
  if (typeof message.content !== "string") return false;
  if (message.sources === undefined) return true;
  return Array.isArray(message.sources) && message.sources.every(isSource);
}

function isSource(value: unknown): value is Source {
  if (typeof value !== "object" || value === null) return false;
  const source = value as Source;
  return (
    typeof source.filename === "string" &&
    typeof source.similarity === "number" &&
    Number.isFinite(source.similarity) &&
    typeof source.excerpt === "string"
  );
}
