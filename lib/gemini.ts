import { GoogleGenAI } from "@google/genai";

const EMBEDDING_MODEL = "gemini-embedding-001";
const CHAT_MODEL = "gemini-2.5-flash";
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

  const ai = getClient();
  const transcript = history
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`)
    .join("\n");
  const response = await ai.models.generateContent({
    model: CHAT_MODEL,
    contents: `Conversation so far:\n${transcript}\n\nFollow-up question: ${question}`,
    config: {
      systemInstruction:
        "Rewrite the follow-up question into one standalone search query that can be understood without the conversation. Resolve pronouns and references using the conversation. If the follow-up is already standalone, return it unchanged. Return only the search query, with no quotes or explanation.",
    },
  });

  const query = response.text?.trim().replace(/^["']|["']$/g, "").trim();
  if (!query) return question;
  return query.slice(0, 2000);
}

export async function answerQuestion(
  question: string,
  contexts: string[],
  history: ChatTurn[] = [],
): Promise<string> {
  const ai = getClient();
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

  const response = await ai.models.generateContent({
    model: CHAT_MODEL,
    contents: `${historyBlock}Context from the uploaded files:\n${contextBlock}\n\nQuestion: ${question}`,
    config: {
      systemInstruction:
        "You answer questions using the context from the user's uploaded files. Use the recent conversation to understand follow-up questions and reply naturally. If the files do not contain the answer, say you cannot find it in the uploaded files. Keep the answer clear and concise.",
    },
  });

  const text = response.text?.trim();
  if (!text) {
    throw new Error("Gemini returned an empty answer.");
  }

  return text;
}

function normalize(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return values;
  return values.map((value) => value / magnitude);
}
