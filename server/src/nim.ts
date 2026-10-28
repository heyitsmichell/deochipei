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
    // Leave room for the vision fallback within the app's 120-second request limit.
    timeout: 55_000,
    maxRetries: 0,
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

  if (startIndex !== -1) {
    const endIndex = findJsonEnd(text, startIndex);
    if (endIndex !== -1) text = text.substring(startIndex, endIndex + 1).trim();
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Model returned malformed JSON.");
  }
}

function findJsonEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      const open = stack.pop();
      if ((char === "}" && open !== "{") || (char === "]" && open !== "[")) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}
