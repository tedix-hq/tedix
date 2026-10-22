import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { billingProviderCostEvidenceVersions as evidence } from "../../schema/billing";
import { organizations } from "../../schema/organizations";
import { tediCallCosts, tedis, type NewTediCallCost } from "../../schema/tedis";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	listCostRollupDaysToBuild,
	listCostRollups,
	rebuildCostRollupDay,
} from "./cost-rollups";

const ORG = "org-rollup";
const OTHER_ORG = "org-other";
const NOW = new Date("2026-10-10T12:00:00.000Z");

function migration(name: string) {
	return readFileSync(
		new URL(`../../../drizzle/${name}/migration.sql`, import.meta.url),
		"utf8",
	);
}

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(migration("20261007112224_provider_cost_evidence"));
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(organizations, tedis, tediCallCosts));
	sqlite.exec(migration("20261022003703_billing_cost_rollups"));
	const db = createDbQueryClient(createD1Facade(sqlite));
	await db.insert(organizations).values([
		{ id: ORG, name: "Rollup Org", slug: "rollup-org" },
		{ id: OTHER_ORG, name: "Other Org", slug: "other-org" },
	]);
	await db.insert(tedis).values({
		id: "tedi-a",
		organizationId: ORG,
		name: "Ledger Helper",
		slug: "ledger-helper",
	});
	let seq = 0;
	async function call(patch: Partial<NewTediCallCost> = {}) {
		seq += 1;
		const id = patch.id ?? `call-${String(seq).padStart(3, "0")}`;
		await db.insert(tediCallCosts).values({
			id,
			orgId: ORG,
			tediId: "tedi-a",
			gatewayLogId: `log-${id}`,
			gatewayId: "gateway",
			snapshotAt: "2026-10-08T10:00:00.000Z",
			model: "model-a",
			provider: "provider-a",
			sessionType: "tedi",
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 2,
			cacheWriteTokens: 1,
			totalTokens: 18,
			estimatedCostUsd: 0.25,
			costBasis: "governed_estimate",
			sessionCount: 1,
			...patch,
		});
		return id;
	}
	return { sqlite, db, call };
}

describe("daily cost rollups", () => {
	it("folds one closed day per grain from the effective relation", async () => {
		const { db, call } = await fixture();
		await call();
		await call({ snapshotAt: "2026-10-08T23:59:59.999Z" });
		await call({
			tediId: null,
			sessionType: "unattributed",
			costBasis: "unknown",
			estimatedCostUsd: null,
			dataQuality: "quarantined_no_pricing",
		});
		await call({ costBasis: "legacy_estimate", estimatedCostUsd: 0.5 });
		await call({ snapshotAt: "2026-10-09T00:00:00.000Z" });
		await call({ snapshotAt: "2026-10-07T23:59:59.999Z" });
		await call({ orgId: OTHER_ORG, tediId: null, sessionType: "kernel" });

		await rebuildCostRollupDay(db, ORG, "2026-10-08", { now: NOW });
		const rows = await listCostRollups(db, ORG, "2026-10-01", "2026-10-09");
		expect(rows).toHaveLength(3);
		const governed = rows.find((row) => row.costBasis === "governed_estimate");
		expect(governed).toMatchObject({
			day: "2026-10-08",
			tediId: "tedi-a",
			tediName: "Ledger Helper",
			tediSlug: "ledger-helper",
			callCount: 2,
			pricedCallCount: 2,
			totalTokens: 36,
			inputTokens: 20,
			estimatedCostUsd: 0.5,
			unpricedTokens: 0,
			latestSnapshotAt: "2026-10-08T23:59:59.999Z",
			latestCallId: "call-002",
		});
		const unpriced = rows.find((row) => row.costBasis === "unknown");
		expect(unpriced).toMatchObject({
			tediId: null,
			tediName: null,
			sessionType: "unattributed",
			callCount: 1,
			pricedCallCount: 0,
			unpricedTokens: 18,
			estimatedCostUsd: 0,
		});
		await expect(
			rebuildCostRollupDay(db, ORG, "2026-10-10", { now: NOW }),
		).rejects.toThrow("not closed");
	});

	it("counts reviewed provider estimates and retained snapshots", async () => {
		const { db, call, sqlite } = await fixture();
		await call({
			id: "reviewed",
			costBasis: "unknown",
			estimatedCostUsd: null,
			dataQuality: "quarantined_no_pricing",
		});
		await db.insert(evidence).values(evidenceRow("reviewed", 125_000));
		await db.insert(evidence).values(
			evidenceRow("retired", 250_000, {
				id: "00000000-0000-4000-8000-000000000002",
				idempotencyDigest: "2".repeat(64),
				gatewayLogId: "log-retired",
			}),
		);
		await rebuildCostRollupDay(db, ORG, "2026-10-08", { now: NOW });
		const [row] = await listCostRollups(db, ORG, "2026-10-08", "2026-10-08");
		expect(row).toMatchObject({
			callCount: 2,
			pricedCallCount: 2,
			reviewedCallCount: 2,
			reviewedTokens: 36,
			reviewedCostMicros: 375_000,
			retiredCallCount: 1,
			estimatedCostUsd: 0.375,
		});
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM billing_cost_rollups").get(),
		).toEqual({ n: 1 });
	});

	it("marks a day stale on raw or evidence changes and rebuilds it", async () => {
		const { db, call, sqlite } = await fixture();
		const id = await call();
		const rebuild = () =>
			rebuildCostRollupDay(db, ORG, "2026-10-08", { now: NOW });
		const fresh = () => listCostRollups(db, ORG, "2026-10-08", "2026-10-08");

		await rebuild();
		expect(await fresh()).toHaveLength(1);
		await call({ snapshotAt: "2026-10-08T03:00:00.000Z" });
		expect(await fresh()).toHaveLength(0);

		await rebuild();
		expect((await fresh())[0]?.callCount).toBe(2);
		sqlite
			.prepare("UPDATE tedi_call_costs SET data_quality = ? WHERE id = ?")
			.run("quarantined_failed", id);
		expect(await fresh()).toHaveLength(0);

		await rebuild();
		expect((await fresh())[0]?.pricedCallCount).toBe(1);
		sqlite.prepare("DELETE FROM tedi_call_costs WHERE id = ?").run(id);
		expect(await fresh()).toHaveLength(0);

		await rebuild();
		expect(await fresh()).toHaveLength(1);
		await db.insert(evidence).values(evidenceRow("absent", 1));
		expect(await fresh()).toHaveLength(0);

		// Another organization's or another day's writes leave the day fresh.
		await rebuild();
		await call({ orgId: OTHER_ORG, tediId: null, sessionType: "kernel" });
		await call({ snapshotAt: "2026-10-07T03:00:00.000Z" });
		expect(await fresh()).toHaveLength(2);
	});

	it("lists closed organization-days without fresh rollups, newest first", async () => {
		const { db, call } = await fixture();
		await call({ snapshotAt: "2026-10-10T01:00:00.000Z" });
		await call({ snapshotAt: "2026-10-09T01:00:00.000Z" });
		await call({ snapshotAt: "2026-10-08T01:00:00.000Z" });
		await call({ snapshotAt: "2026-09-01T01:00:00.000Z" });
		await call({
			orgId: OTHER_ORG,
			tediId: null,
			sessionType: "kernel",
			snapshotAt: "2026-10-09T05:00:00.000Z",
		});

		expect(await listCostRollupDaysToBuild(db, 10, { now: NOW })).toEqual([
			{ organizationId: OTHER_ORG, day: "2026-10-09" },
			{ organizationId: ORG, day: "2026-10-09" },
			{ organizationId: ORG, day: "2026-10-08" },
		]);
		expect(await listCostRollupDaysToBuild(db, 1, { now: NOW })).toHaveLength(
			1,
		);
		await rebuildCostRollupDay(db, ORG, "2026-10-09", { now: NOW });
		expect(
			await listCostRollupDaysToBuild(db, 10, { now: NOW, lookbackDays: 40 }),
		).toEqual([
			{ organizationId: OTHER_ORG, day: "2026-10-09" },
			{ organizationId: ORG, day: "2026-10-08" },
			{ organizationId: ORG, day: "2026-09-01" },
		]);
		expect(await listCostRollupDaysToBuild(db, 0, { now: NOW })).toEqual([]);
	});
});

