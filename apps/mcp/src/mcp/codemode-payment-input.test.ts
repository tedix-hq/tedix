import { describe, expect, it } from "vite-plus/test";
import { buildPaymentExtra } from "./codemode";

describe("Code Mode payment input", () => {
	it("forwards encoded facilitator strings through the top-level argument", () => {
		expect(buildPaymentExtra(undefined, "encoded-x402-v2-payment")).toEqual({
			_meta: { "x402/payment": "encoded-x402-v2-payment" },
		});
	});

	it("preserves request metadata over the top-level fallback", () => {
		expect(
			buildPaymentExtra(
				{ _meta: { "x402/payment": "request-payment", host: "codex" } },
				"argument-payment",
			),
		).toEqual({
			_meta: { "x402/payment": "request-payment", host: "codex" },
		});
	});
});
