import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePaymentRequest, paymentRequestParams } from "../paymentLink";

test("payment request params round the amount and survive parsing", () => {
  const params = paymentRequestParams({ from: "b", to: "a", amount: 12.500000001 });
  assert.deepEqual(params, { settleFrom: "b", settleTo: "a", settleAmount: "12.5" });
  assert.deepEqual(parsePaymentRequest(params), { from: "b", to: "a", amount: 12.5 });
});

test("malformed payment links are ignored", () => {
  for (const params of [
    {},
    { settleFrom: "a", settleTo: "b" },
    { settleFrom: "a", settleTo: "b", settleAmount: "0" },
    { settleFrom: "a", settleTo: "b", settleAmount: "-3" },
    { settleFrom: "a", settleTo: "b", settleAmount: "many" },
    { settleFrom: "a", settleTo: "a", settleAmount: "5" },
    { settleFrom: "", settleTo: "b", settleAmount: "5" },
  ]) {
    assert.equal(parsePaymentRequest(params), undefined, JSON.stringify(params));
  }
});
