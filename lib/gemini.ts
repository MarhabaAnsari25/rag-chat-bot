import { GoogleGenAI } from "@google/genai";

const EMBEDDING_MODEL = "gemini-embedding-001";
const CHAT_MODELS = ["gemini-2.5-flash", "gemini-3.5-flash"] as const;
type ChatModel = (typeof CHAT_MODELS)[number];

let activeChatModel: ChatModel = CHAT_MODELS[0];

function chatModelsToTry(): ChatModel[] {
  return [
    activeChatModel,
    ...CHAT_MODELS.filter((model) => model !== activeChatModel),
  ];
}

function canTryAnotherModel(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|503|RESOURCE_EXHAUSTED|UNAVAILABLE|quota|high demand|NOT_FOUND|no longer available|not found for API version/i.test(
    message,
  );
}

const EMBEDDING_DIMENSIONS = 768;
const BATCH_SIZE = 20;

type EmbeddingTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing GEMINI_API_KEY. Open .env.local, paste your key, save the file, and restart the app.",
    );
  }

  return new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
}

export async function embedTexts(
  texts: string[],
  taskType: EmbeddingTask,
): Promise<number[][]> {
  const ai = getClient();
  const vectors: number[][] = [];

  for (let index = 0; index < texts.length; index += BATCH_SIZE) {
    const batch = texts.slice(index, index + BATCH_SIZE);
    const response = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: batch,
      config: {
        taskType,
        outputDimensionality: EMBEDDING_DIMENSIONS,
      },
    });

    const embeddings = response.embeddings ?? [];
    if (embeddings.length !== batch.length) {
      throw new Error(
        "Gemini returned a different number of embeddings than expected.",
      );
    }

    for (const embedding of embeddings) {
      const values = embedding.values;
      if (!values || values.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(
          `Expected ${EMBEDDING_DIMENSIONS} numbers in each embedding, but got ${values?.length ?? 0}.`,
        );
      }
      vectors.push(normalize(values));
    }
  }

  return vectors;
}

export async function rewriteSearchQuery(
  question: string,
  history: ChatTurn[],
): Promise<string> {
  if (history.length === 0) return question;

  const transcript = history
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
    .join("\n");
  const text = await generateChatText(
    `Conversation so far:\n${transcript}\n\nFollow-up question: ${question}`,
    "Rewrite the follow-up question into one standalone search query that can be understood without the conversation. Resolve pronouns and references using the conversation. If the follow-up is already standalone, return it unchanged. Return only the search query, with no quotes or explanation.",
  );
  const query = text.replace(/^["']|["']$/g, "").trim();
  if (!query) return question;
  return query.slice(0, 2000);
}

const ANSWER_INSTRUCTION =
  "You answer questions using the context from the user's uploaded files. Use the recent conversation to understand follow-up questions and reply naturally. If the files do not contain the answer, say you cannot find it in the uploaded files. Keep the answer clear and concise.";

function answerContents(
  question: string,
  contexts: string[],
  history: ChatTurn[],
): string {
  const contextBlock =
    contexts.length > 0
      ? contexts.map((chunk, index) => `[${index + 1}] ${chunk}`).join("\n\n")
      : "No matching text was found in the uploaded files.";
  const historyBlock =
    history.length > 0
      ? `Recent conversation:\n${history
          .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
          .join("\n")}\n\n`
      : "";

  return `${historyBlock}Context from the uploaded files:\n${contextBlock}\n\nQuestion: ${question}`;
}

export async function answerQuestion(
  question: string,
  contexts: string[],
  history: ChatTurn[] = [],
): Promise<string> {
  const text = await generateChatText(
    answerContents(question, contexts, history),
    ANSWER_INSTRUCTION,
  );
  if (!text) {
    throw new Error("Gemini returned an empty answer.");
  }

  return text;
}

export async function* streamAnswer(
  question: string,
  contexts: string[],
  history: ChatTurn[] = [],
): AsyncGenerator<string> {
  const ai = getClient();
  const contents = answerContents(question, contexts, history);
  let lastError: unknown;

  for (const model of chatModelsToTry()) {
    let started = false;
    try {
      const stream = await ai.models.generateContentStream({
        model,
        contents,
        config: { systemInstruction: ANSWER_INSTRUCTION },
      });

      for await (const chunk of stream) {
        if (!chunk.text) continue;
        started = true;
        yield chunk.text;
      }

      activeChatModel = model;
      return;
    } catch (error) {
      lastError = error;
      if (started || !canTryAnotherModel(error)) throw error;
    }
  }

  throw lastError;
}

export async function suggestQuestions(excerpts: string[]): Promise<string[]> {
  const sample = excerpts
    .slice(0, 8)
    .map((excerpt, index) => `[${index + 1}] ${excerpt.slice(0, 700)}`)
    .join("\n\n");
  const text = await generateChatText(
    sample,
    "Write exactly 3 short questions a beginner could ask about the excerpts. Each question must stand alone, be answerable from the excerpts, and end with a question mark. Put one question on each line. Do not number the lines, mention a summary, or add any other text.",
  );

  return text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:\d+[\).\]]|[-*])\s*/, "").replace(/^["']|["']$/g, "").trim())
    .filter((line) => line.length > 0 && line.length <= 180)
    .slice(0, 3);
}

async function generateChatText(
  contents: string,
  systemInstruction: string,
): Promise<string> {
  const ai = getClient();
  let lastError: unknown;

  for (const model of chatModelsToTry()) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: { systemInstruction },
      });
      activeChatModel = model;
      return response.text?.trim() ?? "";
    } catch (error) {
      lastError = error;
      if (!canTryAnotherModel(error)) throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Gemini could not answer this question.");
}

function normalize(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return values;
  return values.map((value) => value / magnitude);
}
