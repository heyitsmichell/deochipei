import { z } from "zod";
import OpenAI from "openai";
import { extractJson, getNimClient, getVisionModel, getVisionFallbackModel } from "./nim.js";

const CATEGORIES = ["food", "transport", "lodging", "activities", "shopping", "groceries", "other"] as const;
const ISO_CURRENCY_CODES = new Set(
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("currency") : [],
);
const nullableText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().nullable().default(null),
);
const modelNumber = z.preprocess(
  (value) => (value === null || value === "" ? undefined : value),
  z.coerce.number().finite(),
);
const currencyCode = z
  .preprocess((value) => (typeof value === "string" ? value.trim().toUpperCase() : value), z.string().regex(/^[A-Z]{3}$/))
  .refine((value) => ISO_CURRENCY_CODES.size === 0 || ISO_CURRENCY_CODES.has(value), "Invalid ISO currency code");

export const ReceiptSchema = z.object({
  is_receipt: z
    .boolean()
    .describe("False if the image is not a receipt, bill, or invoice"),
  merchant: nullableText.describe("Business name as printed"),
  merchant_translated: nullableText.describe("Merchant name in the target language, or null if already in it"),
  detected_language: z
    .string()
    .describe("Main language printed on the receipt, in English, e.g. 'Japanese'"),
  country: nullableText.describe("Country the receipt is likely from"),
  currency: currencyCode.describe("ISO 4217 code of the amounts on the receipt, e.g. JPY, EUR, THB"),
  date: nullableText.describe("Purchase date as YYYY-MM-DD"),
  time: nullableText.describe("Purchase time as HH:MM (24-hour), if printed"),
  receipt_number: nullableText.describe("Receipt, transaction, invoice or check number exactly as printed, if any"),
  items: z.array(
    z.object({
      name: z.string().describe("Line item text exactly as printed"),
      translated_name: nullableText.describe("Line item in the target language"),
      quantity: modelNumber,
      total_price: modelNumber.describe("Line total for this item"),
    }),
  ).max(200),
  subtotal: modelNumber.nullish().default(null),
  tax: modelNumber.nullish().default(null),
  tip: modelNumber.nullish().default(null),
  service_charge: modelNumber.nullish().default(null),
  total: modelNumber.refine((value) => value > 0, "Total must be greater than zero").describe("Final amount paid, including tax, tip and service"),
  category: z.preprocess(
    (value) => {
      const normalized = typeof value === "string" ? value.toLowerCase() : "";
      return CATEGORIES.includes(normalized as (typeof CATEGORIES)[number]) ? normalized : "other";
    },
    z.enum(CATEGORIES),
  ),
  notes: nullableText.describe("Anything the traveller should double-check, in the target language"),
});

export type ReceiptScan = z.infer<typeof ReceiptSchema>;

const SYSTEM_PROMPT = `You read photos of receipts for travellers splitting costs on a trip.
Receipts can be in any language or script (Japanese, Thai, Korean, Arabic, Greek, etc.), may be crumpled, faded or photographed at an angle, and may use local number formats (e.g. "1.234,50" in Europe means 1234.50; JPY and KRW have no decimals).

Extract the data faithfully:
- Return amounts as plain numbers in the receipt's own currency. Do not convert currencies.
- Work out the currency from symbols, the country, the language, the address, or tax labels (e.g. "消費税" → JPY, "VAT 7%" with Thai text → THB). Use ISO 4217 codes.
- The total is the amount actually charged. Prefer the printed grand total; if it is unreadable, compute it from the items, tax, tip and service.
- Translate item and merchant names into the traveller's language so they can tell what they bought. Keep the printed text in "name".
- Skip lines that are not purchases (payment method, change given, loyalty points).
- Copy the receipt/transaction number and the time if they are printed; they help tell a repeat scan of this receipt from a second purchase.
- If something is unreadable or ambiguous, make your best reading and say what to check in "notes".
- If the image is not a receipt, bill, invoice, or receipt-like document, set "is_receipt" to false.

You MUST respond with a single valid JSON object strictly matching this format:
{
  "is_receipt": boolean,
  "merchant": string or null,
  "merchant_translated": string or null,
  "detected_language": string,
  "country": string or null,
  "currency": string,
  "date": string or null,
  "time": string or null,
  "receipt_number": string or null,
  "items": [
    {
      "name": string,
      "translated_name": string,
      "quantity": number,
      "total_price": number
    }
  ],
  "subtotal": number or null,
  "tax": number or null,
  "tip": number or null,
  "service_charge": number or null,
  "total": number,
  "category": "food" | "transport" | "lodging" | "activities" | "shopping" | "groceries" | "other",
  "notes": string or null
}
Return ONLY valid JSON without any markdown code fence or extra explanation.`;

