import { z } from "zod";
import { extractJson, getDuplicatesModel, getNimClient } from "./nim.js";

const ItemSchema = z.object({
  name: z.string().max(200),
  translated_name: z.string().max(200).nullable().default(null),
  price: z.number(),
});

const Text = z.string().max(200).nullable().default(null);

/** What the app sends: the receipt just scanned, and the expenses that might be the same purchase. */
export const DuplicateCheckSchema = z.object({
  receipt: z.object({
    merchant: Text,
    merchant_translated: Text,
    date: Text,
    time: Text,
    receipt_number: Text,
    currency: z.string().max(10),
    total: z.number(),
    items: z.array(ItemSchema).max(200).default([]),
  }),
  // The app narrows the trip down to a few plausible matches first, so most scans never get here.
  candidates: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        description: z.string().max(200),
        paid_by: z.string().max(80),
        date: z.string().max(20),
        currency: z.string().max(10),
        amount: z.number(),
        source: z.enum(["scanned", "typed"]),
        merchant: Text,
        time: Text,
        receipt_number: Text,
        items: z.array(ItemSchema).max(200).default([]),
      }),
    )
    .min(1)
    .max(5),
  targetLanguage: z.string().min(2).max(40).default("English"),
});

export type DuplicateCheck = z.infer<typeof DuplicateCheckSchema>;

export interface DuplicateVerdict {
  /** Id of the expense the receipt is a copy of, or null if it's a new purchase. */
  duplicate_of: string | null;
  /** "high": the same purchase. "medium": probably, a person should look. */
  confidence: "high" | "medium" | null;
  reason: string;
}

const SYSTEM_PROMPT = `You check whether a receipt a traveller just scanned is already recorded in their group's shared trip, so the same purchase isn't charged to the group twice.

Decide whether the new receipt is the same purchase as one of the listed expenses. The same purchase often looks different:
- Merchant names may be in the original script, translated or transliterated ("一蘭" and "Ichiran"), or describe the occasion ("Dinner at Ichiran"). Expenses typed in by hand usually have no merchant or items.
- One person may photograph the itemised bill and another the card slip, which can add a tip or service charge, so totals can differ by that much.
- Dates can be a day off when someone typed the expense in later. An expense may be in another currency if someone converted it.
- A matching receipt or transaction number, or the same printed time, is strong evidence of the same receipt. Different numbers, or clearly different times, mean different purchases.

Different purchases that look alike are common on a trip: the same café twice in a day, a second round of drinks, each person paying for their own meal, a deposit and then the final bill. When the evidence is thin, say it is different; a person can still add it themselves.

Set duplicate_of to the expense's label when the verdict is same_purchase or possibly_same, and to null when it is different.

You MUST respond with a single valid JSON object strictly matching this format:
{
  "verdict": "same_purchase" | "possibly_same" | "different",
  "duplicate_of": string or null,
  "reason": string
}
Return ONLY valid JSON without any markdown code fence or extra explanation.`;

export function verdictSchema(labels: [string, ...string[]]) {
  return z.object({
    verdict: z
      .enum(["same_purchase", "possibly_same", "different"])
      .describe("same_purchase: clearly the same. possibly_same: likely, but worth a person checking."),
  duplicate_of: z.enum(labels).nullable().optional().default(null).describe("Label of the matching expense, or null"),
    reason: z
      .string()
      .max(300)
      .describe("One short sentence for the traveller naming what matches or differs, in their language"),
  });
}

export async function judgeDuplicate({
  receipt,
  candidates,
  targetLanguage,
}: DuplicateCheck): Promise<DuplicateVerdict> {
  const labels = candidates.map((_, i) => `E${i + 1}`) as [string, ...string[]];
  const listing = candidates
    .map(({ id: _id, ...expense }, i) => `${labels[i]}: ${JSON.stringify(expense)}`)
    .join("\n");

  const client = getNimClient();
  const model = getDuplicatesModel();

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content:
          `New receipt:\n${JSON.stringify(receipt)}\n\n` +
          `Expenses already on the trip:\n${listing}\n\n` +
          `The traveller's language is ${targetLanguage}.\n` +
          `Valid candidate labels are: ${labels.join(", ")}.\n` +
          `Output valid JSON only.`,
      },
    ],
    temperature: 0.1,
    max_tokens: 1024,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("Could not read a complete result from the duplicate check.");
  }

  const rawJson = extractJson<unknown>(content);
  const parsed = verdictSchema(labels).parse(rawJson);

  const match = parsed.duplicate_of ? candidates[labels.indexOf(parsed.duplicate_of)] : undefined;
  if (parsed.verdict === "different" || !match) {
    return { duplicate_of: null, confidence: null, reason: parsed.reason };
  }
  return {
    duplicate_of: match.id,
    confidence: parsed.verdict === "same_purchase" ? "high" : "medium",
    reason: parsed.reason,
  };
}
