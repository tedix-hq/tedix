import { sha256Hex } from "@tedix/worker-kit/crypto";
import { DatabaseSync } from "node:sqlite";
import { encodeAiGatewayAttribution } from "@tedix/api-contract/schemas/ai-gateway-attribution";
import { createDbClient } from "@tedix/db/client";
import type { NewTediCallCost } from "@tedix/db/schema/tedis";
import { tediCallCosts } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	type AiGatewayLogRow,
	demoteUnknownAttribution,
	ingestGatewayLogCosts,
	mapRowToCallCost,
	matchesGatewayExecution,
	matchesAuthenticatedGatewayExecution,
} from "./gateway-cost-ingestion";

const insertCallCosts = vi.hoisted(() => vi.fn());
const getExistingGatewayLogIds = vi.hoisted(() => vi.fn());
vi.mock("@tedix/db/queries/tedi-usage", () => ({
	insertCallCosts,
	getExistingGatewayLogIds,
}));
const cacheExecutions = vi.hoisted(() =>
	vi.fn(() => Promise.resolve([] as unknown[])),
);
const cacheRates = vi.hoisted(() =>
	vi.fn(() => Promise.resolve([] as unknown[])),
);
vi.mock("@tedix/db/queries/provider-executions", () => ({
	getProviderExecutionsByIds: cacheExecutions,
}));
vi.mock("@tedix/db/queries/billing/provider-model-rates", () => ({
	findProviderModelRates: cacheRates,
}));
vi.mock("@tedix/db/queries/platform-job-storage", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/platform-job-storage")
	>()),
	loadKnownGatewayAttributionIds: async () => ({
		organizationIds: ["org-1"],
		tediIds: ["tedi-1"],
	}),
}));
// The post-ingest settlement pass is billing-metering's concern (covered in
// billing-metering.test.ts); stub it so cursor tests exercise ingestion alone.
vi.mock("./billing-metering", () => ({
	settleUnbilledGatewayCosts: vi.fn(() =>
		Promise.resolve({
			settled: 0,
			failed: 0,
			quarantined: 0,
			providerUsageRecorded: 0,
			remainingAtLeast: 0,
			errorSummaries: [],
		}),
	),
	drainStripeMeterOutbox: vi.fn(() =>
		Promise.resolve({ claimed: 0, sent: 0, failed: 0 }),
	),
}));

function row(overrides: Partial<AiGatewayLogRow> = {}): AiGatewayLogRow {
	return {
		id: "01ROW000000000000000000000",
		created_at: "2026-07-04T00:00:00.000Z",
		provider: "azure-openai",
		model: "gpt-5.6-terra",
		success: true,
		cached: false,
		cost: 0,
		tokens_in: 100,
		tokens_out: 50,
		usage_metadata: null,
		metadata: null,
		...overrides,
	};
}

const execution = {
	id: "execution-1",
	organizationId: "org-1",
	tediId: "tedi-1",
	source: "observer",
	runId: "run-1",
	workItemId: "work-1",
	traceId: null,
	idempotencyKey: "admission-1",
	settlementMode: "managed",
	billingReservationId: "reservation-1",
	provider: "azure-openai",
	requestModel: "custom-terra",
	gatewayAccountId: "account-1",
	gatewayId: "example-gateway",
	transportKind: "gateway-https",
	apiKind: "azure-responses",
	providerResource: "tedix-resource",
	providerOrigin: "https://tedix-resource.openai.azure.com",
	deployment: "custom-terra",
	deploymentScope: "scope",
	authorizedAt: "2026-09-20T00:00:00.000Z",
	sendBefore: "2026-09-20T00:10:00.000Z",
} as const;
const validLog = () =>
	row({
		created_at: "2026-09-20T00:01:00.000Z",
		path: "tedix-resource/openai/v1/responses",
		model: "openai/custom-terra",
		metadata: {
			orgId: "org-1",
			tediId: "tedi-1",
			attribution: encodeAiGatewayAttribution({
				executionId: execution.id,
				billingReservationId: execution.billingReservationId,
				runId: execution.runId,
				workItemId: execution.workItemId,
			}),
		},
	});