export class NotAReceiptError extends Error {
  constructor(message = "That photo doesn't look like a receipt.") {
    super(message);
    this.name = "NotAReceiptError";
  }
}

export class ScanRefusedError extends Error {
  constructor(message = "The receipt could not be processed.") {
    super(message);
    this.name = "ScanRefusedError";
  }
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof OpenAI.RateLimitError) return true;
  if (err instanceof OpenAI.APIConnectionError || err instanceof OpenAI.APIConnectionTimeoutError) return true;
  if (typeof err === "object" && err !== null) {
    const errorObj = err as Record<string, unknown>;
    const status = typeof errorObj.status === "number" ? errorObj.status : undefined;
    if (status === 429 || status === 502 || status === 503 || status === 504) {
      return true;
    }
    const code = errorObj.code;
    if (
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "ECONNRESET"
    ) {
      return true;
    }
  }
  return false;
}

export async function scanReceipt(opts: {
  imageBase64: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/heic";
  targetLanguage: string;
}, injectedClient?: OpenAI): Promise<ReceiptScan> {
  const client = injectedClient ?? getNimClient();
  const primaryModel = getVisionModel();
  const fallbackModel = getVisionFallbackModel();

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: {
            url: `data:${opts.mediaType};base64,${opts.imageBase64}`,
          },
        },
        {
          type: "text",
          text: `Read this receipt. The traveller's language is ${opts.targetLanguage}. Output valid JSON only.`,
        },
      ],
    },
  ];

  let content: string | null | undefined;

  try {
    const response = await client.chat.completions.create({
      model: primaryModel,
      messages,
      temperature: 0.1,
      max_tokens: 4096,
    });
    content = response.choices[0]?.message?.content;
  } catch (primaryErr) {
    if (isRetryableError(primaryErr)) {
      console.warn(
        `Primary vision model (${primaryModel}) failed with retryable error (${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}). Retrying with fallback model (${fallbackModel})...`
      );
      const fallbackResponse = await client.chat.completions.create({
        model: fallbackModel,
        messages,
        temperature: 0.1,
        max_tokens: 4096,
      });
      content = fallbackResponse.choices[0]?.message?.content;
    } else {
      throw primaryErr;
    }
  }

  if (!content) throw new ScanRefusedError("The receipt reader returned no usable result.");

  let parsed: Record<string, unknown>;
  try {
    parsed = extractJson<Record<string, unknown>>(content);
  } catch {
    throw new ScanRefusedError("The receipt reader returned malformed data. Try scanning again.");
  }
  if (parsed && parsed.is_receipt === false) {
    throw new NotAReceiptError("That photo doesn't look like a receipt.");
  }

  let validated: ReceiptScan;
  try {
    validated = ReceiptSchema.parse(parsed);
  } catch {
    throw new ScanRefusedError("The receipt reader returned an incomplete result. Try scanning again.");
  }
  if (!validated.is_receipt) {
    throw new NotAReceiptError("That photo doesn't look like a receipt.");
  }

  return validated;
}
