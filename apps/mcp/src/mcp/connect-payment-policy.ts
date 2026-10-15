import { z } from "zod";

// The directory plugins share Connect and use host-created OAuth clients. The
// resolved app, unlike client names or User-Agent headers, is server-owned.
export function isNonPayingConnection(appSlug: string): boolean {
	return appSlug === "connect";
}

export const CONNECT_PAYMENT_DENIED =
	"Payment proofs, paid tools and money-moving operations are unavailable through this connection.";

export function codeModeInputSchema(appSlug: string, chatgpt = false) {
	return z.strictObject({
		code: z.string().describe("JavaScript async arrow function."),
		...(chatgpt || isNonPayingConnection(appSlug)
			? {}
			: {
					payment: z
						.union([z.string().min(1), z.record(z.string(), z.unknown())])
						.optional()
						.describe(
							'Optional x402 payment proof for paid inner tools, forwarded as _meta["x402/payment"].',
						),
				}),
		...(chatgpt
			? {}
			: {
					agentSessionId: z
						.uuid()
						.optional()
						.describe(
							"Optional verified owner-host Agent-Session id for Work admission. Ignored for machine credentials.",
						),
				}),
	});
}

export function hasPaymentProof(
	payment: unknown,
	meta?: Record<string, unknown>,
): boolean {
	return payment !== undefined || Object.hasOwn(meta ?? {}, "x402/payment");
}
