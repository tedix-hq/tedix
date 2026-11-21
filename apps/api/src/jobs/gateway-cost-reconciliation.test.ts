import type { DbQueryClient } from "@tedix/db/query-client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AiGatewayLogRow } from "./gateway-cost-ingestion";
import {
	buildReconciliationRows,
	normalizeReconciliationKey,
	previousUtcDay,
	reconcileGatewayCostDay,
	runGatewayCostReconciliationTick,
} from "./gateway-cost-reconciliation";

const sumLedgerCostByProviderModel = vi.hoisted(() => vi.fn());
const getGatewayLedgerCharges = vi.hoisted(() => vi.fn());
const replaceGatewayReconciliationDay = vi.hoisted(() => vi.fn());
vi.mock("@tedix/db/queries/billing/gateway-reconciliation", () => ({
	sumLedgerCostByProviderModel,
	getGatewayLedgerCharges,
	replaceGatewayReconciliationDay,
}));
const GATEWAY = "example-llm";
const db = {} as DbQueryClient;
const env = { CF_ACCOUNT_ID: "acct-1", CF_AI_GATEWAY_TOKEN: "tok-1" };
const params = {
	day: "2026-11-18",
	gatewayId: GATEWAY,
	now: "2026-11-19T02:00:00.000Z",
};
function log(
	id: string,
	patch: Partial<AiGatewayLogRow> = {},
): AiGatewayLogRow {
	return {
		id,
		created_at: "2026-11-18T00:00:00.000Z",
		provider: "azure-openai",
		model: "gpt-6.1-sol",
		success: true,
		cached: false,
		cost: 0.30823,
		tokens_in: 151343,
		tokens_out: 428,
		usage_metadata: {
			input_tokens: 151343,
			input_cached_tokens: 12597,
			output_tokens: 428,
		},
		...patch,
	};
}
function response(result: AiGatewayLogRow[], info = {}) {
	return new Response(
		JSON.stringify({ success: true, result, result_info: info }),
	);
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("normalizeReconciliationKey", () => {
	it("puts bare Azure Gateway models and ledger catalog ids on one key", () => {
		expect(normalizeReconciliationKey("azure-openai", "gpt-6.1-sol")).toEqual({
			provider: "azure-openai",
			model: "openai/gpt-6.1-sol",
		});
		expect(
			normalizeReconciliationKey("azure-openai", "openai/gpt-6.1-sol"),
		).toEqual({ provider: "azure-openai", model: "openai/gpt-6.1-sol" });
		expect(normalizeReconciliationKey(" Azure-OpenAI ", "GPT-6-Luna")).toEqual({
			provider: "azure-openai",
			model: "openai/gpt-6-luna",
		});
	});

	it("leaves Workers AI model ids unchanged", () => {
		expect(
			normalizeReconciliationKey("workers-ai", "@cf/moonshotai/kimi-k2.7-code"),
		).toEqual({
			provider: "workers-ai",
			model: "@cf/moonshotai/kimi-k2.7-code",
		});
	});
});

describe("call coverage", () => {
	it("matches cache-heavy Azure usage despite raw cost differences", () => {
		const rows = buildReconciliationRows({
			...params,
			computedAt: params.now,
			ledger: [
				{
					provider: "azure-openai",
					model: "openai/gpt-6.1-sol",
					costMicros: 283030,
					rowCount: 1,
				},
			],
			gateway: [log("charged")],
			charges: [
				{ gatewayLogId: "charged", inputTokens: 151343, outputTokens: 428 },
			],
		});
		expect(rows).toHaveLength(2);
		for (const row of rows)
			expect(row).toMatchObject({
				status: "matched",
				ledgerCostMicros: 283030,
				gatewayCostMicros: 308230,
				coverage: {
					missingCallCount: 0,
					tokenCheckedCallCount: 1,
					tokenMismatchCallCount: 0,
				},
			});
	});
	it("counts actual misses, unknown cost, and per-call token mismatches without cancellation", () => {
		const rows = buildReconciliationRows({
			...params,
			computedAt: params.now,
			ledger: [],
			gateway: [
				log("missing", { cost: 1.1 }),
				log("missing", { cost: 1.1 }),
				log("unpriced", { cost: null }),
				log("mismatch1"),
				log("mismatch2"),
				log("unknown", { tokens_in: null, usage_metadata: null }),
				log("failed", { success: false }),
				log("response-cache", { cached: true }),
			],
			charges: [
				{ gatewayLogId: "mismatch1", inputTokens: 151342, outputTokens: 428 },
				{ gatewayLogId: "mismatch2", inputTokens: 151344, outputTokens: 428 },
				{ gatewayLogId: "unknown", inputTokens: 0, outputTokens: 428 },
			],
		});
		expect(rows.find((r) => r.model === "")).toMatchObject({
			status: "drift",
			coverage: {
				missingCallCount: 2,
				missingCostMicros: 1100000,
				missingUnpricedCallCount: 1,
				tokenCheckedCallCount: 2,
				tokenMismatchCallCount: 2,
				tokenUnknownCallCount: 1,
			},
		});
	});
	it.each([
		{ count: 20, missingCost: 0.012, chargedCost: 1, status: "matched" },
		{ count: 20, missingCost: 1, chargedCost: 0.5, status: "matched" },
		{ count: 20, missingCost: 2, chargedCost: 2, status: "matched" },
		{ count: 20, missingCost: 2, chargedCost: 1, status: "drift" },
		{ count: 19, missingCost: null, chargedCost: 1, status: "drift" },
	])(
		"applies thresholds to $count calls with $missingCost missing and $chargedCost per charged call",
		({ count, missingCost, chargedCost, status }) => {
			const charged = Array.from({ length: count - 1 }, (_, i) =>
				log(`charged-${i}`, { cost: chargedCost }),
			);
			const rows = buildReconciliationRows({
				...params,
				computedAt: params.now,
				ledger: [],
				gateway: [log("missing", { cost: missingCost }), ...charged],
				charges: charged.map(({ id }) => ({
					gatewayLogId: id,
					inputTokens: 151343,
					outputTokens: 428,
				})),
			});
			for (const row of rows)
				expect(row).toMatchObject({
					status,
					coverage: {
						missingCallCount: 1,
						missingCostMicros: (missingCost ?? 0) * 1_000_000,
					},
				});
		},
	);
	it("separates platform overhead from uncharged and charged calls on the same model", () => {
		const rows = buildReconciliationRows({
			...params,
			computedAt: params.now,
			ledger: [],
			charges: [
				{
					gatewayLogId: "charged-clef",
					inputTokens: 151343,
					outputTokens: 428,
				},
			],
			gateway: [
				log("lesson", {
					provider: "workers-ai",
					model: "@cf/example",
					cost: 1.07,
					metadata: { surface: "lane-lesson" },
				}),
				log("customer", {
					provider: "workers-ai",
					model: "@cf/cloudflare/clef-flash",
					cost: 0.02,
				}),
				log("triage", {
					provider: "workers-ai",
					model: "@cf/cloudflare/clef-flash",
					cost: 0.01,
					metadata: { surface: "agent-turn-triage" },
				}),
				log("charged-clef", {
					provider: "workers-ai",
					model: "@cf/cloudflare/clef-flash",
					metadata: { surface: "agent-turn-triage" },
				}),
			],
		});
		expect(rows.find((r) => r.model === "")).toMatchObject({
			coverage: {
				missingCallCount: 1,
				missingCostMicros: 20000,
				platformOverheadCallCount: 2,
				platformOverheadCostMicros: 1080000,
				tokenCheckedCallCount: 1,
			},
		});
		const overhead = buildReconciliationRows({
			...params,
			computedAt: params.now,
			ledger: [],
			charges: [],
			gateway: [
				log("lesson", {
					provider: "workers-ai",
					metadata: { surface: "lane-lesson" },
				}),
			],
		});
		expect(overhead.every((r) => r.status === "matched")).toBe(true);
	});
});

describe("reconcileGatewayCostDay", () => {
	it("reads every page including midnight and matches charges before replacing the day", async () => {
		const first = Array.from({ length: 50 }, (_, i) => log(`log-${i}`));
		const last = log("last", { created_at: "2026-11-18T23:59:59.999Z" });
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response(first, { total_count: 51 }))
			.mockResolvedValueOnce(response([last], { total_count: 51 }));
		vi.stubGlobal("fetch", fetchMock);
		sumLedgerCostByProviderModel.mockResolvedValue([]);
		getGatewayLedgerCharges.mockResolvedValue([]);
		const result = await reconcileGatewayCostDay(db, env, params);
		expect(result.gatewayLogs).toBe(51);
		const url = new URL(fetchMock.mock.calls[0]![0]);
		expect(JSON.parse(url.searchParams.get("filters")!)).toEqual([
			{
				key: "created_at",
				operator: "gt",
				value: ["2026-11-17T23:59:59.999Z"],
			},
			{
				key: "created_at",
				operator: "lt",
				value: ["2026-11-19T00:00:00.000Z"],
			},
		]);
		expect(new URL(fetchMock.mock.calls[1]![0]).searchParams.get("page")).toBe(
			"2",
		);
		expect(getGatewayLedgerCharges).toHaveBeenCalledWith(db, {
			gatewayId: GATEWAY,
			gatewayLogIds: [...first, last].map((r) => r.id),
		});
		expect(replaceGatewayReconciliationDay).toHaveBeenCalledWith(db, {
			day: params.day,
			gatewayId: GATEWAY,
			rows: result.rows,
		});
	});
	it("preserves the previous row when a later page fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					response(Array.from({ length: 50 }, (_, i) => log(String(i)))),
				)
				.mockResolvedValueOnce(new Response("denied", { status: 403 })),
		);
		await expect(reconcileGatewayCostDay(db, env, params)).rejects.toThrow(
			"HTTP 403",
		);
		expect(replaceGatewayReconciliationDay).not.toHaveBeenCalled();
	});
	it.each([
		{ success: false, result: [] },
		{ success: true, result: [], result_info: { truncated: true } },
		{ success: true, result: [log("one")], result_info: { total_count: 2 } },
		{
			success: true,
			result: [log("tomorrow", { created_at: "2026-11-19T00:00:00Z" })],
		},
	])(
		"does not persist incomplete or out-of-day responses: %j",
		async (body) => {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(new Response(JSON.stringify(body))),
			);
			await expect(reconcileGatewayCostDay(db, env, params)).rejects.toThrow();
			expect(replaceGatewayReconciliationDay).not.toHaveBeenCalled();
		},
	);
});

describe("runGatewayCostReconciliationTick", () => {
	it("reconciles the previous UTC day", () => {
		expect(previousUtcDay(Date.parse("2026-11-19T02:00:00.000Z"))).toBe(
			"2026-11-18",
		);
		expect(previousUtcDay(Date.parse("2026-03-01T02:00:00.000Z"))).toBe(
			"2026-02-28",
		);
	});

	it("does nothing outside managed billing settlement", async () => {
		await expect(
			runGatewayCostReconciliationTick(
				{ TEDIX_BILLING_SETTLEMENT_MODE: "external" },
				Date.parse("2026-11-19T02:00:00.000Z"),
			),
		).resolves.toEqual({});
	});

	it("names missing Cloudflare configuration", async () => {
		await expect(
			runGatewayCostReconciliationTick(
				{ TEDIX_BILLING_SETTLEMENT_MODE: "managed", CF_ACCOUNT_ID: "acct-1" },
				Date.parse("2026-11-19T02:00:00.000Z"),
			),
		).rejects.toThrow("CF_AI_GATEWAY_TOKEN, AI_GATEWAY_LLM_ID");
	});
});