function evidenceRow(
	sourceCallId: string,
	micros: number,
	overrides: Partial<typeof evidence.$inferInsert> = {},
): typeof evidence.$inferInsert {
	return {
		id: "00000000-0000-4000-8000-000000000001",
		originalOrgId: ORG,
		sourceGatewayId: "gateway",
		gatewayLogId: `log-${sourceCallId}`,
		sourceCallId,
		scopeDigest: "a".repeat(64),
		originalSourceDigest: "b".repeat(64),
		occurredAt: "2026-10-08T10:00:00.000Z",
		recordedAt: "2026-10-09T01:00:00.000Z",
		provider: "provider-a",
		nativeModel: "model-a",
		nativeFactsReceiptDigest: "c".repeat(64),
		basisFactsDigest: "d".repeat(64),
		financialManifestDigest: "e".repeat(64),
		financialWorkId: "financial",
		financialSpecRevision: "spec",
		approvalProposalId: "approval",
		approvalDecisionId: "decision",
		attemptId: "attempt",
		admissionId: "admission",
		createdByActorType: "external_agent",
		createdByActorId: "actor",
		createdBySessionId: "session",
		idempotencyDigest: "f".repeat(64),
		payloadDigest: "1".repeat(64),
		originalTediId: "tedi-a",
		originalSourceSnapshot: {
			id: sourceCallId,
			orgId: ORG,
			gatewayId: "gateway",
			gatewayLogId: `log-${sourceCallId}`,
			tediId: "tedi-a",
			snapshotAt: "2026-10-08T10:00:00.000Z",
			model: "model-a",
			provider: "provider-a",
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 18,
			cacheReadTokens: 2,
			cacheWriteTokens: 1,
			costBasis: "unknown",
			estimatedCostUsd: null,
			dataQuality: "quarantined_no_pricing",
			sessionType: "tedi",
			source: "ai-gateway-log",
			sessionCount: 1,
			success: true,
			cached: false,
		},
		deploymentScope: {},
		financialManifestSnapshot: {},
		approvalDecisionSnapshot: {},
		originalSourceVersion: 1,
		inputTokens: 10,
		outputTokens: 5,
		cacheReadTokens: 2,
		cacheWriteTokens: 1,
		providerEstimatedCostMicros: micros,
		financialWorkVersion: 3,
		nativeUsageKnown: true,
		kind: "provider_estimate",
		currency: "USD",
		pricingBasis: "reported_estimate",
		reportedEstimateSnapshot: { original: true },
		reportedCostDecimal: "0.125",
		reportedReporter: "cloudflare_ai_gateway",
		...overrides,
	};
}