describe("gateway cost and immutable token identity", () => {
	it.each([0, 0.0042])(
		"preserves explicit native Workers AI charge %s",
		(cost) => {
			expect(
				mapRowToCallCost(
					row({ provider: "workers-ai", cost }),
					"example-gateway",
				),
			).toMatchObject({
				estimatedCostUsd: cost,
				costBasis: "gateway_reported",
				dataQuality: "ok",
			});
		},
	);
	it.each([null, NaN, Infinity, -1])(
		"holds missing or invalid native charge %s",
		(cost) =>
			expect(
				mapRowToCallCost(
					row({ provider: "workers-ai", cost }),
					"example-gateway",
				).estimatedCostUsd,
			).toBeNull(),
	);
	it.each([null, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER])(
		"does not label a governed fallback as native Workers AI cost for %s",
		(cost) => {
			expect(
				mapRowToCallCost(
					row({ provider: "workers-ai", cost }),
					"example-gateway",
					{
						execution: { ...execution, provider: "workers-ai" },
						costUsd: 0.1,
						rateVersionId: "rate-1",
						reason: null,
					},
				),
			).toMatchObject({
				estimatedCostUsd: null,
				costBasis: "unknown",
				costReason: "invalid_reported_cost",
				dataQuality: "quarantined_no_pricing",
			});
		},
	);
	it("does not reprice Azure or accept token metadata without a receipt", () => {
		expect(
			mapRowToCallCost(
				row({
					cost: 12,
					metadata: {
						orgId: "org-1",
						tediId: "tedi-1",
						usage: JSON.stringify({ k: "voice_tts", u: "characters", q: 40 }),
					},
				}),
				"example-gateway",
			),
		).toMatchObject({
			orgId: null,
			tediId: null,
			usageKind: null,
			estimatedCostUsd: null,
			rawReportedCostUsd: 12,
			costBasis: "unknown",
		});
	});
	it("keeps governed zero and derives classification only from the receipt", () => {
		const log = validLog();
		log.metadata = {
			...log.metadata,
			source: "forged",
			channel: "kernel",
			surface: "kernel",
		};
		expect(
			mapRowToCallCost(log, "example-gateway", {
				execution,
				costUsd: 0,
				rateVersionId: "rate-1",
				reason: null,
			}),
		).toMatchObject({
			orgId: "org-1",
			tediId: "tedi-1",
			source: "ai-gateway-log:observer",
			sessionType: "tedi_observer",
			estimatedCostUsd: 0,
			rateVersionId: "rate-1",
			costBasis: "governed_estimate",
		});
	});
	it("records zero provider cost for verified Azure Gateway cache hits without dropping usage", () => {
		expect(
			mapRowToCallCost(row({ cached: true, cost: 0 }), "example-gateway", {
				execution,
				costUsd: 0.1,
				rateVersionId: "rate-1",
				reason: null,
			}),
		).toMatchObject({
			estimatedCostUsd: 0,
			costBasis: "governed_estimate",
			rateVersionId: "rate-1",
			dataQuality: "ok",
			inputTokens: 100,
			outputTokens: 50,
			totalTokens: 150,
			billingReservationId: execution.billingReservationId,
		});
	});
	it.each([
		{
			execution: null,
			costUsd: null,
			rateVersionId: null,
			reason: "unverified_execution",
		},
		{ execution, costUsd: null, rateVersionId: null, reason: "missing_rate" },
	])("keeps unverified or unpriced cache hits held: $reason", (priced) => {
		expect(
			mapRowToCallCost(
				row({ cached: true, cost: 0 }),
				"example-gateway",
				priced,
			),
		).toMatchObject({
			estimatedCostUsd: null,
			costBasis: "unknown",
			dataQuality: "quarantined_no_pricing",
			costReason: priced.reason,
		});
	});
	it("keeps failed usage raw and unpriced", () =>
		expect(
			mapRowToCallCost(row({ success: false, cost: 4 }), "example-gateway"),
		).toMatchObject({
			estimatedCostUsd: null,
			rawReportedCostUsd: 4,
			dataQuality: "quarantined_failed",
		}));
	it("joins exact Responses deployment evidence, never a slash-tail alias", () => {
		expect(
			matchesGatewayExecution(
				validLog(),
				"example-gateway",
				"account-1",
				execution,
			),
		).toBe(true);
		for (const log of [
			row({ ...validLog(), model: "openai/gpt-5.6-terra" }),
			row({ ...validLog(), path: "foreign/openai/v1/responses" }),
			row({ ...validLog(), created_at: "2026-09-21T00:00:00Z" }),
			row({
				...validLog(),
				metadata: { ...validLog().metadata, orgId: "org-2" },
			}),
		])
			expect(
				matchesGatewayExecution(log, "example-gateway", "account-1", execution),
			).toBe(false);
		expect(
			matchesGatewayExecution(
				validLog(),
				"example-gateway",
				"account-2",
				execution,
			),
		).toBe(false);
	});
	it.each([
		{ provider: "workers-ai", model: "@cf/openai/whisper" },
		{ provider: "workers-ai", model: "@cf/deepgram/aura-1" },
		{
			provider: "azure-openai",
			model: "custom-voice",
			path: "resource/custom-voice/audio/transcriptions?api-version=2025-01-01",
		},
		{
			provider: "azure-openai",
			model: "custom-voice",
			path: "resource/custom-voice/audio/speech?api-version=2025-01-01",
		},
	])(
		"preserves native voice attribution without a units envelope: %j",
		(native) =>
			expect(
				mapRowToCallCost(
					row({
						...native,
						cost: null,
						metadata: { orgId: "org-1", tediId: "tedi-1" },
					}),
					"example-gateway",
				),
			).toMatchObject({
				orgId: "org-1",
				tediId: "tedi-1",
				usageKind: null,
				estimatedCostUsd: null,
			}),
	);
	it("retains validated voice units but does not trust forged units on chat", () => {
		const metadata = {
			orgId: "org-1",
			tediId: "tedi-1",
			usage: JSON.stringify({ k: "voice_tts", u: "characters", q: 42 }),
		};
		expect(
			mapRowToCallCost(
				row({ provider: "workers-ai", model: "@cf/deepgram/aura-1", metadata }),
				"example-gateway",
			),
		).toMatchObject({ usageKind: "voice_tts", usageQuantity: 42 });
		expect(
			mapRowToCallCost(
				row({ provider: "workers-ai", model: "@cf/qwen/qwen3", metadata }),
				"example-gateway",
			),
		).toMatchObject({ orgId: null, tediId: null, usageKind: null });
	});
});

describe("demoteUnknownAttribution (cost-ledger poison-pill guard)", () => {
	const REAL_ORG = "0f0f0f0f-0000-4000-8000-000000000001";
	const REAL_TEDI = "5eed0038-0000-4000-8000-000000000038";
	const GHOST_ORG = "b3b5a1c0-0000-0000-0000-000000000000";

	const cost = (o: Partial<NewTediCallCost> = {}): NewTediCallCost =>
		({
			gatewayLogId: "01LOG",
			gatewayId: "example-gateway",
			orgId: null,
			tediId: null,
			totalTokens: 10,
			dataQuality: "ok",
			...o,
		}) as NewTediCallCost;

	const known = (orgs: string[] = [], tedis: string[] = []) =>
		[new Set(orgs), new Set(tedis)] as const;

	it("demotes the exact org id that wedged production to NULL", () => {
		const [o, t] = known([REAL_ORG], [REAL_TEDI]);
		const res = demoteUnknownAttribution(
			[cost({ orgId: GHOST_ORG, tediId: null })],
			o,
			t,
		);
		expect(res.rows[0].orgId).toBeNull();
		expect(res.unknownOrgIds).toEqual([GHOST_ORG]);
	});

	it("preserves attribution that really exists", () => {
		const [o, t] = known([REAL_ORG], [REAL_TEDI]);
		const res = demoteUnknownAttribution(
			[cost({ orgId: REAL_ORG, tediId: REAL_TEDI })],
			o,
			t,
		);
		expect(res.rows[0].orgId).toBe(REAL_ORG);
		expect(res.rows[0].tediId).toBe(REAL_TEDI);
		expect(res.unknownOrgIds).toEqual([]);
		expect(res.unknownTediIds).toEqual([]);
	});

	it("demotes a dangling tedi id independently of the org", () => {
		const [o, t] = known([REAL_ORG], []);
		const res = demoteUnknownAttribution(
			[cost({ orgId: REAL_ORG, tediId: "deleted-tedi" })],
			o,
			t,
		);
		expect(res.rows[0].orgId).toBe(REAL_ORG);
		expect(res.rows[0].tediId).toBeNull();
		expect(res.unknownTediIds).toEqual(["deleted-tedi"]);
	});

	it("leaves already-NULL attribution alone (the 'unattributed' shape)", () => {
		const [o, t] = known([REAL_ORG], [REAL_TEDI]);
		const res = demoteUnknownAttribution([cost()], o, t);
		expect(res.rows[0].orgId).toBeNull();
		expect(res.unknownOrgIds).toEqual([]);
	});

	it("keeps the good rows in a batch that contains one poisoned row", () => {
		const [o, t] = known([REAL_ORG], [REAL_TEDI]);
		const res = demoteUnknownAttribution(
			[
				cost({ gatewayLogId: "01GOOD", orgId: REAL_ORG, tediId: REAL_TEDI }),
				cost({ gatewayLogId: "01POISON", orgId: GHOST_ORG }),
				cost({ gatewayLogId: "01ALSOGOOD", orgId: REAL_ORG }),
			],
			o,
			t,
		);
		expect(res.rows).toHaveLength(3);
		expect(res.rows[0].orgId).toBe(REAL_ORG);
		expect(res.rows[1].orgId).toBeNull();
		expect(res.rows[2].orgId).toBe(REAL_ORG);
		// The row is KEPT, not dropped — its tokens/cost are real.
		expect(res.rows[1].totalTokens).toBe(10);
	});

	it("dedupes repeated unknown ids in the report", () => {
		const [o, t] = known([], []);
		const res = demoteUnknownAttribution(
			[cost({ orgId: GHOST_ORG }), cost({ orgId: GHOST_ORG })],
			o,
			t,
		);
		expect(res.unknownOrgIds).toEqual([GHOST_ORG]);
	});
});

