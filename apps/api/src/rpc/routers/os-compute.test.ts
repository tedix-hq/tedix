/**
 * The compute posture is an honesty surface: what it must never do is report a
 * confident number that no row supports. These tests assert against a real D1
 * facade, and — where the claim is about persisted state — against the ROW, not
 * only the wire, because the response schema strips unknown keys and a
 * response-only assertion cannot see what the ledger actually holds.
 *
 * Fixture discipline: every seeded column is written with the shape its real
 * producer writes. `tedi_call_costs` rows carry the exact
 * `provider`/`data_quality`/`session_type` values `ingestGatewayLogCosts`
 * emits (`apps/api/src/jobs/gateway-cost-ingestion.ts`), and
 * `ops_alert_state` rows carry the exact columns
 * `reconcileCloudflareCredentialFinding` writes
 * (`apps/api/src/lib/cloudflare-credential-health.ts`). No field is
 * invented that the producing path does not emit.
 */

import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import {
	billingAccounts,
	billingProviderCostEvidenceVersions,
	billingInferencePolicies,
	billingPlanVersions,
	billingUsagePeriods,
	billingUsageReservations,
	opsAlertState,
	organizations,
	tediCallCosts,
	tedis,
} from "@tedix/db/schema";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import {
	attributionGap,
	fallbackDetail,
	osComputeContractRouter,
	provenanceBuckets,
	spendTotals,
} from "./os-compute";

let sqlite: DatabaseSync;

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const TEDI = "33333333-3333-4333-8333-333333333333";
const OTHER_TEDI = "44444444-4444-4444-8444-444444444444";
const FUTURE = "2100-01-01T00:00:00.000Z";
const PAST_START = "2026-01-01T00:00:00.000Z";

const FULL_ENV = {
	ENVIRONMENT: "test",
	AI: {},
	AI_GATEWAY_ACCOUNT_ID: "acct",
	AI_GATEWAY_LLM_ID: "gw",
	CF_AI_GATEWAY_TOKEN: "token",
	AZURE_OPENAI_RESOURCE: "tedix-resource",
	AZURE_CHAT_DEPLOYMENT: "gpt-5.6-luna",
} as unknown as CloudflareEnv;

function context(
	organizationId: string | null,
	permissions: string[] = ["settings:manage"],
): BaseContext {
	return {
		authType: "user",
		db: createDbClient(createD1Facade(sqlite)) as BaseContext["db"],
		env: FULL_ENV,
		headers: new Headers(),
		organizationId: organizationId ?? undefined,
		url: new URL("https://api/rpc/osCompute/posture"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions,
			roles: [],
			sub: "user-1",
		},
	} as BaseContext;
}

function client(organizationId: string | null, permissions?: string[]) {
	return createRouterClient(osComputeContractRouter, {
		context: context(organizationId, permissions),
	});
}

function seedOrganization(id: string) {
	sqlite
		.prepare(`INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)`)
		.run(id, id, id);
}

function seedTedi(id: string, organizationId: string) {
	sqlite
		.prepare(
			`INSERT INTO tedis (id, organization_id, name, slug) VALUES (?, ?, ?, ?)`,
		)
		.run(id, organizationId, id, id);
}

