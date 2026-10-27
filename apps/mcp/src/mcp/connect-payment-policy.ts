import { z } from "zod";

// The directory plugins share Connect and use host-created OAuth clients. The
// resolved app, unlike client names or User-Agent headers, is server-owned.
export function isNonPayingConnection(appSlug: string): boolean {
	return appSlug === "connect";
}

export const CONNECT_PAYMENT_DENIED =
	"Payment proofs, paid tools and money-moving operations are unavailable through this connection.";

/**
 * The envelope every Code Mode result carries. `result` is whatever the
 * program returned, so only the surrounding fields are described.
 */
export const codeModeOutputSchema = z.looseObject({
	executionId: z.string().optional().describe("Identifier of this run."),
	result: z
		.unknown()
		.optional()
		.describe("The JSON value the function returned."),
	completionEvidence: z
		.record(z.string(), z.unknown())
		.optional()
		.describe("What the calls actually did; claim only its supportedClaims."),
	partial: z
		.boolean()
		.optional()
		.describe("True when some inner tool calls failed."),
	failures: z
		.array(z.unknown())
		.optional()
		.describe("Inner tool calls that failed."),
	error: z.string().optional().describe("Why the run failed."),
});

export function codeModeInputSchema(appSlug: string) {
	return z.strictObject({
		code: z
			.string()
			.describe(
				'One async arrow function, for example `async () => { const { results } = await discover.search({ query: "work items" }); return results; }`. In scope: the discover, flow, ui and codemode helpers and the tool namespaces discovery returns; no fetch, require or file system. Its return value must be JSON-serializable and becomes `result`.',
			),
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
				"session.id returned by start_external_agent_session_for_host in this conversation; pass it on every call so audit names the agent. Never invent one. Ignored for machine credentials.",
			),
	});
}

export function hasPaymentProof(
	payment: unknown,
	meta?: Record<string, unknown>,
): boolean {
	return payment !== undefined || Object.hasOwn(meta ?? {}, "x402/payment");
}
