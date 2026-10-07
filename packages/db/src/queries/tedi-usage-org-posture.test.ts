import { billingProviderCostEvidenceVersions } from "../schema/billing";
/**
 * The org-scoped compute-posture reads exist BECAUSE the platform-wide probe
 * next to them is not safe for a tenant surface: a busy platform would mask a
 * tenant whose rows stopped arriving, and another tenant's spend would appear
 * as this one's. Every test here is about the ownership predicate and about
 * keeping the raw discriminators intact so exactly one classifier decides
 * provenance.
 *
 * Fixture discipline: rows are inserted with the columns `ingestGatewayLogCosts`
 * writes (`apps/api/src/jobs/gateway-cost-ingestion.ts`), including the
 * `provider`/`data_quality`/`session_type` values it emits, and a NULL `org_id`
 * row for the one case the `require_org_id_for_attributed_calls` trigger
 * permits — an unattributed row with no organization.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { tediCallCosts } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getCostLedgerFreshness,
	getOrgCallCostProvenanceGroups,
	getOrgCostLedgerFreshness,
} from "./tedi-usage";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-08-13T12:00:00.000Z");
const WINDOW_FROM = new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString();

function fixture(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(tediCallCosts, billingProviderCostEvidenceVersions));
	return { db: createDbClient(createD1Facade(sqlite)) as DbClient, sqlite };
}

let seq = 0;
function insertCost(
	sqlite: DatabaseSync,
	input: {
		orgId: string | null;
		provider: string | null;
		dataQuality?: "ok" | "quarantined_no_pricing" | "quarantined_failed";
		sessionType?: "tedi" | "tedi_observer" | "kernel" | "unattributed";
		totalTokens?: number;
		estimatedCostUsd?: number | null;
		minutesAgo?: number;
	},
) {
	seq++;
	sqlite
		.prepare(
			`INSERT INTO tedi_call_costs (
				id, tedi_id, org_id, gateway_log_id, gateway_id, snapshot_at, model,
				provider, session_type, source, input_tokens, output_tokens,
				cache_read_tokens, cache_write_tokens, total_tokens,
				estimated_cost_usd, session_count, success, cached, data_quality
			) VALUES (?, 'tedi-1', ?, ?, 'tedix-llm-production', ?, 'gpt-5.6-luna',
				?, ?, 'ai-gateway-log', ?, 0, 0, 0, ?, ?, 1, 1, 0, ?)`,
		)
		.run(
			`cost-${seq}`,
			input.orgId,
			`log-${seq}`,
			new Date(NOW - (input.minutesAgo ?? 5) * 60_000).toISOString(),
			input.provider,
			input.sessionType ?? "tedi",
			input.totalTokens ?? 0,
			input.totalTokens ?? 0,
			input.estimatedCostUsd === undefined ? 0 : input.estimatedCostUsd,
			input.dataQuality ?? "ok",
		);
}

describe("getOrgCostLedgerFreshness", () => {
	it("never lets another organization's rows make this one look fresh", async () => {
		const { db, sqlite } = fixture();
		insertCost(sqlite, {
			orgId: OTHER_ORG,
			provider: "azure-openai",
			minutesAgo: 1,
		});
		insertCost(sqlite, {
			orgId: ORG,
			provider: "azure-openai",
			minutesAgo: 5 * 24 * 60,
		});

		const scoped = await getOrgCostLedgerFreshness(db, ORG, NOW);
		expect(scoped.count30d).toBe(1);
		expect(Date.parse(scoped.maxSnapshotAt as string)).toBe(
			NOW - 5 * 24 * 60 * 60_000,
		);

		// The platform probe deliberately sees both — that is exactly why it is
		// not the read a tenant surface may use.
		const platform = await getCostLedgerFreshness(db, NOW);
		expect(platform.count30d).toBe(2);
		expect(Date.parse(platform.maxSnapshotAt as string)).toBe(NOW - 60_000);
	});

	it("reports no rows for an organization with none, rather than the platform's", async () => {
		const { db, sqlite } = fixture();
		insertCost(sqlite, { orgId: OTHER_ORG, provider: "azure-openai" });
		const scoped = await getOrgCostLedgerFreshness(db, ORG, NOW);
		expect(scoped).toEqual({
			maxSnapshotAt: null,
			count24h: 0,
			count30d: 0,
		});
	});
});

describe("getOrgCallCostProvenanceGroups", () => {
	it("excludes other organizations and rows with no organization at all", async () => {
		const { db, sqlite } = fixture();
		insertCost(sqlite, {
			orgId: ORG,
			provider: "azure-openai",
			totalTokens: 100,
			estimatedCostUsd: 1,
		});
		insertCost(sqlite, {
			orgId: OTHER_ORG,
			provider: "azure-openai",
			totalTokens: 999,
			estimatedCostUsd: 99,
		});
		// The one row shape the DB trigger permits without an organization. It is
		// genuinely orphaned spend, and it is INVISIBLE to every org-scoped read —
		// which is why the contract reports unattributed cost as a floor.
		insertCost(sqlite, {
			orgId: null,
			provider: "azure-openai",
			sessionType: "unattributed",
			totalTokens: 500,
			estimatedCostUsd: 5,
		});

		const groups = await getOrgCallCostProvenanceGroups(db, ORG, WINDOW_FROM);
		expect(groups).toEqual([
			{
				costBasis: "legacy_estimate",
				provider: "azure-openai",
				dataQuality: "ok",
				sessionType: "tedi",
				hasCost: 1,
				hasTokens: 1,
				rowCount: 1,
				totalTokens: 100,
				costUsd: 1,
			},
		]);

		// Assert on the ROWS, not only the query result: all three persisted, so
		// the two absences above are the predicate working rather than a failed
		// insert.
		const persisted = sqlite
			.prepare(`SELECT COUNT(*) AS n FROM tedi_call_costs`)
			.get() as { n: number };
		expect(persisted.n).toBe(3);
	});

	it("keeps the discriminators separate instead of pre-collapsing them", async () => {
		const { db, sqlite } = fixture();
		insertCost(sqlite, {
			orgId: ORG,
			provider: "workers-ai",
			totalTokens: 50,
			estimatedCostUsd: 0.5,
		});
		insertCost(sqlite, {
			orgId: ORG,
			provider: "workers-ai",
			totalTokens: 50,
			estimatedCostUsd: null,
		});
		insertCost(sqlite, {
			orgId: ORG,
			provider: "azure-openai",
			dataQuality: "quarantined_no_pricing",
			totalTokens: 70,
			estimatedCostUsd: 0,
		});
		insertCost(sqlite, {
			orgId: ORG,
			provider: "azure-openai",
			sessionType: "unattributed",
			totalTokens: 20,
			estimatedCostUsd: 0.2,
		});

		const groups = await getOrgCallCostProvenanceGroups(db, ORG, WINDOW_FROM);
		expect(groups).toHaveLength(4);
		// A priced and an unpriced Workers AI row must NOT share a group: they
		// classify differently (gateway-reported vs unknown) and a shared group
		// would force one label onto both.
		const workersAi = groups.filter((g) => g.provider === "workers-ai");
		expect(workersAi.map((g) => g.hasCost).sort()).toEqual([0, 1]);
		expect(
			groups.some(
				(g) => g.dataQuality === "quarantined_no_pricing" && g.rowCount === 1,
			),
		).toBe(true);
		expect(
			groups.some((g) => g.sessionType === "unattributed" && g.costUsd === 0.2),
		).toBe(true);
	});

	it("excludes rows older than the window", async () => {
		const { db, sqlite } = fixture();
		insertCost(sqlite, {
			orgId: ORG,
			provider: "azure-openai",
			totalTokens: 10,
			estimatedCostUsd: 1,
			minutesAgo: 30 * 24 * 60,
		});
		expect(await getOrgCallCostProvenanceGroups(db, ORG, WINDOW_FROM)).toEqual(
			[],
		);
	});
});