/**
 * A rejected or missing gateway credential reports `ingested=0 skipped=0` —
 * indistinguishable from a quiet tick — leaving the cost ledger empty. The job
 * uses CF_AI_GATEWAY_TOKEN, and a missing credential must read like the operator
 * problem it is rather than as 40 pages of doomed requests.
 */
describe("ingestGatewayLogCosts — missing credential fails loud", () => {
	const db = {} as never;

	it.each([undefined, "", "   "])(
		"rejects missing gateway configuration (%s) before reading or fetching",
		async (gatewayId) => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			try {
				await expect(
					ingestGatewayLogCosts(db, {
						CF_ACCOUNT_ID: "acct",
						AI_GATEWAY_LLM_ID: gatewayId as string,
						CF_AI_GATEWAY_TOKEN: "tok",
					}),
				).rejects.toThrow("AI_GATEWAY_LLM_ID is not set");
				expect(fetchMock).not.toHaveBeenCalled();
			} finally {
				vi.unstubAllGlobals();
			}
		},
	);

	it("returns an explicit failure per gateway when CF_AI_GATEWAY_TOKEN is unset", async () => {
		const results = await ingestGatewayLogCosts(db, {
			CF_ACCOUNT_ID: "acct",
			AI_GATEWAY_LLM_ID: "example-gateway",
			CF_AI_GATEWAY_TOKEN: "",
			TEDIX_BILLING_SETTLEMENT_MODE: "managed",
		});
		expect(results.map((result) => result.gatewayId)).toEqual([
			"example-gateway",
			"default",
		]);
		for (const r of results) {
			expect(r.ingested).toBe(0);
			expect(r.failure).toMatch(/CF_AI_GATEWAY_TOKEN is not set/);
		}
	});

	it("treats a whitespace-only token as unset (never sends `Bearer  `)", async () => {
		const [first] = await ingestGatewayLogCosts(db, {
			CF_ACCOUNT_ID: "acct",
			AI_GATEWAY_LLM_ID: "example-gateway",
			CF_AI_GATEWAY_TOKEN: "   ",
			TEDIX_BILLING_SETTLEMENT_MODE: "managed",
		});
		expect(first?.failure).toMatch(/not set/);
	});

	it("still reports unavailable observation credentials when settlement is disabled", async () => {
		await expect(
			ingestGatewayLogCosts(db, {
				CF_ACCOUNT_ID: "acct",
				AI_GATEWAY_LLM_ID: "example-gateway",
				CF_AI_GATEWAY_TOKEN: "",
				TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
			}),
		).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					ingested: 0,
					failure: expect.stringContaining("CF_AI_GATEWAY_TOKEN is not set"),
				}),
			]),
		);
	});
});

// ---------------------------------------------------------------------------
// Cursor-advance contract (billing.md: "Cursor advancement happens only after
// rows are written"). A page whose writes ALL fail must hold the cursor so the
// usage retries next tick; partial success still advances so a single poison
// row cannot wedge the ledger.
// ---------------------------------------------------------------------------

interface CursorDbState {
	upserts: Array<{ lastLogCreatedAt: string; lastLogId: string }>;
	cursor?: { lastLogCreatedAt: string; lastLogId: string };
	rejectNextAdvance?: boolean;
}

/**
 * Minimal drizzle-shaped stand-in: cursor advances are recorded and can lose
 * a synthetic CAS race. Attribution lookups never run because test rows are
 * unattributed. The real conditional SQL is covered in the DB query test.
 */
function cursorDb(state: CursorDbState) {
	return {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: () => Promise.resolve(state.cursor ? [state.cursor] : []),
				}),
			}),
		}),
		insert: () => ({
			values: (row: { lastLogCreatedAt: string; lastLogId: string }) => ({
				onConflictDoNothing: () => ({
					returning: () => {
						if (state.cursor || state.rejectNextAdvance) {
							state.rejectNextAdvance = false;
							return Promise.resolve([]);
						}
						state.upserts.push(row);
						state.cursor = row;
						return Promise.resolve([{ gatewayId: "example-gateway" }]);
					},
				}),
			}),
		}),
		update: () => ({
			set: (row: { lastLogCreatedAt: string; lastLogId: string }) => ({
				where: () => ({
					returning: () => {
						if (state.rejectNextAdvance) {
							state.rejectNextAdvance = false;
							return Promise.resolve([]);
						}
						state.upserts.push(row);
						state.cursor = row;
						return Promise.resolve([{ gatewayId: "example-gateway" }]);
					},
				}),
			}),
		}),
	} as never;
}

