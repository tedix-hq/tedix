import type { DbQueryClient } from "@tedix/db/query-client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	type GatewayAnalyticsGroup,
	buildReconciliationRows,
	classifyReconciliation,
	normalizeReconciliationKey,
	previousUtcDay,
	reconcileGatewayCostDay,
	runGatewayCostReconciliationTick,
} from "./gateway-cost-reconciliation";

const sumLedgerCostByProviderModel = vi.hoisted(() => vi.fn());
const replaceGatewayReconciliationDay = vi.hoisted(() =>
	vi.fn(() => Promise.resolve()),
);
vi.mock("@tedix/db/queries/billing/gateway-reconciliation", () => ({
	sumLedgerCostByProviderModel,
	replaceGatewayReconciliationDay,
}));

const GATEWAY = "tedix-llm-production";
const db = {} as DbQueryClient;
const env = { CF_ACCOUNT_ID: "acct-1", CF_ANALYTICS_TOKEN: "tok-1" };

function group(
	provider: string,
	model: string,
	cost: number,
	count = 10,
	gateway = GATEWAY,
): GatewayAnalyticsGroup {
	return {
		count,
		sum: { cost, uncachedTokensIn: 1, uncachedTokensOut: 1, cachedTokensIn: 0 },
		dimensions: { provider, model, gateway },
	};
}

