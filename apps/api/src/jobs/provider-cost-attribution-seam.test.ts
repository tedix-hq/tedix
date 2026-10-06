import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { callWorkersAi } from "@tedix/workers-ai/transport";
import { providerDeploymentScope } from "@tedix/api-contract/schemas/provider-execution";
import type { ProviderExecutionAttemptRow } from "@tedix/db/schema/provider-executions";
import type { TediCallCost } from "@tedix/db/schema/tedis";
import { kernelWorkersAiClient } from "../rpc/routers/kernel/workers-ai-client";
import {
	matchesGatewayExecution,
	mapRowToCallCost,
} from "./gateway-cost-ingestion";
import { settleUnbilledGatewayCosts } from "./billing-metering";

const mocks = vi.hoisted(() => ({
	authorize: vi.fn(),
	pending: vi.fn(),
	units: vi.fn(),
	settle: vi.fn(),
	quarantine: vi.fn(),
	providerUsage: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("../services/runtime-entitlement-admission", () => ({
	authorizeRuntimeInference: mocks.authorize,
}));
vi.mock("@tedix/db/queries/platform-job-storage", () => ({
	listUnsettledBillableGatewayCalls: mocks.pending,
	listUnrecordedProviderUsageCalls: mocks.units,
}));
vi.mock("@tedix/db/queries/billing/settlement", () => ({
	settleBillingUsage: mocks.settle,
}));
vi.mock("@tedix/db/queries/billing/provider-usage", () => ({
	recordBillingUsageQuarantines: mocks.quarantine,
	recordBillingProviderUsage: mocks.providerUsage,
}));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.units.mockResolvedValue([]);
	mocks.settle.mockResolvedValue({});
	mocks.quarantine.mockResolvedValue(1);
});

/** Real transport/encoder/mapper/settlement orchestration; provider and D1 boundaries are scripted. */
async function observe(
	mode: "managed" | "external" | "disabled",
	cost: number | undefined,
) {
	let receipt!: ProviderExecutionAttemptRow;
	let captured!: Record<string, string>;
	mocks.authorize.mockImplementation(async ({ request }) => {
		const now = new Date().toISOString();
		receipt = {
			...request.execution,
			id: crypto.randomUUID(),
			organizationId: request.organizationId,
			tediId: request.tediId,
			source: request.source,
			runId: request.runId,
			workItemId: request.workItemId,
			traceId: request.traceId ?? null,
			idempotencyKey: request.idempotencyKey,
			settlementMode: mode,
			billingReservationId: mode === "managed" ? "issued-reservation" : null,
			authorizedAt: now,
			sendBefore: new Date(Date.now() + 600000).toISOString(),
			deploymentScope: providerDeploymentScope(request.execution),
		};
		return {
			allowed: true,
			settlementMode: mode,
			attributionVersion: 3,
			executionId: receipt.id,
			sendBefore: receipt.sendBefore,
			reservationId: receipt.billingReservationId,
			expiresAt: mode === "managed" ? receipt.sendBefore : null,
			estimatedChargeMicros: mode === "managed" ? 1 : null,
		};
	});
	const run = vi.fn(async (_model, _body, options) => {
		captured = options.gateway.metadata;
		return { response: "offline response" };
	});
	const env = {
		DB: {} as D1Database,
		TEDIX_BILLING_SETTLEMENT_MODE: mode,
		AI_GATEWAY_ACCOUNT_ID: "account",
		AI_GATEWAY_LLM_ID: "tedix-llm-production",
		AI: { run } as unknown as Ai,
	};
	await callWorkersAi(
		kernelWorkersAiClient(env, {
			organizationId: "org",
			runId: "run",
			workItemId: "work",
			executionId: "forged",
			billingReservationId: "forged-reservation",
		}),
		"@cf/test",
		{ messages: [{ role: "user", content: "offline fixture" }] },
	);
	expect(run).toHaveBeenCalledOnce();
	expect(receipt.transportKind).toBe("workers-ai-binding");
	const log = {
		id: crypto.randomUUID(),
		created_at: new Date().toISOString(),
		provider: "workers-ai",
		model: "@cf/test",
		success: true,
		cached: false,
		cost,
		tokens_in: 10,
		tokens_out: 2,
		metadata: captured,
	};
	return { receipt, log };
}
async function settleMapped(mapped: ReturnType<typeof mapRowToCallCost>) {
	// Mock the canonical pending query at its documented reserved/attributed boundary.
	// The real settlement orchestration still evaluates quality and amount.
	mocks.pending.mockResolvedValue(
		mapped.orgId && mapped.billingReservationId ? [mapped as TediCallCost] : [],
	);
	return settleUnbilledGatewayCosts({} as never);
}

describe("issued attribution from forced binding to settlement", () => {
	it.each([0, 0.000123])(
		"preserves issued identity and provider amount %s",
		async (cost) => {
			const { receipt, log } = await observe("managed", cost);
			expect(
				matchesGatewayExecution(
					log,
					"tedix-llm-production",
					"account",
					receipt,
				),
			).toBe(true);
			const mapped = mapRowToCallCost(log, "tedix-llm-production", {
				execution: receipt,
				costUsd: null,
				rateVersionId: null,
				reason: null,
			});
			expect(mapped).toMatchObject({
				orgId: "org",
				tediId: null,
				runId: "run",
				workItemId: "work",
				billingReservationId: "issued-reservation",
				executionId: receipt.id,
				estimatedCostUsd: cost,
				rawReportedCostUsd: cost,
				costBasis: "gateway_reported",
				dataQuality: "ok",
			});
			expect(await settleMapped(mapped)).toMatchObject({
				settled: 1,
				quarantined: 0,
			});
			expect(mocks.settle).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					organizationId: "org",
					reservationId: "issued-reservation",
					providerCostMicros: Math.round(cost * 1000000),
					metadata: expect.objectContaining({
						runId: "run",
						workItemId: "work",
					}),
				}),
			);
		},
	);
	it("holds a response with no cost evidence instead of settling zero", async () => {
		const { receipt, log } = await observe("managed", undefined);
		const mapped = mapRowToCallCost(log, "tedix-llm-production", {
			execution: receipt,
			costUsd: null,
			rateVersionId: null,
			reason: "missing_rate",
		});
		expect(mapped).toMatchObject({
			estimatedCostUsd: null,
			rawReportedCostUsd: null,
			costBasis: "unknown",
			dataQuality: "quarantined_no_pricing",
		});
		expect(await settleMapped(mapped)).toMatchObject({
			settled: 0,
			quarantined: 1,
		});
		expect(mocks.settle).not.toHaveBeenCalled();
	});
	it.each(["missing", "foreign", "reservation", "org", "model", "account"])(
		"rejects %s evidence without metadata retargeting",
		async (kind) => {
			const { receipt, log } = await observe("managed", 0.01);
			const envelope = JSON.parse(log.metadata.attribution!);
			let candidate: ProviderExecutionAttemptRow | null = receipt;
			if (kind === "missing") candidate = null;
			if (kind === "foreign") envelope.e = crypto.randomUUID();
			if (kind === "reservation") envelope.b = "foreign-reservation";
			if (kind === "org") log.metadata.orgId = "foreign-org";
			if (kind === "model") log.model = "@cf/other";
			log.metadata.attribution = JSON.stringify(envelope);
			const matched = matchesGatewayExecution(
				log,
				"tedix-llm-production",
				kind === "account" ? "foreign-account" : "account",
				candidate,
			);
			expect(matched).toBe(false);
			const mapped = mapRowToCallCost(log, "tedix-llm-production", {
				execution: matched ? candidate : null,
				costUsd: null,
				rateVersionId: null,
				reason: "unverified_execution",
			});
			expect(mapped).toMatchObject({
				orgId: null,
				runId: null,
				workItemId: null,
				executionId: null,
				billingReservationId: null,
			});
			await settleMapped(mapped);
			expect(mocks.settle).not.toHaveBeenCalled();
		},
	);
	it.each(["external", "disabled"] as const)(
		"retains %s observation without a reservation or customer posting",
		async (mode) => {
			const { receipt, log } = await observe(mode, 0);
			expect(
				matchesGatewayExecution(
					log,
					"tedix-llm-production",
					"account",
					receipt,
				),
			).toBe(true);
			expect(JSON.parse(log.metadata.attribution!).b).toBeUndefined();
			const mapped = mapRowToCallCost(log, "tedix-llm-production", {
				execution: receipt,
				costUsd: null,
				rateVersionId: null,
				reason: null,
			});
			expect(mapped).toMatchObject({
				executionId: receipt.id,
				orgId: "org",
				billingReservationId: null,
				estimatedCostUsd: 0,
			});
			await settleMapped(mapped);
			expect(mocks.settle).not.toHaveBeenCalled();
		},
	);
});
