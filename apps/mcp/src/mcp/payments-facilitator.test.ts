import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AppTool, ServerContext } from "./server-context";
import {
	buildFacilitatorChallenge,
	clearFacilitatorCacheForTests,
} from "./x402-facilitator";

const ORG_ID = "0f0f0f0f-0000-4000-8000-000000000001";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

const state = vi.hoisted(() => ({
	storedEvent: null as Record<string, unknown> | null,
	recordedEvents: [] as Array<Record<string, unknown>>,
}));

const dbMocks = vi.hoisted(() => ({
	getEffectiveMcpPaymentPolicy: vi.fn(async () => null),
	getMcpPaymentEventByIdForOrg: vi.fn(async () => state.storedEvent),
	insertMcpPaymentEvent: vi.fn(async (_db, event) => {
		state.recordedEvents.push(event as Record<string, unknown>);
		return event;
	}),
	insertSettledMcpPaymentEventWithinBudget: vi.fn(async (_db, event) => {
		state.recordedEvents.push(event as Record<string, unknown>);
		state.storedEvent = event as Record<string, unknown>;
		return true;
	}),
	sumSettledMcpPaymentAmount: vi.fn(async () => 0),
	updateMcpPaymentReservationStatus: vi.fn(async () => null),
	upsertMcpPaymentReservation: vi.fn(async (_db, reservation) => reservation),
}));

vi.mock("@tedix/db/client", () => ({
	createDbClient: () => ({ mocked: true }),
}));
vi.mock("@tedix/db/queries/mcp-payments", () => dbMocks);
vi.mock("@tedix/db/queries/audit", () => ({
	insertAuditEvent: vi.fn(async () => null),
}));
vi.mock("@tedix/db/queries/rationale-records", () => ({
	completeRationaleRecord: vi.fn(async () => null),
	createRationaleRecord: vi.fn(async () => null),
}));
vi.mock("@tedix/db/queries/tools", () => ({
	getToolById: vi.fn(async () => null),
}));

import { checkToolPayment, settleToolPayment } from "./payments";

function facilitatorTool(): AppTool {
	return {
		id: "a0e5cef4-ae8d-4451-9ef8-056241c57aea",
		toolId: "premium_research_brief",
		config: {
			transport: "rpc",
			endpoint: "payments/demoPaidTool",
			"x-tedix/payment": {
				enabled: true,
				protocol: "x402",
				mode: "facilitator",
				amount: "0.01",
				currency: "USDC",
				network: "base-sepolia",
				recipient: RECIPIENT,
				facilitatorUrl: "https://facilitator.example",
				budget: {
					enabled: true,
					maxAmount: "1",
					windowSeconds: 3600,
					scope: "organization",
					mode: "enforce",
				},
			},
		},
		meta: null,
	} as unknown as AppTool;
}

function agent(): ServerContext {
	return {
		env: { DB: { mocked: true } },
		appId: "07ed3daf-ce65-480d-846a-9e93e5843461",
		appSlug: "paymesh-demo",
		app: { organizationId: ORG_ID },
		callerIdentity: undefined,
	} as unknown as ServerContext;
}

async function issuePayment(
	paymentAgent: ServerContext,
	tool: AppTool,
	args: Record<string, unknown>,
): Promise<{ paymentToken: string; challenge: Record<string, unknown> }> {
	const unpaid = await checkToolPayment({ agent: paymentAgent, tool, args });
	expect(unpaid.paid).toBe(false);
	if (unpaid.paid) throw new Error("expected payment challenge");
	const resultMeta = (
		unpaid.result as { _meta: Record<string, Record<string, unknown>> }
	)._meta;
	const paymentMeta = resultMeta["x-tedix/payment-required"]!;
	expect(resultMeta["x402/error"]).toEqual(paymentMeta.requirements);
	const challenge = paymentMeta.requirements as {
		x402Version: number;
		resource: PaymentPayload["resource"];
		accepts: PaymentPayload["accepted"][];
	};
	const paymentPayload: PaymentPayload = {
		x402Version: 2,
		resource: challenge.resource,
		accepted: challenge.accepts[0]!,
		payload: { signature: "0xsigned", authorization: { nonce: "nonce-1" } },
	};
	return {
		challenge,
		paymentToken: encodePaymentSignatureHeader(paymentPayload),
	};
}

