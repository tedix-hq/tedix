import { z } from "zod";
import type { AppTool } from "./server-context";

// The directory plugins share Connect and use host-created OAuth clients. The
// resolved app, unlike client names or User-Agent headers, is server-owned.
export function isNonPayingConnection(appSlug: string): boolean {
	return appSlug === "connect";
}

export const CONNECT_PAYMENT_DENIED =
	"Payments and financial operations are unavailable through this connection.";

export function codeModeInputSchema(appSlug: string) {
	return z.strictObject({
		code: z.string().describe("JavaScript async arrow function."),
		...(isNonPayingConnection(appSlug)
			? {}
			: {
					payment: z
						.union([z.string().min(1), z.record(z.string(), z.unknown())])
						.optional()
						.describe(
							'Optional x402 payment proof for paid inner tools, forwarded as _meta["x402/payment"].',
						),
				}),
		agentSessionId: z
			.uuid()
			.optional()
			.describe(
				"Optional verified owner-host Agent-Session id for Work admission. Ignored for machine credentials.",
			),
	});
}

export function hasPaymentProof(
	payment: unknown,
	meta?: Record<string, unknown>,
): boolean {
	return payment !== undefined || Object.hasOwn(meta ?? {}, "x402/payment");
}

// Fail closed for newly added financial endpoints. These operations only read
// billing state; a caller cannot turn an unknown billing mutation into a read
// by renaming its public tool alias.
const billingReadMethods = new Set([
	"getInferenceSpending",
	"listHistoricalExposures",
	"listProviderModelRates",
	"listProviderCapacitySponsorships",
	"listPlans",
	"getOverview",
	"getOverageSettings",
]);

export function isFinancialBillingTool(tool: AppTool): boolean {
	const endpoint = tool.config?.endpoint;
	if (typeof endpoint !== "string") return false;
	if (tool.config?.transport === "rest" && tool.config?.method === "GET")
		return false;
	const parts = endpoint.replaceAll(".", "/").split("/").filter(Boolean);
	const billing = parts.indexOf("billing");
	return billing >= 0 && !billingReadMethods.has(parts[billing + 1] ?? "");
}
