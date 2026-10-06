import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const billingMocks = vi.hoisted(() => ({
	settleBillingUsage: vi.fn(),
	recordBillingProviderUsage: vi.fn(),
	recordBillingUsageQuarantines: vi.fn(),
	claimStripeMeterOutbox: vi.fn(),
	markStripeMeterOutboxFailed: vi.fn(),
	markStripeMeterOutboxSent: vi.fn(),
	getStripe: vi.fn(),
	sendOpsAlert: vi.fn(),
}));

vi.mock("@tedix/db/queries/billing/meter-outbox", () => ({
	claimStripeMeterOutbox: billingMocks.claimStripeMeterOutbox,
	markStripeMeterOutboxFailed: billingMocks.markStripeMeterOutboxFailed,
	markStripeMeterOutboxSent: billingMocks.markStripeMeterOutboxSent,
	STRIPE_METER_OUTBOX_MAX_ATTEMPTS: 20,
}));
vi.mock("../lib/stripe", () => ({ getStripe: billingMocks.getStripe }));
vi.mock("../lib/ops-alert-egress", () => ({
	sendOpsAlert: billingMocks.sendOpsAlert,
}));
vi.mock("@tedix/db/queries/billing/provider-usage", () => ({
	recordBillingProviderUsage: billingMocks.recordBillingProviderUsage,
	recordBillingUsageQuarantines: billingMocks.recordBillingUsageQuarantines,
}));
vi.mock("@tedix/db/queries/billing/settlement", () => ({
	settleBillingUsage: billingMocks.settleBillingUsage,
}));

import {
	drainStripeMeterOutbox,
	quarantineLegacyGatewayCosts,
	settleUnbilledGatewayCosts,
} from "./billing-metering";

describe("drainStripeMeterOutbox", () => {
	it("pages operators when a Stripe meter row dead-letters", async () => {
		billingMocks.claimStripeMeterOutbox.mockResolvedValue([
			{
				id: "outbox-dead",
				eventName: "tedix_tokens",
				idempotencyKey: "meter-key",
				stripeCustomerId: "customer-hidden",
				quantity: 10,
				attemptCount: 19,
			},
		]);
		billingMocks.getStripe.mockResolvedValue({
			billing: {
				meterEvents: {
					create: vi.fn().mockRejectedValue(new Error("provider detail")),
				},
			},
		});
		billingMocks.sendOpsAlert.mockResolvedValue({
			emailed: true,
			webhookPosted: false,
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			drainStripeMeterOutbox({} as never, "sk_test", "test", {
				HEALTH_ALERT_EMAIL: "ops@example.com",
			} as CloudflareEnv),
		).resolves.toEqual({ claimed: 1, sent: 0, failed: 1 });
		expect(billingMocks.markStripeMeterOutboxFailed).toHaveBeenCalledOnce();
		expect(billingMocks.sendOpsAlert).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				subject: expect.stringContaining("dead-lettered"),
				text: expect.not.stringContaining("customer-hidden"),
			}),
		);
		error.mockRestore();
	});
});

function call(gatewayLogId: string, billingReservationId: string | null) {
	return {
		gatewayLogId,
		costBasis: "governed_estimate",
		rateVersionId: "rate",
		executionId: "execution",
		rawReportedCostUsd: null,
		costReason: null,
		gatewayId: "tedix-llm-production",
		snapshotAt: "2026-07-27T12:00:00.000Z",
		orgId: "org-1",
		tediId: null,
		billingReservationId,
		provider: "azure-openai",
		providerResource: "tedix-resource",
		deployment: "gpt-5.6-terra",
		model: "gpt-5.6-terra",
		source: "cron:test",
		sessionType: "tedi",
		inputTokens: 100,
		outputTokens: 10,
		totalTokens: 110,
		estimatedCostUsd: 0.001,
		dataQuality: "ok",
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		runId: null,
		workItemId: null,
		success: true,
	};
}

function fakeDb(
	...queryResults: Array<Array<{ call: ReturnType<typeof call> }>>
) {
	let selectCount = 0;
	return {
		select: () => {
			const rows = queryResults[selectCount++] ?? [];
			const builder = {
				from: () => builder,
				leftJoin: () => builder,
				where: () => builder,
				orderBy: () => builder,
				limit: async () => rows,
			};
			return builder;
		},
	};
}