function graphqlResponse(groups: GatewayAnalyticsGroup[]) {
	return vi.fn((_url: string, _init?: RequestInit) =>
		Promise.resolve(
			new Response(
				JSON.stringify({
					data: {
						viewer: {
							accounts: [{ aiGatewayRequestsAdaptiveGroups: groups }],
						},
					},
					errors: null,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	sumLedgerCostByProviderModel.mockReset();
	replaceGatewayReconciliationDay.mockClear();
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

describe("classifyReconciliation", () => {
	it("needs both more than 5% and more than $5 to drift", () => {
		// $6 off a $200 day is 3%: matched.
		expect(classifyReconciliation(206_000_000, 200_000_000)).toBe("matched");
		// $4 off a $20 day is 20% but under $5: matched.
		expect(classifyReconciliation(24_000_000, 20_000_000)).toBe("matched");
		// $5 exactly is not more than $5.
		expect(classifyReconciliation(15_000_000, 10_000_000)).toBe("matched");
		// $11 off a $100 day is 11% and over $5: drift, in either direction.
		expect(classifyReconciliation(111_000_000, 100_000_000)).toBe("drift");
		expect(classifyReconciliation(89_000_000, 100_000_000)).toBe("drift");
	});

	it("flags cost on one side only above $1", () => {
		expect(classifyReconciliation(1_500_000, 0)).toBe("ledger_only");
		expect(classifyReconciliation(0, 1_500_000)).toBe("gateway_only");
		expect(classifyReconciliation(1_000_000, 0)).toBe("matched");
		expect(classifyReconciliation(0, 900_000)).toBe("matched");
		expect(classifyReconciliation(0, 0)).toBe("matched");
	});
});

describe("buildReconciliationRows", () => {
	it("merges normalized models and adds provider-day totals", () => {
		const rows = buildReconciliationRows({
			day: "2026-11-18",
			gatewayId: GATEWAY,
			computedAt: "2026-11-19T02:00:00.000Z",
			ledger: [
				{
					provider: "azure-openai",
					model: "openai/gpt-6.1-sol",
					costMicros: 34_490_000,
					rowCount: 750,
				},
				{
					provider: "workers-ai",
					model: "@cf/moonshotai/kimi-k2.7-code",
					costMicros: 62_760_000,
					rowCount: 3308,
				},
			],
			gateway: [
				group("azure-openai", "gpt-6.1-sol", 60.79, 1793),
				group("azure-openai", "gpt-6-astra", 43.24, 565),
				group("workers-ai", "@cf/moonshotai/kimi-k2.7-code", 62.76, 3309),
				// Another gateway on the account is ignored.
				group("workers-ai", "@cf/baai/bge-m3", 9, 100, "default"),
			],
		});
		const byKey = Object.fromEntries(
			rows.map((row) => [`${row.provider}|${row.model}`, row]),
		);
		expect(Object.keys(byKey).sort()).toEqual([
			"azure-openai|",
			"azure-openai|openai/gpt-6-astra",
			"azure-openai|openai/gpt-6.1-sol",
			"workers-ai|",
			"workers-ai|@cf/moonshotai/kimi-k2.7-code",
		]);
		expect(byKey["azure-openai|openai/gpt-6.1-sol"]).toMatchObject({
			ledgerCostMicros: 34_490_000,
			gatewayCostMicros: 60_790_000,
			differenceMicros: -26_300_000,
			ledgerRowCount: 750,
			gatewayRequestCount: 1793,
			status: "drift",
		});
		expect(byKey["azure-openai|openai/gpt-6-astra"]?.status).toBe(
			"gateway_only",
		);
		expect(byKey["azure-openai|"]).toMatchObject({
			ledgerCostMicros: 34_490_000,
			gatewayCostMicros: 104_030_000,
			status: "drift",
		});
		expect(byKey["workers-ai|"]).toMatchObject({
			ledgerCostMicros: 62_760_000,
			gatewayCostMicros: 62_760_000,
			differenceMicros: 0,
			status: "matched",
		});
	});
});

describe("reconcileGatewayCostDay", () => {
	it("queries one UTC day of analytics, sums the ledger and replaces the day", async () => {
		const fetchMock = graphqlResponse([
			group("azure-openai", "gpt-6-luna", 1.8),
			group("workers-ai", "@cf/moonshotai/kimi-k2.7-code", 62.76),
		]);
		vi.stubGlobal("fetch", fetchMock);
		sumLedgerCostByProviderModel.mockResolvedValue([
			{
				provider: "azure-openai",
				model: "openai/gpt-6-luna",
				costMicros: 1_800_000,
				rowCount: 3114,
			},
			{
				provider: "workers-ai",
				model: "@cf/moonshotai/kimi-k2.7-code",
				costMicros: 62_760_000,
				rowCount: 3308,
			},
		]);

		const result = await reconcileGatewayCostDay(db, env, {
			day: "2026-11-18",
			gatewayId: GATEWAY,
			now: "2026-11-19T02:00:00.000Z",
		});

		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://api.cloudflare.com/client/v4/graphql");
		expect((init?.headers as Record<string, string>).Authorization).toBe(
			"Bearer tok-1",
		);
		const body = JSON.parse(String(init?.body)) as {
			query: string;
			variables: Record<string, unknown>;
		};
		expect(body.query).toContain("aiGatewayRequestsAdaptiveGroups");
		expect(body.variables).toMatchObject({
			accountTag: "acct-1",
			start: "2026-11-18T00:00:00Z",
			end: "2026-11-18T23:00:00Z",
		});
		expect(sumLedgerCostByProviderModel).toHaveBeenCalledWith(db, {
			gatewayId: GATEWAY,
			sinceInclusive: "2026-11-18T00:00:00.000Z",
			untilExclusive: "2026-11-19T00:00:00.000Z",
		});
		expect(result.rows.every((row) => row.status === "matched")).toBe(true);
		expect(replaceGatewayReconciliationDay).toHaveBeenCalledWith(db, {
			day: "2026-11-18",
			gatewayId: GATEWAY,
			rows: result.rows,
		});
	});

	it("fails loudly on GraphQL errors returned with HTTP 200", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve(
					new Response(
						JSON.stringify({
							data: null,
							errors: [{ message: "not authorized for that account" }],
						}),
						{ status: 200 },
					),
				),
			),
		);
		await expect(
			reconcileGatewayCostDay(db, env, {
				day: "2026-11-18",
				gatewayId: GATEWAY,
				now: "2026-11-19T02:00:00.000Z",
			}),
		).rejects.toThrow("not authorized for that account");
		expect(replaceGatewayReconciliationDay).not.toHaveBeenCalled();
	});

	it("names the HTTP status when Cloudflare rejects the request", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response("denied", { status: 403 }))),
		);
		await expect(
			reconcileGatewayCostDay(db, env, {
				day: "2026-11-18",
				gatewayId: GATEWAY,
				now: "2026-11-19T02:00:00.000Z",
			}),
		).rejects.toThrow("HTTP 403");
	});
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
		).rejects.toThrow("CF_ANALYTICS_TOKEN, AI_GATEWAY_LLM_ID");
	});
});
