import type { Transfer } from "./ledger";

export type PaymentRequestParams = Record<string, string> & {
  settleFrom: string;
  settleTo: string;
  settleAmount: string;
};

/**
 * The query parameters for a payment request deep link. Amounts are rounded to
 * cents so a link reads `12.5`, not a long floating-point tail.
 */
export function paymentRequestParams(transfer: Transfer): PaymentRequestParams {
  return {
    settleFrom: transfer.from,
    settleTo: transfer.to,
    settleAmount: String(Number(transfer.amount.toFixed(2))),
  };
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Reads a payment request from route params. Anything malformed (a missing
 * person, the same person twice, a non-positive amount) is ignored, so an
 * edited link cannot prefill a broken payment.
 */
export function parsePaymentRequest(params: {
  settleFrom?: string | string[];
  settleTo?: string | string[];
  settleAmount?: string | string[];
}): Transfer | undefined {
  const from = single(params.settleFrom);
  const to = single(params.settleTo);
  const amountText = single(params.settleAmount);
  if (!from || !to || from === to || !amountText) return undefined;
  const amount = Number(amountText);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return { from, to, amount };
}