describe("settleUnbilledGatewayCosts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		billingMocks.recordBillingUsageQuarantines.mockImplementation(
			async (_db, rows: unknown[]) => rows.length,
		);
	});

	it("prioritizes reserved usage, quarantines deterministic rows, and aggregates transient logs", async () => {
		const current = [
			{ call: call("gateway-ok", "reservation-ok") },
			{ call: call("gateway-invalid", "reservation-missing") },
			{ call: call("gateway-transient-1", "reservation-transient-1") },
			{ call: call("gateway-transient-2", "reservation-transient-2") },
		];
		billingMocks.settleBillingUsage
			.mockResolvedValueOnce({ id: "charge-ok" })
			.mockRejectedValueOnce(
				new Error("Billing reservation not found: reservation-missing"),
			)
			.mockRejectedValueOnce(new Error("D1_ERROR: network unavailable"))
			.mockRejectedValueOnce(new Error("D1_ERROR: network unavailable"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await settleUnbilledGatewayCosts(
			fakeDb(current, []) as never,
		);

		expect(result).toEqual({
			settled: 1,
			failed: 2,
			quarantined: 1,
			providerUsageRecorded: 0,
			remainingAtLeast: 0,
			errorSummaries: [
				{ signature: "D1_ERROR: network unavailable", count: 2 },
			],
		});
		expect(billingMocks.settleBillingUsage).toHaveBeenCalledTimes(4);
		expect(billingMocks.recordBillingUsageQuarantines).toHaveBeenCalledTimes(1);
		expect(
			billingMocks.recordBillingUsageQuarantines.mock.calls[0]?.[1],
		).toEqual([
			expect.objectContaining({
				gatewayLogId: "gateway-invalid",
				reason: "invalid_attribution",
			}),
		]);
		expect(error).toHaveBeenCalledTimes(1);
		expect(String(error.mock.calls[0]?.[0])).toContain(
			'"signal":"billing.settlement.failed"',
		);
		error.mockRestore();
	});

	it("records provider-specific units without sending them through token settlement", async () => {
		const providerCall = {
			...call("gateway-voice", null),
			model: "@cf/deepgram/aura-1",
			provider: "workers-ai",
			usageKind: "voice_tts",
			usageUnit: "characters",
			usageQuantity: 42,
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
		};
		billingMocks.recordBillingProviderUsage.mockResolvedValue({
			id: "provider-usage-1",
		});

		const result = await settleUnbilledGatewayCosts(
			fakeDb([], [{ call: providerCall }]) as never,
		);

		expect(result.providerUsageRecorded).toBe(1);
		expect(billingMocks.settleBillingUsage).not.toHaveBeenCalled();
		expect(billingMocks.recordBillingProviderUsage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				gatewayLogId: "gateway-voice",
				usageKind: "voice_tts",
				unit: "characters",
				quantity: 42,
			}),
		);
	});
});

describe("quarantineLegacyGatewayCosts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		billingMocks.recordBillingUsageQuarantines.mockImplementation(
			async (_db, rows: unknown[]) => rows.length,
		);
	});

	it("classifies a bounded legacy batch outside fresh settlement", async () => {
		const legacy = [
			{ call: call("gateway-legacy-1", null) },
			{ call: call("gateway-legacy-2", null) },
		];

		const result = await quarantineLegacyGatewayCosts(
			fakeDb(legacy) as never,
			2,
		);

		expect(result).toEqual({
			selected: 2,
			quarantined: 2,
			remainingAtLeast: 1,
		});
		expect(billingMocks.settleBillingUsage).not.toHaveBeenCalled();
		expect(billingMocks.recordBillingUsageQuarantines).toHaveBeenCalledWith(
			expect.anything(),
			[
				expect.objectContaining({
					gatewayLogId: "gateway-legacy-1",
					reason: "missing_reservation",
				}),
				expect.objectContaining({
					gatewayLogId: "gateway-legacy-2",
					reason: "missing_reservation",
				}),
			],
		);
	});
});