function stubGatewayLogs(rows: AiGatewayLogRow[]) {
	let call = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			call++;
			return Promise.resolve({
				ok: true,
				json: () =>
					Promise.resolve({
						success: true,
						// Only the first gateway's first page has rows; every later
						// fetch (second gateway) is empty so the run completes.
						result: call === 1 ? rows : [],
					}),
			});
		}),
	);
}

describe("ingestGatewayLogCosts — cursor holds on total write failure", () => {
	const env = {
		TEDIX_BILLING_SETTLEMENT_MODE: "managed",
		CF_ACCOUNT_ID: "acct",
		AI_GATEWAY_LLM_ID: "example-gateway",
		CF_AI_GATEWAY_TOKEN: "tok",
		STRIPE_TEST_SECRET_KEY: "sk_test_gateway_ingestion",
		STRIPE_TEST_WEBHOOK_SECRET: "whsec_gateway_ingestion",
		STRIPE_TEST_BILLING_PORTAL_CONFIGURATION_ID: "bpc_gateway_ingestion",
	};
	const pageRows = [
		row({ id: "log-1", created_at: "2026-07-29T00:00:01.000Z" }),
		row({ id: "log-2", created_at: "2026-07-29T00:00:02.000Z" }),
	];

	afterEach(() => {
		vi.unstubAllGlobals();
		insertCallCosts.mockReset();
		getExistingGatewayLogIds.mockReset();
	});

	it.each([
		["configured-gateway", ["configured-gateway", "default"]],
		["default", ["default"]],
	])(
		"reads configured gateway %s and deduplicates default",
		async (gatewayId, expected) => {
			stubGatewayLogs([]);
			const results = await ingestGatewayLogCosts(cursorDb({ upserts: [] }), {
				...env,
				AI_GATEWAY_LLM_ID: gatewayId as string,
			});
			expect(results.map((result) => result.gatewayId)).toEqual(expected);
			expect(
				vi
					.mocked(fetch)
					.mock.calls.map(([url]) => new URL(String(url)).pathname),
			).toEqual(
				(expected as string[]).map(
					(id) => `/client/v4/accounts/acct/ai-gateway/gateways/${id}/logs`,
				),
			);
		},
	);

	it("records ordinary logs once while Jev observation logs only advance the cursor", async () => {
		const state: CursorDbState = {
			upserts: [],
			cursor: { lastLogCreatedAt: "2026-07-29T00:00:00.000Z", lastLogId: "" },
		};
		insertCallCosts.mockImplementation(
			async (_db, rows: NewTediCallCost[]) => rows,
		);
		stubGatewayLogs([
			row({ id: "ordinary", created_at: "2026-07-29T00:00:01.000Z" }),
			row({
				id: "jev-no-metadata",
				created_at: "2026-07-29T00:00:02.000Z",
				provider: "typesafe",
				model: "typesafe/jev",
				metadata: null,
			}),
			row({
				id: "jev-with-metadata",
				created_at: "2026-07-29T00:00:03.000Z",
				provider: "typesafe",
				model: "typesafe/jev",
				metadata: { diagnostic: "ignored" },
			}),
		]);

		const results = await ingestGatewayLogCosts(cursorDb(state), env);
		const production = results.find(
			(result) => result.gatewayId === "example-gateway",
		);
		expect(production).toMatchObject({ ingested: 1, failure: null });
		expect(insertCallCosts).toHaveBeenCalledOnce();
		expect(insertCallCosts.mock.calls[0]?.[1]).toEqual([
			expect.objectContaining({ gatewayLogId: "ordinary" }),
		]);
		expect(state.upserts.at(-1)?.lastLogId).toBe("jev-with-metadata");
	});

	it("advances past a Jev-only page without creating a second usage row", async () => {
		const state: CursorDbState = {
			upserts: [],
			cursor: { lastLogCreatedAt: "2026-07-29T00:00:00.000Z", lastLogId: "" },
		};
		stubGatewayLogs([
			row({
				id: "jev-only",
				created_at: "2026-07-29T00:00:01.000Z",
				provider: "typesafe",
				model: "typesafe/jev",
			}),
		]);

		const results = await ingestGatewayLogCosts(cursorDb(state), env);
		expect(
			results.find((result) => result.gatewayId === "example-gateway"),
		).toMatchObject({ ingested: 0, failure: null });
		expect(insertCallCosts).not.toHaveBeenCalled();
		expect(state.upserts.at(-1)?.lastLogId).toBe("jev-only");
	});

	it("advances an all-duplicate page only after confirming every ID in this gateway", async () => {
		const state: CursorDbState = {
			upserts: [],
			cursor: { lastLogCreatedAt: "2026-07-29T00:00:00.000Z", lastLogId: "" },
		};
		insertCallCosts.mockResolvedValue([]);
		getExistingGatewayLogIds.mockResolvedValue(["log-1", "log-2"]);
		stubGatewayLogs(pageRows);

		const results = await ingestGatewayLogCosts(cursorDb(state), env);
		const production = results.find(
			(result) => result.gatewayId === "example-gateway",
		);
		expect(production).toMatchObject({
			ingested: 0,
			skipped: 2,
			failure: null,
		});
		expect(getExistingGatewayLogIds).toHaveBeenCalledWith(
			expect.anything(),
			"example-gateway",
			["log-1", "log-2"],
		);
		expect(state.upserts[0]?.lastLogId).toBe("log-2");
	});

	it("holds cursor when a zero-insert page is missing one durable ID", async () => {
		const state: CursorDbState = { upserts: [] };
		insertCallCosts.mockResolvedValue([]);
		getExistingGatewayLogIds.mockResolvedValue(["log-1"]);
		stubGatewayLogs(pageRows);

		const results = await ingestGatewayLogCosts(cursorDb(state), env);
		const production = results.find(
			(result) => result.gatewayId === "example-gateway",
		);
		expect(production?.failure).toMatch(/cursor held for retry/);
		expect(state.upserts).toHaveLength(0);
	});

	it("holds cursor when the durability read itself fails", async () => {
		const state: CursorDbState = { upserts: [] };
		insertCallCosts.mockResolvedValue([]);
		getExistingGatewayLogIds.mockRejectedValue(new Error("D1 read outage"));
		stubGatewayLogs(pageRows);

		const results = await ingestGatewayLogCosts(cursorDb(state), env);
		const production = results.find(
			(result) => result.gatewayId === "example-gateway",
		);
		expect(production?.failure).toMatch(/cursor held for retry/);
		expect(state.upserts).toHaveLength(0);
	});

	it("holds the cursor and surfaces a failure when every row write fails", async () => {
		const state: CursorDbState = { upserts: [] };
		insertCallCosts.mockRejectedValue(new Error("D1 write outage"));
		getExistingGatewayLogIds.mockResolvedValue([]);
		stubGatewayLogs(pageRows);

		const results = await ingestGatewayLogCosts(cursorDb(state), env);
		const production = results.find(
			(result) => result.gatewayId === "example-gateway",
		);
		expect(production?.ingested).toBe(0);
		expect(production?.failure).toMatch(/cursor held for retry/);
		expect(getExistingGatewayLogIds).toHaveBeenCalledWith(
			expect.anything(),
			"example-gateway",
			["log-1", "log-2"],
		);
		expect(state.upserts).toHaveLength(0);
	});

	it("still advances the cursor when at least one row lands (poison isolation)", async () => {
		const state: CursorDbState = {
			upserts: [],
			cursor: { lastLogCreatedAt: "2026-07-29T00:00:00.000Z", lastLogId: "" },
		};
		insertCallCosts.mockImplementation(
			(_db: unknown, rows: NewTediCallCost[]) => {
				if (rows.length > 1) return Promise.reject(new Error("batch failed"));
				if (rows[0]?.gatewayLogId === "log-1")
					return Promise.reject(new Error("poison row"));
				return Promise.resolve(rows);
			},
		);
		stubGatewayLogs(pageRows);

		const results = await ingestGatewayLogCosts(cursorDb(state), env);
		const production = results.find(
			(result) => result.gatewayId === "example-gateway",
		);
		expect(production?.ingested).toBe(1);
		expect(production?.skipped).toBe(1);
		expect(production?.failure ?? null).toBeNull();
		expect(getExistingGatewayLogIds).not.toHaveBeenCalled();
		expect(state.upserts).toHaveLength(1);
		expect(state.upserts[0]?.lastLogId).toBe("log-2");
	});

	it("advances the cursor normally when the whole page lands", async () => {
		const state: CursorDbState = {
			upserts: [],
			cursor: { lastLogCreatedAt: "2026-07-29T00:00:00.000Z", lastLogId: "" },
		};
		insertCallCosts.mockImplementation(
			(_db: unknown, rows: NewTediCallCost[]) => Promise.resolve(rows),
		);
		stubGatewayLogs(pageRows);

		const results = await ingestGatewayLogCosts(cursorDb(state), env);
		const production = results.find(
			(result) => result.gatewayId === "example-gateway",
		);
		expect(production?.ingested).toBe(2);
		expect(production?.failure ?? null).toBeNull();
		expect(state.upserts).toHaveLength(1);
		expect(state.upserts[0]).toMatchObject({
			lastLogCreatedAt: "2026-07-29T00:00:02.000Z",
			lastLogId: "log-2",
		});
	});

	it("stops stale paging quietly when an overlapping tick wins the cursor CAS", async () => {
		const state: CursorDbState = {
			upserts: [],
			cursor: {
				lastLogCreatedAt: "2026-07-29T00:00:00.000Z",
				lastLogId: "old",
			},
			rejectNextAdvance: true,
		};
		insertCallCosts.mockImplementation(
			(_db: unknown, rows: NewTediCallCost[]) => Promise.resolve(rows),
		);
		stubGatewayLogs(pageRows);
		const results = await ingestGatewayLogCosts(cursorDb(state), env);
		expect(results[0]).toMatchObject({
			ingested: 2,
			failure: null,
			contended: true,
		});
		expect(state.upserts).toHaveLength(0);
		// The next fetch is only the independent default gateway, not page 2 of
		// the stale example-gateway offset.
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
	});

	it("replays a saved timestamp even when the next provider ID sorts before the saved ID", async () => {
		const timestamp = "2026-07-29T00:00:02.000Z";
		const state: CursorDbState = {
			upserts: [],
			cursor: { lastLogCreatedAt: timestamp, lastLogId: "z-log" },
		};
		insertCallCosts.mockImplementation(
			(_db: unknown, rows: NewTediCallCost[]) => Promise.resolve(rows),
		);
		stubGatewayLogs([row({ id: "a-log", created_at: timestamp })]);

		const results = await ingestGatewayLogCosts(cursorDb(state), env);
		expect(results[0]).toMatchObject({ ingested: 1, failure: null });
		expect(insertCallCosts).toHaveBeenCalledWith(expect.anything(), [
			expect.objectContaining({ gatewayLogId: "a-log" }),
		]);
		const query = new URL((vi.mocked(fetch).mock.calls[0] as [string])[0]);
		const filters = JSON.parse(query.searchParams.get("filters") ?? "[]");
		expect(filters[0].value).toEqual(["2026-07-29T00:00:01.999Z"]);
	});

	it("closes a full page when the following page is empty", async () => {
		const timestamp = "2026-07-29T00:00:01.000Z";
		const state: CursorDbState = {
			upserts: [],
			cursor: { lastLogCreatedAt: "2026-07-29T00:00:00.000Z", lastLogId: "" },
		};
		insertCallCosts.mockImplementation(
			(_db: unknown, rows: NewTediCallCost[]) => Promise.resolve(rows),
		);
		const firstPage = Array.from({ length: 50 }, (_, index) =>
			row({ id: `log-${index}`, created_at: timestamp }),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) =>
				Promise.resolve({
					ok: true,
					json: () =>
						Promise.resolve({
							success: true,
							result:
								new URL(url).pathname.includes("example-gateway") &&
								new URL(url).searchParams.get("page") === "1"
									? firstPage
									: [],
						}),
				}),
			),
		);

		const results = await ingestGatewayLogCosts(cursorDb(state), env);
		expect(results[0]).toMatchObject({ ingested: 50, failure: null });
		expect(state.upserts.at(-1)?.lastLogCreatedAt).toBe(timestamp);
	});

	it.each([false, true])(
		"handles a %s timestamp tie across pages 40 and 41 without skipping it",
		async (tieAcrossCap) => {
			const state: CursorDbState = {
				upserts: [],
				cursor: { lastLogCreatedAt: "2026-07-29T00:00:00.000Z", lastLogId: "" },
			};
			const pageTimestamp = (page: number) =>
				new Date(Date.UTC(2026, 6, 29, 0, 0, page)).toISOString();
			const capTimestamp = pageTimestamp(40);
			insertCallCosts.mockImplementation(
				(_db: unknown, rows: NewTediCallCost[]) => Promise.resolve(rows),
			);
			vi.stubGlobal(
				"fetch",
				vi.fn((url: string) => {
					const request = new URL(url);
					const page = Number(request.searchParams.get("page"));
					const isFirstGateway = request.pathname.includes("example-gateway");
					const timestamp =
						page === 41 && tieAcrossCap ? capTimestamp : pageTimestamp(page);
					const rows = !isFirstGateway
						? []
						: page <= 40
							? Array.from({ length: 50 }, (_, index) =>
									row({
										id: `page-${page}-row-${index}`,
										created_at: timestamp,
									}),
								)
							: [row({ id: "lookahead", created_at: timestamp })];
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve({ success: true, result: rows }),
					});
				}),
			);

			const results = await ingestGatewayLogCosts(cursorDb(state), env);
			expect(results[0]?.ingested).toBe(2000);
			expect(results[0]?.failure).toEqual(
				tieAcrossCap
					? expect.stringContaining("timestamp tie crosses the page cap")
					: null,
			);
			expect(state.upserts.at(-1)?.lastLogCreatedAt).toBe(
				tieAcrossCap ? pageTimestamp(39) : capTimestamp,
			);
			expect(
				state.upserts.some((entry) => entry.lastLogCreatedAt === capTimestamp),
			).toBe(!tieAcrossCap);
		},
	);

	it("applies the smaller catch-up page cap and preserves a tie across its lookahead", async () => {
		const state: CursorDbState = {
			upserts: [],
			cursor: {
				lastLogCreatedAt: "2026-07-29T00:00:00.000Z",
				lastLogId: "old",
			},
		};
		insertCallCosts.mockImplementation(
			(_db: unknown, rows: NewTediCallCost[]) => Promise.resolve(rows),
		);
		const pageTimestamp = (page: number) =>
			new Date(Date.UTC(2026, 6, 29, 0, 0, page)).toISOString();
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				const request = new URL(url);
				const page = Number(request.searchParams.get("page"));
				const rows = !request.pathname.includes("example-gateway")
					? []
					: page <= 10
						? Array.from({ length: 50 }, (_, index) =>
								row({
									id: `catchup-${page}-${index}`,
									created_at: pageTimestamp(page),
								}),
							)
						: [row({ id: "tie-on-next-page", created_at: pageTimestamp(10) })];
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ success: true, result: rows }),
				});
			}),
		);
		const results = await ingestGatewayLogCosts(cursorDb(state), env, {
			maxPagesPerGateway: 10,
		});
		expect(results[0]).toMatchObject({
			ingested: 500,
			failure: expect.stringContaining("timestamp tie crosses the page cap"),
		});
		expect(state.upserts.at(-1)?.lastLogCreatedAt).toBe(pageTimestamp(9));
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(12);
	});

	it("holds the page-40 timestamp when page-41 lookahead fetch fails", async () => {
		const state: CursorDbState = {
			upserts: [],
			cursor: { lastLogCreatedAt: "2026-07-29T00:00:00.000Z", lastLogId: "" },
		};
		const pageTimestamp = (page: number) =>
			new Date(Date.UTC(2026, 6, 29, 0, 0, page)).toISOString();
		insertCallCosts.mockImplementation(
			(_db: unknown, rows: NewTediCallCost[]) => Promise.resolve(rows),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				const request = new URL(url);
				const page = Number(request.searchParams.get("page"));
				if (request.pathname.includes("example-gateway") && page === 41)
					return Promise.reject(new Error("lookahead outage"));
				const rows = request.pathname.includes("example-gateway")
					? Array.from({ length: 50 }, (_, index) =>
							row({
								id: `page-${page}-row-${index}`,
								created_at: pageTimestamp(page),
							}),
						)
					: [];
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ success: true, result: rows }),
				});
			}),
		);

		const results = await ingestGatewayLogCosts(cursorDb(state), env);
		expect(results[0]).toMatchObject({
			ingested: 2000,
			failure: expect.stringContaining("page 41 lookahead failed"),
		});
		expect(results[0]?.failure).toContain("lookahead outage");
		expect(state.upserts.at(-1)?.lastLogCreatedAt).toBe(pageTimestamp(39));
		expect(
			state.upserts.some(
				(entry) => entry.lastLogCreatedAt === pageTimestamp(40),
			),
		).toBe(false);
	});

	it("reports an oversized single-timestamp group instead of advancing past unseen IDs", async () => {
		const timestamp = "2026-07-29T00:00:01.000Z";
		const state: CursorDbState = {
			upserts: [],
			cursor: { lastLogCreatedAt: "2026-07-29T00:00:00.000Z", lastLogId: "" },
		};
		insertCallCosts.mockImplementation(
			(_db: unknown, rows: NewTediCallCost[]) => Promise.resolve(rows),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				const request = new URL(url);
				const page = Number(request.searchParams.get("page"));
				const rows = !request.pathname.includes("example-gateway")
					? []
					: page <= 40
						? Array.from({ length: 50 }, (_, index) =>
								row({
									id: `tie-${page}-${index}`,
									created_at: timestamp,
								}),
							)
						: [row({ id: "unseen-tie", created_at: timestamp })];
				return Promise.resolve({
					ok: true,
					json: () => Promise.resolve({ success: true, result: rows }),
				});
			}),
		);

		const results = await ingestGatewayLogCosts(cursorDb(state), env);
		expect(results[0]).toMatchObject({
			ingested: 2000,
			failure: expect.stringContaining("timestamp tie crosses the page cap"),
		});
		expect(state.upserts).toHaveLength(0);
		expect(vi.mocked(fetch)).toHaveBeenCalledTimes(42);
	});
});

