import {
	TEDIX_PAYMENT_REQUIRED_META_KEY,
	X402_PAYMENT_ERROR_META_KEY,
	X402_PAYMENT_META_KEY,
} from "@tedix/mcp-shared/payment";
import { PaymentRequiredV2Schema } from "@x402/core/schemas";
import { describe, expect, it } from "vite-plus/test";
import { checkToolPayment, getToolPaymentPolicy } from "./payments";
import type { AppTool, ServerContext } from "./server-context";

const ORG_ID = "0f0f0f0f-0000-4000-8000-000000000001";

function paidTool(payment: Record<string, unknown>): AppTool {
	return {
		id: "a0e5cef4-ae8d-4451-9ef8-056241c57aea",
		toolId: "premium_research_brief",
		config: {
			transport: "rpc",
			endpoint: "payments/demoPaidTool",
			"x-tedix/payment": payment,
		},
		meta: null,
	} as unknown as AppTool;
}

function basePayment(
	budget?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		enabled: true,
		protocol: "x402",
		mode: "mock",
		amount: "0.01",
		currency: "USDC",
		network: "solana-devnet",
		recipient: "TedixPayMeshDemo111111111111111111111111111",
		...(budget ? { budget } : {}),
	};
}

function agentWithoutDb(): ServerContext {
	return {
		env: {},
		appId: "07ed3daf-ce65-480d-846a-9e93e5843461",
		appSlug: "paymesh-demo",
		app: { organizationId: ORG_ID },
		callerIdentity: undefined,
	} as unknown as ServerContext;
}

/**
 * A bound D1 that throws on every access, standing in for a transient D1
 * outage during policy resolution. The binding exists — that is the point:
 * `budget_store_unavailable` already covers a missing binding, and the gap was
 * a binding that is present but failing.
 */
function agentWithFailingDb(): ServerContext {
	const boom = () => {
		throw new Error("D1_ERROR: Network connection lost");
	};
	return {
		env: {
			DB: {
				prepare: boom,
				batch: boom,
				exec: boom,
				dump: boom,
				withSession: boom,
			},
		},
		appId: "07ed3daf-ce65-480d-846a-9e93e5843461",
		appSlug: "paymesh-demo",
		app: { organizationId: ORG_ID },
		callerIdentity: undefined,
	} as unknown as ServerContext;
}

async function validMockProofFor(
	agent: ServerContext,
	tool: AppTool,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	// Mirror buildRequirementId: first obtain the requirementId from the
	// payment-required handshake, then present the matching mock proof.
	const handshake = await checkToolPayment({ agent, tool, args });
	if (handshake.paid) throw new Error("expected payment-required handshake");
	const meta = (handshake.result as { _meta?: Record<string, unknown> })._meta;
	const required = meta?.[TEDIX_PAYMENT_REQUIRED_META_KEY] as
		| { requirementId?: string }
		| undefined;
	if (!required?.requirementId) {
		throw new Error(
			`handshake did not expose a requirementId: ${JSON.stringify(meta)}`,
		);
	}
	return { mockPaid: true, requirementId: required.requirementId };
}

describe("getToolPaymentPolicy budget parsing", () => {
	it("preserves a configured-but-disabled budget as paused", () => {
		const policy = getToolPaymentPolicy(
			paidTool(
				basePayment({
					enabled: false,
					maxAmount: "1",
					windowSeconds: 3600,
					scope: "organization",
					mode: "enforce",
				}),
			),
		);
		expect(policy?.budget).toMatchObject({
			enabled: false,
			maxAmount: "1",
			scope: "organization",
			mode: "enforce",
		});
	});

	it("still treats an absent budget as no budget", () => {
		const policy = getToolPaymentPolicy(paidTool(basePayment()));
		expect(policy?.budget).toBeUndefined();
	});
});

