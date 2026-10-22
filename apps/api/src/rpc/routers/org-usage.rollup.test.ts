import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { createDbClient, type DbClient } from "@tedix/db/client";
import { listOrgCallCostLedger } from "@tedix/db/queries/usage-ledger";
import { billingProviderCostEvidenceVersions as evidence } from "@tedix/db/schema/billing";
import { organizations } from "@tedix/db/schema/organizations";
import {
	tediCallCosts,
	tedis,
	type NewTediCallCost,
} from "@tedix/db/schema/tedis";
import { createD1Facade } from "../../../../../packages/db/src/test/d1-facade";
import { schemaDdl } from "../../../../../packages/db/src/test/schema-ddl";
import { rebuildClosedCostRollups } from "../../jobs/daily-billing-and-catalog-maintenance";
import type { BaseContext } from "../orpc";
import { orgUsageContractRouter, projectOrgUsageBreakdowns } from "./org-usage";
import {
	buildCostDrilldown,
	mergeCostDrilldowns,
	normalizeLedgerRows,
} from "./usage-ledger";

const reads = vi.hoisted(() => ({ raw: 0, rollup: 0 }));
vi.mock("@tedix/db/queries/usage-ledger", async (original) => {
	const actual =
		await original<typeof import("@tedix/db/queries/usage-ledger")>();
	return {
		...actual,
		listOrgCallCostLedger: async (
			...args: Parameters<typeof actual.listOrgCallCostLedger>
		) => {
			const rows = await actual.listOrgCallCostLedger(...args);
			reads.raw += rows.length;
			return rows;
		},
	};
});
vi.mock("@tedix/db/queries/billing/cost-rollups", async (original) => {
	const actual =
		await original<typeof import("@tedix/db/queries/billing/cost-rollups")>();
	return {
		...actual,
		listCostRollups: async (
			...args: Parameters<typeof actual.listCostRollups>
		) => {
			const rows = await actual.listCostRollups(...args);
			reads.rollup += rows.length;
			return rows;
		},
	};
});
vi.mock("@tedix/db/queries/organizations", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/organizations")>()),
	getOrganizationById: async (_db: unknown, id: string) => ({
		id,
		name: "Rollup Org",
	}),
}));
vi.mock("@tedix/db/queries/tedis", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/tedis")>()),
	getTedisByOrganization: async () => [],
}));
vi.mock("@tedix/db/queries/billing/credits", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/billing/credits")>()),
	getBillingBalanceSnapshot: async () => ({
		planKey: "growth",
		status: "active",
		includedTokens: 1_000_000,
		usedTokens: 1_000,
	}),
}));
vi.mock("@tedix/db/queries/runtime-entitlements", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/runtime-entitlements")
	>()),
	getRuntimeEntitlement: async () => ({ limits: { maxTedis: 5 } }),
}));

const ORG = "5eed0033-0000-4000-8000-000000000044";
const NOW = new Date("2026-10-10T12:00:00.000Z");

function migration(name: string) {
	return readFileSync(
		new URL(
			`../../../../../packages/db/drizzle/${name}/migration.sql`,
			import.meta.url,
		),
		"utf8",
	);
}

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(migration("20261007112224_provider_cost_evidence"));
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(organizations, tedis, tediCallCosts));
	sqlite.exec(migration("20261022003703_billing_cost_rollups"));
	const db = createDbClient(createD1Facade(sqlite));
	await db
		.insert(organizations)
		.values({ id: ORG, name: "Rollup Org", slug: "rollup-org" });
	await db.insert(tedis).values([
		{ id: "tedi-a", organizationId: ORG, name: "Ledger", slug: "ledger" },
		{ id: "tedi-z1", organizationId: ORG, name: "Quiet", slug: "quiet" },
		{ id: "tedi-z2", organizationId: ORG, name: "Idle", slug: "idle" },
	]);
	let seq = 0;
	async function call(patch: Partial<NewTediCallCost>) {
		seq += 1;
		const id = patch.id ?? `call-${String(seq).padStart(5, "0")}`;
		await db.insert(tediCallCosts).values({
			id,
			orgId: ORG,
			gatewayLogId: `log-${id}`,
			gatewayId: "gateway",
			snapshotAt: NOW.toISOString(),
			model: "model-a",
			sessionType: "tedi",
			inputTokens: 40,
			outputTokens: 20,
			cacheReadTokens: 8,
			cacheWriteTokens: 4,
			totalTokens: 72,
			costBasis: "governed_estimate",
			sessionCount: 1,
			...patch,
		});
		return id;
	}
	return { db, call };
}