it("checks all page IDs with D1-safe chunks and the exact gateway predicate", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(tediCallCosts));
	try {
		const insert = sqlite.prepare(
			"INSERT INTO tedi_call_costs (id, gateway_log_id, gateway_id, snapshot_at, model) VALUES (?, ?, ?, ?, ?)",
		);
		const expected = Array.from({ length: 55 }, (_, index) => `log-${index}`);
		for (const id of expected)
			insert.run(id, id, "default", "2026-09-23T00:00:00.000Z", "model");
		insert.run(
			"other-row",
			"other-log",
			"example-gateway",
			"2026-09-23T00:00:00.000Z",
			"model",
		);
		const actual = await vi.importActual<
			typeof import("@tedix/db/queries/tedi-usage")
		>("@tedix/db/queries/tedi-usage");
		const found = await actual.getExistingGatewayLogIds(
			createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 })),
			"default",
			[...expected, "other-log", "missing-log", expected[0]!],
		);
		expect(new Set(found)).toEqual(new Set(expected));
	} finally {
		sqlite.close();
	}
});

describe("provider cost presence and pricing basis", () => {
	it.each([null, undefined, "0", -1, NaN, Infinity, Number.MAX_VALUE])(
		"holds invalid Workers AI reported cost %s",
		(cost) => {
			const mapped = mapRowToCallCost(
				row({ provider: "workers-ai", cost: cost as number }),
				"example-gateway",
			);
			expect(mapped).toMatchObject({
				dataQuality: "quarantined_no_pricing",
				estimatedCostUsd: null,
				inputTokens: 100,
				outputTokens: 50,
			});
		},
	);
	it.each([false, true])(
		"preserves explicit Workers AI zero (provider units=%s)",
		(providerUnits) => {
			const mapped = mapRowToCallCost(
				row({
					provider: "workers-ai",
					cost: 0,
					metadata: providerUnits
						? {
								usage: JSON.stringify({
									k: "voice_tts",
									u: "characters",
									q: 42,
								}),
							}
						: null,
				}),
				"example-gateway",
			);
			expect(mapped).toMatchObject({ dataQuality: "ok", estimatedCostUsd: 0 });
		},
	);
	it("does not price non-token Azure usage with token rates", () => {
		const mapped = mapRowToCallCost(
			row({
				path: "resource/custom-voice/audio/speech",
				tokens_in: 0,
				tokens_out: 0,
				metadata: {
					usage: JSON.stringify({ k: "voice_tts", u: "characters", q: 42 }),
				},
			}),
			"example-gateway",
		);
		expect(mapped).toMatchObject({
			dataQuality: "quarantined_no_pricing",
			usageQuantity: 42,
		});
	});
	it("distinguishes unknown zero-token models from a known no-usage zero", () => {
		expect(
			mapRowToCallCost(
				row({ model: "unknown-model", tokens_in: 0, tokens_out: 0 }),
				"example-gateway",
			).dataQuality,
		).toBe("quarantined_no_pricing");
		expect(
			mapRowToCallCost(row({ tokens_in: 0, tokens_out: 0 }), "example-gateway"),
		).toMatchObject({
			dataQuality: "quarantined_no_pricing",
			estimatedCostUsd: null,
		});
	});
});

