import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
	codeModeInputSchema,
	hasPaymentProof,
	isFinancialBillingTool,
} from "./connect-payment-policy";
import type { AppTool } from "./server-context";

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
	it.each([
		"billing/createCheckout",
		"billing.createInferenceCapacityCheckout",
		"billing/grantCredit",
		"billing/setOverageSettings",
		"billing/configureCreditBilling",
	])(
		"blocks the configured financial target despite arbitrary tool aliases: %s",
		(endpoint) => {
			expect(
				isFinancialBillingTool({
					toolId: "innocent_alias",
					config: { endpoint },
				} as unknown as AppTool),
			).toBe(true);
		},
	);
	it("preserves billing reads and unrelated writes", () => {
		for (const endpoint of [
			"billing/getOverview",
			"billing/getInferenceSpending",
			"work/update",
		])
			expect(
				isFinancialBillingTool({ config: { endpoint } } as unknown as AppTool),
			).toBe(false);
	});
});