describe("unpriced gateway settlement holds", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		billingMocks.recordBillingUsageQuarantines.mockImplementation(
			async (_db, rows: unknown[]) => rows.length,
		);
	});
	const units = {
		usageKind: "voice_tts",
		usageUnit: "characters",
		usageQuantity: 42,
	};
	it.each([false, true])(
		"holds unsafe observations before writing (provider units=%s)",
		async (providerUnits) => {
			const unsafe = [
				{ dataQuality: "quarantined_no_pricing", estimatedCostUsd: 0 },
				{ dataQuality: "quarantined_failed", estimatedCostUsd: 1 },
				{ estimatedCostUsd: -1 },
				{ estimatedCostUsd: Number.NaN },
				{ estimatedCostUsd: Number.POSITIVE_INFINITY },
				{ estimatedCostUsd: Number.MAX_VALUE },
				{ estimatedCostUsd: null },
				{ estimatedCostUsd: "0" },
				{
					model: "unknown-model",
					costBasis: "unknown",
					rateVersionId: null,
					provider: "azure-openai",
					estimatedCostUsd: 0,
				},
			].map((overrides, i) => ({
				call: {
					...call(`held-${i}`, "reservation-held"),
					...(providerUnits ? units : {}),
					...overrides,
				},
			}));
			const valid = {
				call: {
					...call("valid-zero", "reservation-valid"),
					provider: "workers-ai",
					estimatedCostUsd: 0,
					...(providerUnits ? units : {}),
				},
			};
			const db = providerUnits
				? fakeDb([], [...unsafe, valid] as never)
				: fakeDb([...unsafe, valid] as never, []);
			const result = await settleUnbilledGatewayCosts(db as never);
			expect(result.quarantined).toBe(unsafe.length);
			expect(result.failed).toBe(0);
			const writer = providerUnits
				? billingMocks.recordBillingProviderUsage
				: billingMocks.settleBillingUsage;
			const other = providerUnits
				? billingMocks.settleBillingUsage
				: billingMocks.recordBillingProviderUsage;
			expect(writer).toHaveBeenCalledExactlyOnceWith(
				expect.anything(),
				expect.objectContaining({
					gatewayLogId: "valid-zero",
					providerCostMicros: 0,
				}),
			);
			expect(other).not.toHaveBeenCalled();
			for (const [, rows] of billingMocks.recordBillingUsageQuarantines.mock
				.calls) {
				expect(rows[0]).toMatchObject({
					reason: "unpriced_usage",
					metadata: { billingReservationId: "reservation-held" },
				});
			}
		},
	);
	it("holds unsupported provider units even when a token model has a price", async () => {
		const result = await settleUnbilledGatewayCosts(
			fakeDb([], [{ call: { ...call("units", null), ...units } }]) as never,
		);
		expect(result.quarantined).toBe(1);
		expect(billingMocks.recordBillingProviderUsage).not.toHaveBeenCalled();
	});
	it.each([false, true])(
		"retries a failed durable hold without unsafe writes (provider units=%s)",
		async (providerUnits) => {
			billingMocks.recordBillingUsageQuarantines.mockRejectedValueOnce(
				new Error("D1_ERROR: unavailable"),
			);
			const held = {
				call: {
					...call("held", "reservation-held"),
					dataQuality: "quarantined_no_pricing",
					...(providerUnits ? units : {}),
				},
			};
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				const first = await settleUnbilledGatewayCosts(
					(providerUnits ? fakeDb([], [held]) : fakeDb([held], [])) as never,
				);
				expect(first).toMatchObject({
					failed: 1,
					quarantined: 0,
					settled: 0,
					providerUsageRecorded: 0,
				});
				const retry = await settleUnbilledGatewayCosts(
					(providerUnits ? fakeDb([], [held]) : fakeDb([held], [])) as never,
				);
				expect(retry).toMatchObject({ failed: 0, quarantined: 1 });
				expect(billingMocks.settleBillingUsage).not.toHaveBeenCalled();
				expect(billingMocks.recordBillingProviderUsage).not.toHaveBeenCalled();
			} finally {
				error.mockRestore();
			}
		},
	);
	it("preserves a known token model's legitimate zero", async () => {
		const result = await settleUnbilledGatewayCosts(
			fakeDb(
				[
					{
						call: {
							...call("known-zero", "reservation"),
							estimatedCostUsd: 0,
							inputTokens: 0,
							outputTokens: 0,
							totalTokens: 0,
						},
					},
				],
				[],
			) as never,
		);
		expect(result.settled).toBe(1);
		expect(billingMocks.recordBillingUsageQuarantines).not.toHaveBeenCalled();
	});
});

it.each([
	"provider-response:kernel:context-ranking",
	"provider-response:kernel:action-selection",
])("settles %s with original provider provenance", async (source) => {
	vi.clearAllMocks();
	const usage = {
		...call("jev-execution:exec-1", "reservation-1"),
		provider: "typesafe",
		model: "jev-1.13.0",
		source,
		sessionType: "kernel",
		executionId: "exec-1",
		costBasis: "governed_estimate",
		rateVersionId: "rate-1",
	};
	billingMocks.settleBillingUsage.mockResolvedValue({ id: "charge-1" });
	await settleUnbilledGatewayCosts(fakeDb([{ call: usage }], []) as never);
	expect(billingMocks.settleBillingUsage).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			reservationId: "reservation-1",
			gatewayLogId: "jev-execution:exec-1",
			provider: "typesafe",
			source: "kernel",
			inputTokens: 100,
			outputTokens: 10,
			usageQuality: "provider_reported",
			providerCostQuality: "estimated",
			rateCardVersion: "rate-1",
		}),
	);
});

it.each([
	["provider-response:runtime:skill-ranking", "tedi"],
	["provider-response:system:tool-output-quality", "unattributed"],
	["provider-response:catalog:category", "unattributed"],
	["provider-response:memory:graph-link", "unattributed"],
	["provider-response:memory:graph-link", "tedi"],
])(
	"settles %s with original provider provenance",
	async (source, sessionType) => {
		vi.clearAllMocks();
		const usage = {
			...call("jev-execution:exec-1", "reservation-1"),
			provider: "typesafe",
			model: "jev-1.13.0",
			source,
			sessionType,
			executionId: "exec-1",
			costBasis: "governed_estimate",
			rateVersionId: "rate-1",
		};
		billingMocks.settleBillingUsage.mockResolvedValue({ id: "charge-1" });
		await settleUnbilledGatewayCosts(fakeDb([{ call: usage }], []) as never);
		expect(billingMocks.settleBillingUsage).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				reservationId: "reservation-1",
				gatewayLogId: "jev-execution:exec-1",
				provider: "typesafe",
				source: "system",
				inputTokens: 100,
				outputTokens: 10,
				usageQuality: "provider_reported",
				providerCostQuality: "estimated",
				rateCardVersion: "rate-1",
			}),
		);
	},
);