describe("modern native Auto log correlation", () => {
	it("authenticates exact persisted pool and native /run while preserving failed-usage quarantine", async () => {
		const policy = {
			kind: "auto_router_v1" as const,
			routing: {
				version: 1 as const,
				modality: "text" as const,
				mode: "restricted" as const,
				allowedProviders: ["workers-ai"],
				allowedModels: ["@cf/example/model"],
			},
			finite: null,
		};
		const auto = {
			...execution,
			provider: "workers-ai" as const,
			requestModel: "cloudflare/auto",
			apiKind: "workers-ai-chat" as const,
			providerResource: null,
			providerOrigin: null,
			deployment: null,
			policy,
			policyHash: await sha256Hex(JSON.stringify(policy)),
		};
		const native = {
			...validLog(),
			provider: "workers-ai",
			model: "@cf/example/model",
			path: "/run",
			request_type: "run",
			authentication: true,
		};
		expect(
			await matchesAuthenticatedGatewayExecution(
				native,
				"example-gateway",
				"account-1",
				auto,
			),
		).toBe(true);
		for (const patch of [
			{ path: "/run?x=1" },
			{ path: "/compat/chat/completions" },
			{ request_type: "chat" },
			{ authentication: false },
			{ model: "openai/example/model" },
			{ model: "@cf/example/other" },
			{ model: "@cf/example/model\n" },
			{ provider: "azure-openai" },
			{ metadata: { ...native.metadata, orgId: "other" } },
		])
			expect(
				await matchesAuthenticatedGatewayExecution(
					{ ...native, ...patch },
					"example-gateway",
					"account-1",
					auto,
				),
			).toBe(false);
		for (const patch of [
			{ policy: null, policyHash: null },
			{ policyHash: "a".repeat(64) },
			{
				policy: {
					...policy,
					routing: { ...policy.routing, allowedModels: ["@cf/example/other"] },
				},
			},
		])
			expect(
				await matchesAuthenticatedGatewayExecution(
					native,
					"example-gateway",
					"account-1",
					{ ...auto, ...patch } as never,
				),
			).toBe(false);
		expect(
			await matchesAuthenticatedGatewayExecution(
				{ ...native, success: false },
				"example-gateway",
				"account-1",
				auto,
			),
		).toBe(true);
		expect(
			mapRowToCallCost(
				{ ...native, success: false, cost: 4 },
				"example-gateway",
			),
		).toMatchObject({
			estimatedCostUsd: null,
			dataQuality: "quarantined_failed",
		});
	});
});