/** Attribution shapes the report must keep apart, with binary-exact costs. */
const VARIANTS: Array<Partial<NewTediCallCost>> = [
	{ tediId: "tedi-a", provider: "provider-a", estimatedCostUsd: 0.25 },
	{
		tediId: null,
		sessionType: "kernel",
		model: "model-k",
		provider: "provider-k",
		providerResource: "resource-1",
		estimatedCostUsd: 0.125,
	},
	{
		tediId: null,
		sessionType: "unattributed",
		model: "",
		costBasis: "unknown",
		estimatedCostUsd: null,
		dataQuality: "quarantined_no_pricing",
	},
	{
		tediId: "tedi-gone",
		sessionType: "tedi_observer",
		provider: "provider-a",
		deployment: "deployment-x",
		costBasis: "legacy_estimate",
		estimatedCostUsd: 0.015625,
	},
	{
		tediId: "tedi-z1",
		model: "model-z",
		providerBaseUrl: "https://base.example.test",
		estimatedCostUsd: 0,
	},
	{ tediId: "tedi-z2", model: "model-z", estimatedCostUsd: 0 },
	{
		tediId: "tedi-a",
		provider: "workers-ai",
		costBasis: "gateway_reported",
		estimatedCostUsd: 0.5,
		success: false,
	},
	{
		tediId: "tedi-a",
		provider: "provider-a",
		costBasis: "legacy_estimate",
		estimatedCostUsd: -1,
	},
];
const SLOTS = [
	"T00:00:00.000Z",
	...Array.from(
		{ length: 24 },
		(_, hour) => `T${String(hour).padStart(2, "0")}:30:00.000Z`,
	),
];

/** Busy 33-day ledger around a 30-day window ending at NOW. */
async function seedLedger(
	call: (patch: Partial<NewTediCallCost>) => Promise<string>,
	variants = VARIANTS,
) {
	for (let offset = -32; offset <= 0; offset++) {
		const day = new Date(NOW.getTime() + offset * 86_400_000)
			.toISOString()
			.slice(0, 10);
		let slot = 0;
		for (const time of [...SLOTS, "T23:59:59.999Z"]) {
			for (let pick = 0; pick < 3; pick++) {
				const variant =
					variants[(offset + 40 + slot * 3 + pick) % variants.length];
				await call({ ...variant, snapshotAt: `${day}${time}` });
			}
			slot++;
		}
	}
}

function context(db: DbClient): BaseContext {
	return {
		authType: "apikey",
		organizationId: ORG,
		userRole: "owner",
		apiKey: {
			id: "key",
			name: "fictional",
			organizationId: ORG,
			scopes: ["billing:read"],
		},
		db,
		env: { ENVIRONMENT: "test", DB: {} },
		headers: new Headers(),
		url: new URL("https://api.example.test/rpc/org-usage"),
	} as unknown as BaseContext;
}

/** The pre-rollup handler: every raw row in the window, folded per page. */
async function rawLedgerUsage(
	db: DbClient,
	window: { from: string; to: string; days: number },
) {
	const parts = [];
	let cursor: { snapshotAt: string; id: string } | undefined;
	for (;;) {
		const rows = await listOrgCallCostLedger(db, {
			organizationId: ORG,
			from: window.from,
			to: window.to,
			limit: 5_000,
			cursor,
		});
		parts.push(
			buildCostDrilldown({
				rows: normalizeLedgerRows(rows),
				period: "30d",
				days: window.days,
			}),
		);
		if (rows.length < 5_000) break;
		const last = rows.at(-1);
		if (!last) break;
		cursor = { snapshotAt: last.snapshotAt, id: last.id };
	}
	return projectOrgUsageBreakdowns(
		mergeCostDrilldowns({ parts, period: "30d", days: window.days }),
	);
}

async function usage(db: DbClient, window?: { from: string; to: string }) {
	reads.raw = 0;
	reads.rollup = 0;
	const client = createRouterClient(orgUsageContractRouter, {
		context: context(db),
	});
	const result = await client.getOrgUsage({
		organizationId: ORG,
		period: "30d",
		window,
	});
	return { result, reads: { ...reads } };
}

function sections(result: Awaited<ReturnType<typeof usage>>["result"]) {
	return {
		totals: result.totals,
		daily: result.daily,
		tediBreakdown: result.tediBreakdown,
		modelBreakdown: result.modelBreakdown,
		sourceBreakdown: result.sourceBreakdown,
	};
}

/** Numbers within float summation-order noise; everything else exact. */
function expectSameMoney(actual: unknown, expected: unknown, path = "$") {
	if (typeof expected === "number" && typeof actual === "number") {
		if (Number.isInteger(expected)) expect(actual, path).toBe(expected);
		else
			expect(Math.abs(actual - expected), path).toBeLessThanOrEqual(
				1e-12 * Math.max(1, Math.abs(expected)),
			);
		return;
	}
	if (Array.isArray(expected) && Array.isArray(actual)) {
		expect(actual.length, path).toBe(expected.length);
		expected.forEach((item, index) =>
			expectSameMoney(actual[index], item, `${path}[${index}]`),
		);
		return;
	}
	if (expected && typeof expected === "object" && actual) {
		expect(Object.keys(actual).sort(), path).toEqual(
			Object.keys(expected).sort(),
		);
		for (const [key, value] of Object.entries(expected))
			expectSameMoney(
				(actual as Record<string, unknown>)[key],
				value,
				`${path}.${key}`,
			);
		return;
	}
	expect(actual, path).toEqual(expected);
}

