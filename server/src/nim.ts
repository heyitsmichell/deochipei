import OpenAI from "openai";

export class NimNotConfiguredError extends Error {
  constructor(message = "Receipt scanning is not configured on the server.") {
    super(message);
    this.name = "NimNotConfiguredError";
  }
}

export function getNimBaseUrl(): string {
  return process.env.NVIDIA_BASE_URL?.trim() || "https://integrate.api.nvidia.com/v1";
}

export function getVisionModel(): string {
  return process.env.NVIDIA_VISION_MODEL?.trim() || "meta/llama-3.2-90b-vision-instruct";
}

export function getVisionFallbackModel(): string {
  return process.env.NVIDIA_VISION_FALLBACK_MODEL?.trim() || "nvidia/llama-3.1-nemotron-nano-vl-8b";
}

export function getDuplicatesModel(): string {
  return process.env.NVIDIA_DUPLICATES_MODEL?.trim() || "meta/llama-3.3-70b-instruct";
}

export function getNimClient(): OpenAI {
  const apiKey = process.env.NVIDIA_API_KEY?.trim();
  if (!apiKey) {
    throw new NimNotConfiguredError("Receipt scanning is not configured on the server.");
  }
  return new OpenAI({
    baseURL: getNimBaseUrl(),
    apiKey,
  });
}

/**
 * Robustly strips markdown code fences (```json ... ``` or ``` ... ```) and parses structured JSON.
 * Throws a descriptive error if the content cannot be parsed as JSON.
 */
export function extractJson<T = unknown>(raw: string): T {
  if (!raw || typeof raw !== "string") {
    throw new Error("Cannot extract JSON: empty or invalid response string.");
  }

  let text = raw.trim();

  // Strip markdown code fences if present (e.g. ```json ... ``` or ``` ... ```)
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
  const match = text.match(fenceRegex);
  if (match && match[1]) {
    text = match[1].trim();
  }

  // Handle preambles/conversational text before '{' or '[' and trailing text after '}' or ']'
  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  let startIndex = -1;
  if (firstBrace !== -1 && firstBracket !== -1) {
    startIndex = Math.min(firstBrace, firstBracket);
  } else if (firstBrace !== -1) {
    startIndex = firstBrace;
  } else if (firstBracket !== -1) {
    startIndex = firstBracket;
  }

  const lastBrace = text.lastIndexOf("}");
  const lastBracket = text.lastIndexOf("]");
  const endIndex = Math.max(lastBrace, lastBracket);

  if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
    text = text.substring(startIndex, endIndex + 1).trim();
  }

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(
      `Failed to parse JSON from response: ${err instanceof Error ? err.message : String(err)}\nRaw text snippet: ${raw.slice(0, 300)}`
    );
  }
}