function seedPlanAndAccount(organizationId: string) {
	sqlite
		.prepare(
			`INSERT OR IGNORE INTO billing_plan_versions (
				id, plan_key, version, status, name, included_monthly_tokens,
				max_tedis, max_cron_jobs_per_tedi, max_iterations_per_task,
				default_daily_token_limit, default_daily_message_limit, effective_at,
				created_at
			) VALUES ('plan-1', 'growth', 1, 'active', 'Growth', 1000000, 5, 3, 25,
				100000, 200, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run();
	sqlite
		.prepare(
			`INSERT INTO billing_accounts (
				organization_id, plan_version_id, status, billing_mode, period_start,
				period_end, credit_balance_micros, created_at, updated_at
			) VALUES (?, 'plan-1', 'active', 'stripe', ?, ?, 5000000,
				'2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(organizationId, PAST_START, FUTURE);
	sqlite
		.prepare(
			`INSERT INTO billing_usage_periods (
				id, organization_id, plan_version_id, period_start, period_end,
				included_tokens, used_input_tokens, used_output_tokens,
				created_at, updated_at
			) VALUES (?, ?, 'plan-1', ?, ?, 1000000, 300000, 100000,
				'2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
		)
		.run(`period-${organizationId}`, organizationId, PAST_START, FUTURE);
}

/**
 * One `tedi_call_costs` row with the exact column shape the gateway-cost
 * ingestion job writes. `snapshot_at` defaults to "now" so freshness reads as
 * fresh unless a test deliberately ages it.
 */
function seedCallCost(input: {
	id: string;
	organizationId: string | null;
	tediId: string;
	provider: string | null;
	dataQuality?: "ok" | "quarantined_no_pricing" | "quarantined_failed";
	sessionType?: "tedi" | "tedi_observer" | "kernel" | "unattributed";
	totalTokens?: number;
	estimatedCostUsd?: number;
	snapshotAt?: string;
}) {
	sqlite
		.prepare(
			`INSERT INTO tedi_call_costs (
				id, tedi_id, org_id, gateway_log_id, gateway_id, snapshot_at, model,
				provider, session_type, source, input_tokens, output_tokens,
				cache_read_tokens, cache_write_tokens, total_tokens,
				estimated_cost_usd, session_count, success, cached, data_quality
			) VALUES (?, ?, ?, ?, 'tedix-llm-production', ?, 'gpt-5.6-luna',
				?, ?, 'ai-gateway-log', ?, 0, 0, 0, ?, ?, 1, 1, 0, ?)`,
		)
		.run(
			input.id,
			input.tediId,
			input.organizationId,
			`log-${input.id}`,
			input.snapshotAt ?? new Date().toISOString(),
			input.provider,
			input.sessionType ?? "tedi",
			input.totalTokens ?? 0,
			input.totalTokens ?? 0,
			input.estimatedCostUsd ?? 0,
			input.dataQuality ?? "ok",
		);
}

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			organizations,
			tedis,
			tediCallCosts,
			billingProviderCostEvidenceVersions,
			billingAccounts,
			billingInferencePolicies,
			billingPlanVersions,
			billingUsagePeriods,
			billingUsageReservations,
			opsAlertState,
		),
	);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("provenanceBuckets", () => {
	it("labels a priced Workers AI row gateway-reported and an Azure row an estimate", () => {
		const buckets = provenanceBuckets([
			{
				provider: "workers-ai",
				costBasis: "gateway_reported",
				dataQuality: "ok",
				sessionType: "tedi",
				hasCost: 1,
				hasTokens: 1,
				rowCount: 2,
				totalTokens: 100,
				costUsd: 0.5,
			},
			{
				provider: "azure-openai",
				costBasis: "governed_estimate",
				dataQuality: "ok",
				sessionType: "tedi",
				hasCost: 1,
				hasTokens: 1,
				rowCount: 3,
				totalTokens: 300,
				costUsd: 1.5,
			},
		]);
		expect(buckets.map((bucket) => bucket.provenance).sort()).toEqual([
			"gateway_reported",
			"pricing_table_estimate",
		]);
	});

	it("never emits provider_reported — nothing in this deployment produces it", () => {
		const buckets = provenanceBuckets([
			{
				provider: "workers-ai",
				costBasis: "gateway_reported",
				dataQuality: "ok",
				sessionType: "tedi",
				hasCost: 1,
				hasTokens: 1,
				rowCount: 1,
				totalTokens: 10,
				costUsd: 1,
			},
			{
				provider: "azure-openai",
				costBasis: "governed_estimate",
				dataQuality: "ok",
				sessionType: "kernel",
				hasCost: 1,
				hasTokens: 1,
				rowCount: 1,
				totalTokens: 10,
				costUsd: 1,
			},
			{
				provider: "azure-openai",
				costBasis: "governed_estimate",
				dataQuality: "quarantined_no_pricing",
				sessionType: "tedi",
				hasCost: 1,
				hasTokens: 1,
				rowCount: 1,
				totalTokens: 10,
				costUsd: 0,
				knownSubtotalUsd: 0,
			},
		]);
		expect(
			buckets.some((bucket) => bucket.provenance === "provider_reported"),
		).toBe(false);
	});

	it("preserves an explicitly recorded zero-cost Workers AI row", () => {
		const buckets = provenanceBuckets([
			{
				provider: "workers-ai",
				costBasis: "gateway_reported",
				dataQuality: "ok",
				sessionType: "tedi",
				hasCost: 1,
				hasTokens: 1,
				rowCount: 1,
				totalTokens: 40,
				costUsd: 0,
				knownSubtotalUsd: 0,
			},
		]);
		expect(buckets).toEqual([
			{
				provenance: "gateway_reported",
				rowCount: 1,
				totalTokens: 40,
				costUsd: 0,
				knownSubtotalUsd: 0,
			},
		]);
	});

	it("omits a label no row earned rather than emitting it as zero", () => {
		expect(provenanceBuckets([])).toEqual([]);
	});
});

describe("spendTotals", () => {
	it("reports quarantined value beside spend and never inside it", () => {
		const totals = spendTotals([
			{
				provenance: "pricing_table_estimate",
				rowCount: 2,
				totalTokens: 200,
				costUsd: 2,
				knownSubtotalUsd: 2,
			},
			{
				provenance: "quarantined",
				rowCount: 5,
				totalTokens: 500,
				costUsd: 9,
				knownSubtotalUsd: 9,
			},
		]);
		expect(totals.costUsd).toBeNull();
		expect(totals.knownSubtotalUsd).toBe(2);
		expect(totals.quarantinedCostUsd).toBe(9);
		expect(totals.rowCount).toBe(7);
		expect(totals.provenanceFloor).toBe("pricing_table_estimate");
	});

	it("claims no provenance for a window whose only rows are quarantined", () => {
		const totals = spendTotals([
			{
				provenance: "quarantined",
				rowCount: 3,
				totalTokens: 30,
				costUsd: 4,
				knownSubtotalUsd: 4,
			},
		]);
		expect(totals.costUsd).toBeNull();
		expect(totals.provenanceFloor).toBeNull();
	});

	it("claims only the weakest label present in a mixed window", () => {
		const totals = spendTotals([
			{
				provenance: "gateway_reported",
				rowCount: 9,
				totalTokens: 900,
				costUsd: 9,
				knownSubtotalUsd: 9,
			},
			{
				provenance: "unknown",
				rowCount: 1,
				totalTokens: 1,
				costUsd: null,
				knownSubtotalUsd: 0,
			},
		]);
		expect(totals.provenanceFloor).toBe("unknown");
	});

	it("has no provenance at all for an empty window", () => {
		expect(spendTotals([]).provenanceFloor).toBeNull();
	});
});

describe("attributionGap", () => {
	it("counts unattributed rows but excludes quarantined value from the dollar figure", () => {
		const gap = attributionGap([
			{
				provider: "azure-openai",
				costBasis: "governed_estimate",
				dataQuality: "ok",
				sessionType: "unattributed",
				hasCost: 1,
				hasTokens: 1,
				rowCount: 2,
				totalTokens: 200,
				costUsd: 3,
				knownSubtotalUsd: 3,
			},
			{
				provider: "azure-openai",
				costBasis: "governed_estimate",
				dataQuality: "quarantined_failed",
				sessionType: "unattributed",
				hasCost: 0,
				hasTokens: 0,
				rowCount: 4,
				totalTokens: 0,
				costUsd: 0,
				knownSubtotalUsd: 0,
			},
			{
				provider: "azure-openai",
				costBasis: "governed_estimate",
				dataQuality: "ok",
				sessionType: "tedi",
				hasCost: 1,
				hasTokens: 1,
				rowCount: 7,
				totalTokens: 700,
				costUsd: 8,
			},
		]);
		expect(gap.unattributedCostUsd).toBe(3);
		// The count is of rows that CONTRIBUTED the $3, not of unattributed rows
		// in general. It previously included the 4 quarantined rows, and the two
		// numbers render side by side — so a reader dividing one by the other got
		// $0.50/call when the real contributing rate is $1.50/call. Neither number
		// was wrong alone; the pair was.
		expect(gap.unattributedRowCount).toBe(2);
		expect(gap.unattributedQuarantinedRowCount).toBe(4);
		expect(gap.unattributedCostUsd / gap.unattributedRowCount).toBe(1.5);
		expect(gap.orphanedRowsVisible).toBe(false);
	});
});

describe("fallbackDetail", () => {
	it("reports a divergence without inventing a reason for it", () => {
		const detail = fallbackDetail("azure-openai/gpt-5.6-luna", ["workers-ai"]);
		expect(detail).toContain("workers-ai");
		expect(detail).toContain("unknown");
	});

	it("is null when the served provider matches the selected one", () => {
		expect(
			fallbackDetail("azure-openai/gpt-5.6-luna", ["azure-openai"]),
		).toBeNull();
	});

	it("is null when nothing served, rather than claiming a fallback", () => {
		expect(fallbackDetail("azure-openai/gpt-5.6-luna", [])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

describe("osCompute.posture — authz and tenancy", () => {
	it("admits a user with only the os:read verb", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		const result = await client(ORG, ["os:read"]).posture({ window: "7d" });
		expect(result.window).toBe("7d");
	});

	it("refuses a caller with no organization", async () => {
		await expect(client(null).posture({ window: "7d" })).rejects.toThrow();
	});

	it("never counts another organization's ledger rows", async () => {
		seedOrganization(ORG);
		seedOrganization(OTHER_ORG);
		seedTedi(TEDI, ORG);
		seedTedi(OTHER_TEDI, OTHER_ORG);
		seedPlanAndAccount(ORG);
		seedCallCost({
			id: "mine",
			organizationId: ORG,
			tediId: TEDI,
			provider: "azure-openai",
			costBasis: "governed_estimate",
			totalTokens: 100,
			estimatedCostUsd: 1,
		});
		seedCallCost({
			id: "theirs",
			organizationId: OTHER_ORG,
			tediId: OTHER_TEDI,
			provider: "azure-openai",
			costBasis: "governed_estimate",
			totalTokens: 999_999,
			estimatedCostUsd: 999,
		});
		const result = await client(ORG).posture({ window: "7d" });
		expect(result.spend.costUsd).toBe(1);
		expect(result.spend.rowCount).toBe(1);

		// Assert on the ROW too: the response schema strips unknown keys, so a
		// wire-only assertion cannot prove the other tenant's row still exists
		// and was excluded by the predicate rather than never written.
		const persisted = sqlite
			.prepare(`SELECT org_id FROM tedi_call_costs ORDER BY id`)
			.all() as Array<{ org_id: string }>;
		expect(persisted.map((row) => row.org_id)).toEqual([ORG, OTHER_ORG]);
	});
});

describe("osCompute.posture — an empty ledger is not zero", () => {
	it("reports never_ingested with no provenance, not a clean $0", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		const result = await client(ORG).posture({ window: "7d" });
		expect(result.freshness.state).toBe("never_ingested");
		expect(result.freshness.lastRowAt).toBeNull();
		expect(result.freshness.staleMinutes).toBeNull();
		expect(result.spend.provenanceFloor).toBeNull();
		expect(result.provenance).toEqual([]);
		expect(result.freshness.detail).toContain("not $0");
	});

	it("reports dark — not quiet — when the newest row is a week old", async () => {
		seedOrganization(ORG);
		seedTedi(TEDI, ORG);
		seedPlanAndAccount(ORG);
		seedCallCost({
			id: "stale",
			organizationId: ORG,
			tediId: TEDI,
			provider: "azure-openai",
			costBasis: "governed_estimate",
			totalTokens: 10,
			estimatedCostUsd: 0.1,
			snapshotAt: new Date(Date.now() - 7 * 24 * 3_600_000).toISOString(),
		});
		const result = await client(ORG).posture({ window: "30d" });
		expect(result.freshness.state).toBe("dark");
		expect(result.credentialHealth.status).toBe("unattested");
	});
});

describe("osCompute.posture — labeled gaps", () => {
	beforeEach(() => {
		seedOrganization(ORG);
		seedTedi(TEDI, ORG);
		seedPlanAndAccount(ORG);
	});

	it("keeps provider health unknown even with fresh, priced traffic", async () => {
		seedCallCost({
			id: "fresh",
			organizationId: ORG,
			tediId: TEDI,
			provider: "azure-openai",
			costBasis: "governed_estimate",
			totalTokens: 10,
			estimatedCostUsd: 0.1,
		});
		const result = await client(ORG).posture({ window: "24h" });
		expect(result.providerHealth.status).toBe("unknown");
		expect(result.credentialHealth.status).toBe("evidenced_ok");
	});

	it("reports D1 as the sole admission authority", async () => {
		const result = await client(ORG).posture({ window: "7d" });
		expect(result.admissionPolicy.state).toBe("d1_authoritative");
		expect(result.admissionPolicy.detail).toContain(
			"sole inference-admission authority",
		);
	});

	it("reports an open credential-drift condition as firing", async () => {
		sqlite
			.prepare(
				`INSERT INTO ops_alert_state (
					condition_key, severity, metric_bucket, detail, status,
					first_seen_at, last_seen_at, notify_count, created_at, updated_at
				) VALUES (?, 'P1', '1', 'Cloudflare credential drift', 'open', ?, ?, 1,
					?, ?)`,
			)
			.run(
				"cloudflare-credential-drift:tedix-api-production:ai-gateway",
				PAST_START,
				PAST_START,
				PAST_START,
				PAST_START,
			);
		const result = await client(ORG).posture({ window: "7d" });
		expect(result.credentialHealth.status).toBe("firing");
		expect(result.credentialHealth.scope).toBe("platform_ai_gateway");
	});

	it("does not read a repaired condition as currently healthy", async () => {
		sqlite
			.prepare(
				`INSERT INTO ops_alert_state (
					condition_key, severity, metric_bucket, detail, status,
					first_seen_at, last_seen_at, notify_count, created_at, updated_at
				) VALUES (?, 'P1', '1', 'Cloudflare credential drift', 'resolved', ?, ?, 1,
					?, ?)`,
			)
			.run(
				"cloudflare-credential-drift:tedix-api-production:ai-gateway",
				PAST_START,
				PAST_START,
				PAST_START,
				PAST_START,
			);
		const result = await client(ORG).posture({ window: "7d" });
		expect(result.credentialHealth.status).toBe("unattested");
	});
});

describe("osCompute.posture — budget", () => {
	it("says no budget is known rather than reporting zero remaining", async () => {
		seedOrganization(ORG);
		const result = await client(ORG).posture({ window: "7d" });
		expect(result.budget.configured).toBe(false);
		expect(result.budget.unlimitedTokenUsage).toBeNull();
		expect(result.budget.remainingIncludedTokens).toBeNull();
		expect(result.budget.usedTokens).toBeNull();
		expect(result.budget.detail).toContain("not a zero balance");
	});

	it("copies the canonical balance snapshot instead of recomputing it", async () => {
		seedOrganization(ORG);
		seedPlanAndAccount(ORG);
		const result = await client(ORG).posture({ window: "7d" });
		expect(result.budget.configured).toBe(true);
		expect(result.budget.includedTokens).toBe(1_000_000);
		expect(result.budget.unlimitedTokenUsage).toBe(false);
		expect(result.budget.usedTokens).toBe(400_000);
		expect(result.budget.remainingIncludedTokens).toBe(600_000);
	});
});

describe("osCompute current-plan customer allowance", () => {
	it.each([
		[-1, 0, 100, true],
		[0, 1, 0, true],
		[0, 1, 100, false],
		[0, 0, 0, false],
		[1000000, 1, 0, false],
	])(
		"included=%s allowed=%s price=%s unlimited=%s",
		async (included, allowed, price, expected) => {
			seedOrganization(ORG);
			seedPlanAndAccount(ORG);
			sqlite
				.prepare(
					"UPDATE billing_plan_versions SET included_monthly_tokens=?,allow_overage=?,overage_unit_price_micros=? WHERE id='plan-1'",
				)
				.run(included, allowed, price);
			const result = await client(ORG).posture({ window: "7d" });
			expect(result.budget.unlimitedTokenUsage).toBe(expected);
			expect(result.budget.includedTokens).toBe(included);
			expect(result.budget.remainingIncludedTokens).toBe(
				included! < 0 ? -1 : Math.max(included! - 400000, 0),
			);
			expect(result.budget).not.toHaveProperty("overageUnitPriceMicros");
			expect(result.budget).not.toHaveProperty("availableCreditMicros");
			expect(result.budget).not.toHaveProperty("hardSpendLimitMicros");
			seedOrganization("other-org");
			const other = await client("other-org").posture({ window: "7d" });
			expect(other.budget.unlimitedTokenUsage).toBeNull();
		},
	);
});

it("keeps different configured tenant plan semantics isolated", async () => {
	seedOrganization(ORG);
	seedPlanAndAccount(ORG);
	seedOrganization("finite-org");
	seedPlanAndAccount("finite-org");
	sqlite.exec(
		"INSERT INTO billing_plan_versions (id,plan_key,version,status,name,included_monthly_tokens,max_tedis,max_cron_jobs_per_tedi,max_iterations_per_task,default_daily_token_limit,default_daily_message_limit,effective_at,created_at) VALUES ('finite-plan','growth',2,'active','Finite',1000000,5,3,25,100000,200,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
	);
	sqlite.exec(
		"UPDATE billing_accounts SET plan_version_id='finite-plan' WHERE organization_id='finite-org'",
	);
	sqlite.exec(
		"UPDATE billing_plan_versions SET included_monthly_tokens=0,allow_overage=1,overage_unit_price_micros=0 WHERE id='plan-1'",
	);
	expect(
		(await client(ORG).posture({ window: "7d" })).budget.unlimitedTokenUsage,
	).toBe(true);
	expect(
		(await client("finite-org").posture({ window: "7d" })).budget,
	).toMatchObject({
		unlimitedTokenUsage: false,
		includedTokens: 1000000,
		remainingIncludedTokens: 600000,
	});
});