it("modern Auto retains unrestricted/one-axis policies and every original correlation guard", async () => {
	const native = {
		...validLog(),
		provider: "workers-ai",
		model: "@cf/example/model",
		path: "/run",
		request_type: "run",
		authentication: true,
		cost: 4,
	};
	for (const restriction of [
		{
			mode: "unrestricted" as const,
			allowedProviders: null,
			allowedModels: null,
		},
		{
			mode: "restricted" as const,
			allowedProviders: ["workers-ai"],
			allowedModels: null,
		},
		{
			mode: "restricted" as const,
			allowedProviders: null,
			allowedModels: [native.model],
		},
	]) {
		const policy = {
			kind: "auto_router_v1" as const,
			routing: {
				version: 1 as const,
				modality: "text" as const,
				...restriction,
			},
			finite: null,
		};
		const auto = {
			...execution,
			provider: "workers-ai" as const,
			requestModel: "cloudflare/auto",
			apiKind: "workers-ai-chat" as const,
			providerResource: null,
			providerOrigin: null,
			deployment: null,
			policy,
			policyHash: await sha256Hex(JSON.stringify(policy)),
		};
		expect(
			await matchesAuthenticatedGatewayExecution(
				native,
				"example-gateway",
				"account-1",
				auto,
			),
		).toBe(true);
		expect(
			await matchesAuthenticatedGatewayExecution(
				native,
				"other",
				"account-1",
				auto,
			),
		).toBe(false);
		expect(
			await matchesAuthenticatedGatewayExecution(
				native,
				"example-gateway",
				"other",
				auto,
			),
		).toBe(false);
		for (const created_at of [
			"2026-09-19T23:59:59Z",
			"2026-09-20T00:10:01Z",
			"invalid",
		])
			expect(
				await matchesAuthenticatedGatewayExecution(
					{ ...native, created_at },
					"example-gateway",
					"account-1",
					auto,
				),
			).toBe(false);
		for (const patch of [
			{ executionId: "other" },
			{ billingReservationId: "other" },
			{ runId: "other" },
			{ workItemId: "other" },
		]) {
			const attribution = encodeAiGatewayAttribution({
				executionId: execution.id,
				billingReservationId: execution.billingReservationId,
				runId: execution.runId,
				workItemId: execution.workItemId,
				...patch,
			});
			expect(
				await matchesAuthenticatedGatewayExecution(
					{ ...native, metadata: { ...native.metadata, attribution } },
					"example-gateway",
					"account-1",
					auto,
				),
			).toBe(false);
		}
		expect(
			await matchesAuthenticatedGatewayExecution(
				{ ...native, metadata: { ...native.metadata, tediId: "other" } },
				"example-gateway",
				"account-1",
				auto,
			),
		).toBe(false);
		expect(
			mapRowToCallCost(native, "example-gateway", {
				execution: auto,
				costUsd: 4,
				rateVersionId: null,
				reason: null,
			}),
		).toMatchObject({
			estimatedCostUsd: 4,
			costBasis: "gateway_reported",
			executionId: execution.id,
			billingReservationId: execution.billingReservationId,
		});
	}
});