describe("x402 facilitator settlement", () => {
	it("offers human budget review only for a durably recorded tedi rejection", async () => {
		dbMocks.sumSettledMcpPaymentAmount.mockResolvedValueOnce(1);
		const buyer = {
			...agent(),
			callerIdentity: { tediId: "00000000-0000-4000-8000-000000000002" },
		} as ServerContext;
		const outcome = await checkToolPayment({
			agent: buyer,
			tool: facilitatorTool(),
			args: { topic: "research" },
		});
		expect(outcome.paid).toBe(false);
		if (outcome.paid) throw new Error("unreachable");
		const rejection = (
			outcome.result._meta as Record<string, unknown> | undefined
		)?.["x-tedix/paymentRejected"] as {
			budgetOverrideRequest?: { rejectedEventId: string };
		};
		expect(rejection.budgetOverrideRequest?.rejectedEventId).toBe(
			state.recordedEvents[0]?.id,
		);
		expect(outcome.result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("mcp.request_budget_override"),
		});
	});

	it("does not offer an event ID when the rejection ledger write fails", async () => {
		dbMocks.sumSettledMcpPaymentAmount.mockResolvedValueOnce(1);
		dbMocks.insertMcpPaymentEvent.mockRejectedValueOnce(
			new Error("D1 unavailable"),
		);
		const buyer = {
			...agent(),
			callerIdentity: { tediId: "00000000-0000-4000-8000-000000000002" },
		} as ServerContext;
		const outcome = await checkToolPayment({
			agent: buyer,
			tool: facilitatorTool(),
			args: { topic: "research" },
		});
		expect(outcome.paid).toBe(false);
		if (outcome.paid) throw new Error("unreachable");
		const rejection = (
			outcome.result._meta as Record<string, unknown> | undefined
		)?.["x-tedix/paymentRejected"] as {
			budgetOverrideRequest?: unknown;
		};
		expect(rejection.budgetOverrideRequest).toBeUndefined();
	});

	beforeEach(() => {
		clearFacilitatorCacheForTests();
		state.storedEvent = null;
		state.recordedEvents.length = 0;
		vi.clearAllMocks();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const request =
					input instanceof Request ? input : new Request(input, init);
				const path = new URL(request.url).pathname;
				if (path.endsWith("/supported")) {
					return Response.json({
						kinds: [
							{
								x402Version: 2,
								scheme: "exact",
								network: "eip155:84532",
							},
						],
						extensions: [],
						signers: {},
					});
				}
				if (path.endsWith("/verify")) {
					return Response.json({ isValid: true, payer: "0x2222" });
				}
				if (path.endsWith("/settle")) {
					return Response.json({
						success: true,
						transaction: "0xsettled",
						network: "eip155:84532",
						payer: "0x2222",
						amount: "10000",
					});
				}
				return Response.json({ error: `unexpected ${path}` }, { status: 404 });
			}),
		);
	});

	it("refreshes a facilitator server after the cache TTL", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-08-19T00:00:00.000Z"));
		const params = {
			facilitatorUrl: "https://facilitator.example",
			network: "base-sepolia",
			recipient: RECIPIENT,
			amount: "0.01",
			maxTimeoutSeconds: 60,
			resource: "https://paymesh-demo.mcp.tedix.dev/mcp",
			description: "cache TTL proof",
			extra: {},
		};

		try {
			await buildFacilitatorChallenge(params);
			await buildFacilitatorChallenge(params);
			expect(
				vi
					.mocked(fetch)
					.mock.calls.filter(([input]) =>
						new URL(
							input instanceof Request ? input.url : String(input),
						).pathname.endsWith("/supported"),
					),
			).toHaveLength(1);

			vi.setSystemTime(new Date("2026-08-19T00:05:00.001Z"));
			await buildFacilitatorChallenge(params);
			expect(
				vi
					.mocked(fetch)
					.mock.calls.filter(([input]) =>
						new URL(
							input instanceof Request ? input.url : String(input),
						).pathname.endsWith("/supported"),
					),
			).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("verifies, settles once, persists a redacted receipt, and replays it idempotently", async () => {
		const paymentAgent = agent();
		const tool = facilitatorTool();
		const args = { topic: "Cloudflare agentic payments" };
		const { challenge, paymentToken } = await issuePayment(
			paymentAgent,
			tool,
			args,
		);
		expect(challenge).toMatchObject({
			x402Version: 2,
			accepts: [
				{
					scheme: "exact",
					network: "eip155:84532",
					amount: "10000",
					payTo: RECIPIENT,
				},
			],
		});

		const verified = await checkToolPayment({
			agent: paymentAgent,
			tool,
			args,
			extra: { _meta: { "x402/payment": paymentToken } },
		});
		expect(verified.paid).toBe(true);
		if (!verified.paid) throw new Error("expected verified payment");
		expect(verified.paymentResponse).toBeUndefined();
		expect(verified.settlement).toBeDefined();

		const settled = await settleToolPayment(paymentAgent, verified.settlement);
		expect(settled).toMatchObject({
			settled: true,
			paymentResponse: {
				mode: "facilitator",
				transaction: "0xsettled",
				settledAmountAtomic: "10000",
				ledger: { table: "mcp_payment_events" },
			},
		});
		const receipt = state.recordedEvents.find(
			(event) => event.status === "settled",
		)!;
		expect(receipt.id).toMatch(/^x402-facilitator-/);
		expect(receipt.paymentProof).toMatchObject({
			format: "payment-signature",
			x402Version: 2,
			paymentPayloadHash: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(JSON.stringify(receipt)).not.toContain(paymentToken);

		const replay = await checkToolPayment({
			agent: paymentAgent,
			tool,
			args,
			extra: { _meta: { "x402/payment": paymentToken } },
		});
		expect(replay).toMatchObject({
			paid: true,
			paymentResponse: { transaction: "0xsettled" },
		});
		const calls = vi
			.mocked(fetch)
			.mock.calls.map(
				([input]) =>
					new URL(input instanceof Request ? input.url : String(input))
						.pathname,
			);
		expect(calls.filter((path) => path.endsWith("/verify"))).toHaveLength(1);
		expect(calls.filter((path) => path.endsWith("/settle"))).toHaveLength(1);
		expect(dbMocks.sumSettledMcpPaymentAmount).toHaveBeenCalledTimes(2);
	});

	it("rejects a facilitator proof that does not match the issued requirement", async () => {
		const paymentAgent = agent();
		const tool = facilitatorTool();
		const args = { topic: "mismatched payment" };
		const { challenge } = await issuePayment(paymentAgent, tool, args);
		const mismatchedPayload: PaymentPayload = {
			x402Version: 2,
			resource: challenge.resource as PaymentPayload["resource"],
			accepted: {
				...(challenge.accepts as PaymentPayload["accepted"][])[0]!,
				amount: "1",
			},
			payload: { signature: "0xwrong", authorization: { nonce: "nonce-2" } },
		};
		const result = await checkToolPayment({
			agent: paymentAgent,
			tool,
			args,
			extra: {
				_meta: {
					"x402/payment": encodePaymentSignatureHeader(mismatchedPayload),
				},
			},
		});

		expect(result.paid).toBe(false);
		expect(
			state.recordedEvents.some(
				(event) =>
					event.status === "rejected" &&
					(event.budgetDecision as Record<string, unknown>)?.reason ===
						"facilitator_verification_failed",
			),
		).toBe(true);
		expect(vi.mocked(fetch)).not.toHaveBeenCalledWith(
			expect.stringContaining("/settle"),
			expect.anything(),
		);
	});

	it("fails closed when the facilitator cannot settle the verified proof", async () => {
		vi.mocked(fetch).mockImplementation(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request =
					input instanceof Request ? input : new Request(input, init);
				const path = new URL(request.url).pathname;
				if (path.endsWith("/supported")) {
					return Response.json({
						kinds: [
							{
								x402Version: 2,
								scheme: "exact",
								network: "eip155:84532",
							},
						],
						extensions: [],
						signers: {},
					});
				}
				if (path.endsWith("/verify")) {
					return Response.json({ isValid: true, payer: "0x2222" });
				}
				if (path.endsWith("/settle")) {
					return Response.json({
						success: false,
						errorReason: "insufficient_funds",
						transaction: "",
						network: "eip155:84532",
						payer: "0x2222",
					});
				}
				return Response.json({ error: `unexpected ${path}` }, { status: 404 });
			},
		);
		const paymentAgent = agent();
		const tool = facilitatorTool();
		const args = { topic: "failed settlement" };
		const { paymentToken } = await issuePayment(paymentAgent, tool, args);
		const verified = await checkToolPayment({
			agent: paymentAgent,
			tool,
			args,
			extra: { _meta: { "x402/payment": paymentToken } },
		});
		expect(verified.paid).toBe(true);
		if (!verified.paid) throw new Error("expected verified payment");

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await settleToolPayment(paymentAgent, verified.settlement);
		const diagnostic = errorSpy.mock.calls
			.map(([entry]) => entry as Record<string, unknown>)
			.find(
				(entry) => entry?.event === "payments.facilitator_settlement_failed",
			);
		errorSpy.mockRestore();
		expect(diagnostic).toMatchObject({
			toolName: "premium_research_brief",
			exception: { message: "Content omitted" },
		});
		expect(JSON.stringify(diagnostic)).not.toContain(paymentToken);
		expect(JSON.stringify(diagnostic)).not.toContain("0xsigned");
		expect(result.settled).toBe(false);
		if (result.settled) throw new Error("expected failed settlement");
		expect(result.result).toMatchObject({
			isError: true,
			_meta: {
				"x-tedix/payment-required": {
					requirements: { x402Version: 2, error: "SETTLEMENT_FAILED" },
				},
			},
		});
		expect(state.storedEvent).toBeNull();
	});

	it("fails closed when the durable receipt cannot be written", async () => {
		dbMocks.insertSettledMcpPaymentEventWithinBudget.mockResolvedValueOnce(
			false,
		);
		const paymentAgent = agent();
		const tool = facilitatorTool();
		const args = { topic: "receipt write failure" };
		const { paymentToken } = await issuePayment(paymentAgent, tool, args);
		const verified = await checkToolPayment({
			agent: paymentAgent,
			tool,
			args,
			extra: { _meta: { "x402/payment": paymentToken } },
		});
		expect(verified.paid).toBe(true);
		if (!verified.paid) throw new Error("expected verified payment");

		const result = await settleToolPayment(paymentAgent, verified.settlement);
		expect(result.settled).toBe(false);
		expect(state.storedEvent).toBeNull();
	});
});
