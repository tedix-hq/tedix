import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { codeModeInputSchema, hasPaymentProof } from "./connect-payment-policy";

describe("Connect payment boundary", () => {
	it("hides and rejects the payment argument for every Connect OAuth client", () => {
		const schema = codeModeInputSchema("connect");
		expect(z.toJSONSchema(schema).properties).not.toHaveProperty("payment");
		expect(
			schema.safeParse({ code: "async () => 1", payment: "proof" }).success,
		).toBe(false);
		expect(schema.safeParse({ code: "async () => 1" }).success).toBe(true);
		expect(
			codeModeInputSchema("paid-demo").safeParse({
				code: "async () => 1",
				payment: "proof",
			}).success,
		).toBe(true);
	});
	it("detects metadata proofs including empty or null proofs", () => {
		expect(hasPaymentProof(undefined, { "x402/payment": null })).toBe(true);
		expect(hasPaymentProof(undefined, { "x402/payment": "" })).toBe(true);
		expect(hasPaymentProof(undefined, { host: "claude" })).toBe(false);
	});
});