describe("normalized LIST cache creation through ingestion", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		cacheExecutions.mockReset().mockResolvedValue([]);
		cacheRates.mockReset().mockResolvedValue([]);
	});
	const ingestionEnv = {
		CF_ACCOUNT_ID: "account-1",
		AI_GATEWAY_LLM_ID: "example-gateway",
		CF_AI_GATEWAY_TOKEN: "fictional",
		TEDIX_FLEET_AUTHORITY_MODE: "co-located",
		DB: {} as D1Database,
		TEDIX_BILLING_SETTLEMENT_MODE: "managed",
	};
	it.each([
		["azure-responses", 4, false],
		["azure-chat", 4, false],
		["azure-responses", 0, false],
		["azure-chat", 0, true],
	] as const)(
		"prices and stores identical inclusive partitions for %s (creation=%s cached=%s) without detail fetch",
		async (apiKind, creation, cached) => {
			const log = validLog();
			log.path =
				apiKind === "azure-responses"
					? log.path
					: "tedix-resource/custom-terra/chat/completions";
			log.usage_metadata = {
				input_tokens: 10,
				output_tokens: 2,
				input_cached_tokens: 3,
				input_cache_creation_tokens: creation,
				total_tokens: 12,
			};
			log.cost = 99;
			log.cached = cached;
			cacheExecutions.mockResolvedValue([{ ...execution, apiKind }]);
			cacheRates.mockResolvedValue([
				{
					id: "fictional-rate",
					inputMicrousdPerMillion: 1000000,
					outputMicrousdPerMillion: 2000000,
					cacheReadMicrousdPerMillion: 100000,
					cacheWriteMicrousdPerMillion: 500000,
				},
			]);
			insertCallCosts.mockImplementation((_db, rows) => Promise.resolve(rows));
			stubGatewayLogs([log]);
			const state: CursorDbState = {
				upserts: [],
				cursor: { lastLogCreatedAt: "2026-09-20T00:00:00.000Z", lastLogId: "" },
			};
			const results = await ingestGatewayLogCosts(
				cursorDb(state),
				ingestionEnv,
			);
			expect(results[0]?.ingested).toBe(1);
			expect(insertCallCosts).toHaveBeenLastCalledWith(expect.anything(), [
				expect.objectContaining({
					inputTokens: 10,
					outputTokens: 2,
					cacheReadTokens: 3,
					cacheWriteTokens: creation,
					totalTokens: 12,
					estimatedCostUsd: cached ? 0 : creation === 0 ? 0.000012 : 0.00001,
					rawReportedCostUsd: 99,
					rateVersionId: "fictional-rate",
					costReason: null,
					dataQuality: "ok",
				}),
			]);
			expect(cacheRates).toHaveBeenLastCalledWith(
				expect.anything(),
				expect.objectContaining({
					inputTokens: 10,
					modelId: execution.requestModel,
					deploymentScope: execution.deploymentScope,
				}),
			);
			expect(state.upserts).toHaveLength(1);
			expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
		},
	);
	it.each([
		{ input_cache_creation_tokens: undefined, input_cached_tokens: 0 },
		{ input_cache_creation_tokens: null, input_cached_tokens: 0 },
		{ input_cache_creation_tokens: -1, input_cached_tokens: 0 },
		{ input_cache_creation_tokens: 0.5, input_cached_tokens: 0 },
		{
			input_cache_creation_tokens: Number.MAX_SAFE_INTEGER + 1,
			input_cached_tokens: 0,
		},
		{ input_cache_creation_tokens: 0, input_cached_tokens: undefined },
		{ input_cache_creation_tokens: 0, input_cached_tokens: null },
		{ input_cache_creation_tokens: 60, input_cached_tokens: 50 },
	])(
		"holds unknown, invalid or overlapping partitions %j before rate lookup",
		async (counters) => {
			const log = validLog();
			log.usage_metadata = counters;
			cacheExecutions.mockResolvedValue([execution]);
			cacheRates.mockClear();
			insertCallCosts.mockImplementation((_db, rows) => Promise.resolve(rows));
			stubGatewayLogs([log]);
			await ingestGatewayLogCosts(cursorDb({ upserts: [] }), ingestionEnv);
			expect(cacheRates).not.toHaveBeenCalled();
			expect(insertCallCosts).toHaveBeenLastCalledWith(expect.anything(), [
				expect.objectContaining({
					cacheWriteTokens:
						counters.input_cache_creation_tokens === 60 ? 60 : 0,
					estimatedCostUsd: null,
					rateVersionId: null,
					costReason: "invalid_usage",
					dataQuality: "quarantined_no_pricing",
				}),
			]);
		},
	);
});