describe("organization usage from daily rollups", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("returns the raw-ledger result for closed days, today and late rows", async () => {
		const { db, call } = await fixture();
		await seedLedger(call);
		// Reviewed provider estimate on a closed day, and one whose source is gone.
		await call({
			id: "reviewed-call",
			tediId: "tedi-a",
			snapshotAt: "2026-09-20T09:00:00.000Z",
			costBasis: "unknown",
			estimatedCostUsd: null,
			dataQuality: "quarantined_no_pricing",
		});
		await db
			.insert(evidence)
			.values([
				evidenceRow("reviewed-call", "2026-09-20T09:00:00.000Z", 375_000, 1),
				evidenceRow("retired-call", "2026-09-25T09:00:00.000Z", 62_500, 2),
			]);
		const window = {
			from: "2026-09-10T12:00:00.000Z",
			to: NOW.toISOString(),
			days: 30,
		};

		const before = await usage(db);
		expect(before.result.window).toEqual({ from: window.from, to: window.to });
		expect(sections(before.result)).toEqual(await rawLedgerUsage(db, window));
		expect(before.reads.rollup).toBe(0);

		const built = await rebuildClosedCostRollups(db, NOW);
		// 32 closed days; today stays on raw rows.
		expect(built).toEqual({ built: 32, failed: 0 });
		const after = await usage(db);
		expect(after.result).toEqual(before.result);
		expect(after.reads.raw + after.reads.rollup).toBeLessThan(
			before.reads.raw / 5,
		);
		console.info(
			`[org-usage rollup] 30-day window rows read: raw-only=${before.reads.raw} rollup path=${after.reads.raw} raw + ${after.reads.rollup} rollup`,
		);

		// Late rows and new evidence for closed days fall back to raw for that day.
		await call({
			tediId: "tedi-z2",
			snapshotAt: "2026-09-30T05:00:00.000Z",
			estimatedCostUsd: 0.75,
		});
		await call({
			tediId: null,
			sessionType: "unattributed",
			snapshotAt: "2026-10-03T23:59:59.999Z",
			costBasis: "unknown",
			estimatedCostUsd: null,
		});
		await db
			.insert(evidence)
			.values(
				evidenceRow("late-retired", "2026-10-05T10:00:00.000Z", 1_000_000, 3),
			);
		const late = await usage(db);
		expect(sections(late.result)).toEqual(await rawLedgerUsage(db, window));
		expect(late.result).not.toEqual(after.result);

		await rebuildClosedCostRollups(db, NOW);
		expect((await usage(db)).result).toEqual(late.result);
	});

	it("matches an exact billing window that starts at midnight", async () => {
		const { db, call } = await fixture();
		await seedLedger(call);
		await rebuildClosedCostRollups(db, NOW);
		const window = {
			from: "2026-09-15T00:00:00.000Z",
			to: "2026-10-05T00:00:00.000Z",
		};
		const { result } = await usage(db, window);
		expect(result.window).toEqual(window);
		expect(sections(result)).toEqual(
			await rawLedgerUsage(db, { ...window, days: 20 }),
		);
	});

	it("keeps decimal costs within summation-order noise", async () => {
		const { db, call } = await fixture();
		await seedLedger(
			call,
			VARIANTS.map((variant, index) =>
				typeof variant.estimatedCostUsd === "number" &&
				variant.estimatedCostUsd > 0
					? { ...variant, estimatedCostUsd: 0.1 * (index + 1) + 0.0007 }
					: variant,
			),
		);
		const before = await usage(db);
		await rebuildClosedCostRollups(db, NOW);
		const after = await usage(db);
		expectSameMoney(after.result, before.result);
	});
});

function evidenceRow(
	sourceCallId: string,
	snapshotAt: string,
	micros: number,
	n: number,
): typeof evidence.$inferInsert {
	return {
		id: `00000000-0000-4000-8000-00000000000${n}`,
		originalOrgId: ORG,
		sourceGatewayId: "gateway",
		gatewayLogId: `log-${sourceCallId}`,
		sourceCallId,
		scopeDigest: "a".repeat(64),
		originalSourceDigest: "b".repeat(64),
		occurredAt: snapshotAt,
		recordedAt: NOW.toISOString(),
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
		idempotencyDigest: String(n).repeat(64),
		payloadDigest: "1".repeat(64),
		originalTediId: "tedi-a",
		originalSourceSnapshot: {
			id: sourceCallId,
			orgId: ORG,
			gatewayId: "gateway",
			gatewayLogId: `log-${sourceCallId}`,
			tediId: "tedi-a",
			snapshotAt,
			model: "model-a",
			provider: "provider-a",
			inputTokens: 40,
			outputTokens: 20,
			totalTokens: 72,
			cacheReadTokens: 8,
			cacheWriteTokens: 4,
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
		inputTokens: 40,
		outputTokens: 20,
		cacheReadTokens: 8,
		cacheWriteTokens: 4,
		providerEstimatedCostMicros: micros,
		financialWorkVersion: 3,
		nativeUsageKnown: true,
		kind: "provider_estimate",
		currency: "USD",
		pricingBasis: "reported_estimate",
		reportedEstimateSnapshot: { original: true },
		reportedCostDecimal: "0.375",
		reportedReporter: "cloudflare_ai_gateway",
	};
}