describe("checkToolPayment budget gate", () => {
	for (const [name, budget, reason] of [
		[
			"per-transaction cap",
			{ maxTransactionAmount: "0.009999999999999999" },
			"transaction_limit_exceeded",
		],
		[
			"recipient allow list",
			{ allowedRecipients: ["another-recipient"] },
			"recipient_not_allowed",
		],
		[
			"tool allow list",
			{ allowedTools: ["paymesh-demo:another_tool"] },
			"tool_not_allowed",
		],
	] as const) {
		it(`rejects a ${name} violation before issuing a payment challenge`, async () => {
			const outcome = await checkToolPayment({
				agent: agentWithoutDb(),
				tool: paidTool(
					basePayment({
						enabled: true,
						maxAmount: "1",
						windowSeconds: 3600,
						scope: "organization",
						mode: "enforce",
						...budget,
					}),
				),
				args: { topic: name },
			});
			expect(outcome.paid).toBe(false);
			if (outcome.paid) throw new Error("unreachable");
			const meta = (outcome.result as { _meta?: Record<string, unknown> })
				._meta;
			expect(meta?.["x-tedix/paymentRejected"]).toMatchObject({
				reason,
			});
			expect(meta?.[X402_PAYMENT_ERROR_META_KEY]).toBeUndefined();
		});
	}

	it("fails closed on a paused budget even with a valid mock proof", async () => {
		const agent = agentWithoutDb();
		const tool = paidTool(
			basePayment({ enabled: false, maxAmount: "1", scope: "organization" }),
		);
		const args = { topic: "paused" };
		const outcome = await checkToolPayment({
			agent,
			tool,
			args,
			extra: {
				_meta: {
					[X402_PAYMENT_META_KEY]: {
						mockPaid: true,
						requirementId: "tedix-x402-any",
					},
				},
			},
		});
		expect(outcome.paid).toBe(false);
		if (outcome.paid) throw new Error("unreachable");
		const rejected = (outcome.result as { _meta?: Record<string, unknown> })
			._meta?.["x-tedix/paymentRejected"] as { reason?: string } | undefined;
		expect(rejected?.reason).toBe("budget_paused");
	});

	it("fails closed when the budget LOOKUP throws, not just when the binding is missing", async () => {
		// The managed-budget lookup is the only source of a cap for org- and
		// tedi-scoped budgets, so a thrown lookup used to fall through to a
		// policy with no budget — which evaluateBudget treats as allowed. The
		// settlement leg was already fail-closed; this is the load leg.
		const agent = agentWithFailingDb();
		const tool = paidTool(basePayment());
		const outcome = await checkToolPayment({
			agent,
			tool,
			args: { topic: "d1-outage" },
			extra: {
				_meta: {
					[X402_PAYMENT_META_KEY]: {
						mockPaid: true,
						requirementId: "tedix-x402-any",
					},
				},
			},
		});
		expect(outcome.paid).toBe(false);
		if (outcome.paid) throw new Error("unreachable");
		const rejected = (outcome.result as { _meta?: Record<string, unknown> })
			._meta?.["x-tedix/paymentRejected"] as { reason?: string } | undefined;
		expect(rejected?.reason).toBe("budget_load_failed");
	});

	it("still allows a paid tool that legitimately has no budget configured", async () => {
		// Absence must stay distinguishable from failure: an uncapped paid tool
		// is a valid setup where the payment itself is the gate. If this ever
		// starts denying, the load-failure fix has over-reached.
		const agent = agentWithoutDb();
		const tool = paidTool(basePayment());
		const proof = await validMockProofFor(agent, tool, { topic: "uncapped" });
		const outcome = await checkToolPayment({
			agent,
			tool,
			args: { topic: "uncapped" },
			extra: { _meta: { [X402_PAYMENT_META_KEY]: proof } },
		});
		expect(outcome.paid).toBe(true);
	});

	it("fails closed when a budget is enabled but no budget store is bound", async () => {
		const agent = agentWithoutDb();
		const tool = paidTool(
			basePayment({
				enabled: true,
				maxAmount: "1",
				windowSeconds: 3600,
				scope: "organization",
			}),
		);
		const outcome = await checkToolPayment({
			agent,
			tool,
			args: { topic: "no-store" },
		});
		expect(outcome.paid).toBe(false);
		if (outcome.paid) throw new Error("unreachable");
		const rejected = (outcome.result as { _meta?: Record<string, unknown> })
			._meta?.["x-tedix/paymentRejected"] as { reason?: string } | undefined;
		expect(rejected?.reason).toBe("budget_store_unavailable");
	});

	it("gates the payment-required handshake, not only settlement", async () => {
		const agent = agentWithoutDb();
		const tool = paidTool(
			basePayment({ enabled: false, maxAmount: "1", scope: "organization" }),
		);
		const outcome = await checkToolPayment({
			agent,
			tool,
			args: { topic: "handshake" },
		});
		expect(outcome.paid).toBe(false);
		if (outcome.paid) throw new Error("unreachable");
		expect(
			(outcome.result as { _meta?: Record<string, unknown> })._meta?.[
				"x-tedix/paymentRejected"
			],
		).toBeDefined();
	});

	it("keeps settling valid mock proofs when no budget is configured", async () => {
		const agent = agentWithoutDb();
		const tool = paidTool(basePayment());
		const args = { topic: "unbudgeted" };
		const proof = await validMockProofFor(agent, tool, args);
		const outcome = await checkToolPayment({
			agent,
			tool,
			args,
			extra: { _meta: { [X402_PAYMENT_META_KEY]: proof } },
		});
		expect(outcome.paid).toBe(true);
	});

	it("keeps issuing the payment-required handshake when no budget is configured", async () => {
		const agent = agentWithoutDb();
		const tool = paidTool(basePayment());
		const outcome = await checkToolPayment({
			agent,
			tool,
			args: { topic: "handshake-free" },
		});
		expect(outcome.paid).toBe(false);
		if (outcome.paid) throw new Error("unreachable");
		const meta = outcome.result._meta;
		const legacy = meta?.[TEDIX_PAYMENT_REQUIRED_META_KEY] as
			| { requirements?: unknown }
			| undefined;
		const challenge = legacy?.requirements;
		expect(PaymentRequiredV2Schema.safeParse(challenge).success).toBe(true);
		expect(meta?.[X402_PAYMENT_ERROR_META_KEY]).toEqual(challenge);
	});

	it("rejects mock prices that cannot be represented in v2 atomic units", async () => {
		const outcome = await checkToolPayment({
			agent: agentWithoutDb(),
			tool: paidTool({ ...basePayment(), amount: "0.0000001" }),
			args: { topic: "fractional-micro-unit" },
		});
		expect(outcome.paid).toBe(false);
		if (outcome.paid) throw new Error("unreachable");
		const meta = outcome.result._meta as Record<string, unknown> | undefined;
		expect(meta?.["x-tedix/paymentRejected"]).toMatchObject({
			reason: "payment_requirements_unavailable",
		});
		expect(meta?.[X402_PAYMENT_ERROR_META_KEY]).toBeUndefined();
	});
});
