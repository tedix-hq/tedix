import type { OpsAlertStateRow } from "@tedix/db/schema/ops-alert-state";
import { describe, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
import * as projectionQueries from "@tedix/db/queries/graph-projection";
import {
	billingSettlementHealthConditions,
	buildHealthDigest,
	collectHealthConditions,
	filterHealthDigestOwnedAlertStates,
	graphProjectionConsumerHealthConditions,
	type HealthCondition,
	mcpScanOperationalConditions,
	reconcileHealthConditions,
} from "./health-digest";

vi.mock("@tedix/db/queries/graph-projection", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/graph-projection")
	>()),
	listGraphProjectionConsumerHealth: vi.fn(),
}));

const NOW = "2026-07-27T08:00:00.000Z";

function openState(
	overrides: Partial<OpsAlertStateRow> & { conditionKey: string },
): OpsAlertStateRow {
	return {
		severity: "P1",
		metricBucket: "1",
		detail: "prior detail",
		status: "open",
		firstSeenAt: "2026-07-20T08:00:00.000Z",
		lastSeenAt: "2026-07-26T08:00:00.000Z",
		lastNotifiedAt: "2026-07-20T08:00:00.000Z",
		notifyCount: 1,
		createdAt: "2026-07-20T08:00:00.000Z",
		updatedAt: "2026-07-26T08:00:00.000Z",
		...overrides,
	};
}

const ledgerDark: HealthCondition = {
	key: "cost-ledger-dark",
	severity: "P1",
	bucketRank: 1,
	detail: "cost ledger ingestion dark 9h",
};

describe("reconcileHealthConditions", () => {
	it("leaves immediate-probe conditions outside the daily digest lifecycle", () => {
		const credentialDrift = openState({
			conditionKey:
				"cloudflare-credential-drift:tedix-api-production:ai-gateway",
		});
		const daily = openState({ conditionKey: "cost-ledger-dark" });

		expect(
			filterHealthDigestOwnedAlertStates([credentialDrift, daily]).map(
				(state) => state.conditionKey,
			),
		).toEqual(["cost-ledger-dark"]);
	});

	it("flags a never-seen condition as NEW with a fresh notify", () => {
		const r = reconcileHealthConditions([ledgerDark], [], NOW);
		expect(r.newConditions).toHaveLength(1);
		expect(r.escalated).toHaveLength(0);
		expect(r.resolved).toHaveLength(0);
		expect(r.writes[0]).toMatchObject({
			conditionKey: "cost-ledger-dark",
			firstSeenAt: NOW,
			lastNotifiedAt: NOW,
			notifyCount: 1,
			status: "open",
		});
	});

	it("suppresses an unchanged open condition (ONGOING, no re-page)", () => {
		const prev = openState({
			conditionKey: "cost-ledger-dark",
			metricBucket: "1",
		});
		const r = reconcileHealthConditions([ledgerDark], [prev], NOW);
		expect(r.newConditions).toHaveLength(0);
		expect(r.escalated).toHaveLength(0);
		expect(r.ongoing).toHaveLength(1);
		// lastNotifiedAt preserved (no new page); lastSeenAt refreshed.
		expect(r.writes[0]?.lastNotifiedAt).toBe(prev.lastNotifiedAt);
		expect(r.writes[0]?.lastSeenAt).toBe(NOW);
		expect(r.writes[0]?.notifyCount).toBe(1);
	});

	it("re-pages an open condition only when its bucket ESCALATES", () => {
		const prev = openState({
			conditionKey: "cost-ledger-dark",
			metricBucket: "1",
		});
		const worse: HealthCondition = {
			...ledgerDark,
			bucketRank: 2,
			detail: "dark 33h",
		};
		const r = reconcileHealthConditions([worse], [prev], NOW);
		expect(r.escalated).toHaveLength(1);
		expect(r.escalated[0]?.fromDetail).toBe("prior detail");
		expect(r.writes[0]?.lastNotifiedAt).toBe(NOW);
		expect(r.writes[0]?.notifyCount).toBe(2);
		expect(r.writes[0]?.metricBucket).toBe("2");
	});

	it("does not escalate when the bucket is unchanged even if the detail moved", () => {
		const prev = openState({
			conditionKey: "cost-ledger-dark",
			metricBucket: "1",
		});
		const drift: HealthCondition = {
			...ledgerDark,
			bucketRank: 1,
			detail: "dark 11h",
		};
		const r = reconcileHealthConditions([drift], [prev], NOW);
		expect(r.escalated).toHaveLength(0);
		expect(r.ongoing).toHaveLength(1);
	});

	it("RESOLVES an open condition that is no longer firing", () => {
		const prev = openState({ conditionKey: "cron-dark:t1:brain-reflection" });
		const r = reconcileHealthConditions([], [prev], NOW);
		expect(r.resolved).toHaveLength(1);
		expect(r.resolvedKeys).toEqual(["cron-dark:t1:brain-reflection"]);
		expect(r.writes).toHaveLength(0);
	});
});

describe("buildHealthDigest", () => {
	it("returns null on a quiet non-weekly run (fire-only)", () => {
		const r = reconcileHealthConditions([], [], NOW);
		expect(
			buildHealthDigest(r, { isWeeklyHeartbeat: false, nowIso: NOW }),
		).toBeNull();
	});

	it("emits a nominal heartbeat on a quiet weekly run", () => {
		const r = reconcileHealthConditions([], [], NOW);
		const digest = buildHealthDigest(r, {
			isWeeklyHeartbeat: true,
			nowIso: NOW,
		});
		expect(digest).not.toBeNull();
		expect(digest?.subject).toContain("nominal");
		expect(digest?.text).toContain("heartbeat");
	});

	it("builds a severity-tagged subject + NEW section for a new incident", () => {
		const r = reconcileHealthConditions([ledgerDark], [], NOW);
		const digest = buildHealthDigest(r, {
			isWeeklyHeartbeat: false,
			nowIso: NOW,
		});
		expect(digest?.subject).toBe(
			"[Tedix Health] P1 · 1 issue · cost ledger ingestion dark 9h",
		);
		expect(digest?.text).toContain("NEW:");
		expect(digest?.text).toContain("[P1] cost ledger ingestion dark 9h");
	});

	it("lists STILL OPEN conditions only on the weekly run", () => {
		const prev = openState({
			conditionKey: "cost-ledger-dark",
			metricBucket: "1",
		});
		const r = reconcileHealthConditions([ledgerDark], [prev], NOW);
		expect(
			buildHealthDigest(r, { isWeeklyHeartbeat: false, nowIso: NOW }),
		).toBeNull();
		const weekly = buildHealthDigest(r, {
			isWeeklyHeartbeat: true,
			nowIso: NOW,
		});
		expect(weekly?.text).toContain("STILL OPEN:");
	});
});

describe("billingSettlementHealthConditions", () => {
	it("pages when reserved successful usage remains unsettled beyond one hour", () => {
		const conditions = billingSettlementHealthConditions(
			{
				unsettledReservedSuccessCount: 49,
				oldestUnsettledAt: "2026-07-27T05:00:00.000Z",
				latestSettledAt: null,
				nonLegacyQuarantined24h: 0,
			},
			Date.parse(NOW),
		);
		expect(conditions).toEqual([
			expect.objectContaining({
				key: "billing-settlement-dark",
				severity: "P1",
				bucketRank: 1,
			}),
		]);
		expect(conditions[0]?.detail).toContain("49 reserved successful");
		expect(conditions[0]?.detail).toContain("latest charge never");
	});

	it("ignores expected ingestion lag and reports current-row quarantine", () => {
		const conditions = billingSettlementHealthConditions(
			{
				unsettledReservedSuccessCount: 2,
				oldestUnsettledAt: "2026-07-27T07:30:00.000Z",
				latestSettledAt: "2026-07-27T07:15:00.000Z",
				nonLegacyQuarantined24h: 12,
			},
			Date.parse(NOW),
		);
		expect(conditions).toEqual([
			expect.objectContaining({
				key: "billing-settlement-quarantine",
				severity: "P2",
				bucketRank: 2,
			}),
		]);
	});
});

describe("mcpScanOperationalConditions", () => {
	const nowMs = Date.parse(NOW);
	const backlog = {
		totalEnabledMcp: 2_639,
		dueNow: 2_186,
		staleOver7d: 2_049,
	};
	const healthyRun = {
		status: "completed" as const,
		startedAt: "2026-07-27T07:40:00.000Z",
		completedAt: "2026-07-27T07:50:00.000Z",
		workflowId: "scan-current",
		output: {
			throughput: {
				scansPerMinute: 32.99,
				estimatedMinutesToClear: 67,
			},
		},
	};

	it("alerts a material seven-day backlog with persisted throughput context", () => {
		const conditions = mcpScanOperationalConditions(backlog, healthyRun, nowMs);
		expect(conditions).toEqual([
			expect.objectContaining({
				key: "mcp-scan-backlog",
				severity: "P2",
				bucketRank: 3,
			}),
		]);
		expect(conditions[0]?.detail).toContain("32.99 scans/min");
		expect(conditions[0]?.detail).toContain("67m estimated clearance");
	});

	it("alerts missing, stale, and failed scan evidence on one stable key", () => {
		const clearBacklog = { ...backlog, dueNow: 0, staleOver7d: 0 };
		expect(
			mcpScanOperationalConditions(clearBacklog, null, nowMs)[0],
		).toMatchObject({ key: "mcp-scan-dark", bucketRank: 1 });
		expect(
			mcpScanOperationalConditions(
				clearBacklog,
				{
					...healthyRun,
					startedAt: "2026-07-27T01:00:00.000Z",
					completedAt: null,
					status: "running",
				},
				nowMs,
			)[0],
		).toMatchObject({ key: "mcp-scan-dark", bucketRank: 2 });
		expect(
			mcpScanOperationalConditions(
				clearBacklog,
				{ ...healthyRun, status: "failed" },
				nowMs,
			)[0],
		).toMatchObject({ key: "mcp-scan-dark", bucketRank: 2 });
	});

	it("stays quiet for a fresh run and a small stale tail", () => {
		expect(
			mcpScanOperationalConditions(
				{ totalEnabledMcp: 2_639, dueNow: 20, staleOver7d: 24 },
				healthyRun,
				nowMs,
			),
		).toEqual([]);
	});
});

describe("graphProjectionConsumerHealthConditions", () => {
	const nowMs = Date.parse(NOW);
	const hoursAgo = (hours: number) =>
		new Date(nowMs - hours * 3_600_000).toISOString();
	const row = {
		organizationId: "org-1",
		lastSuccessAt: hoursAgo(48),
		oldestPendingAt: hoursAgo(24),
	};
	it("alerts on overdue success with pending work, independent of lease activity", () => {
		expect(graphProjectionConsumerHealthConditions([row], nowMs)).toEqual([
			expect.objectContaining({
				key: "graph-projection-stale:org-1",
				severity: "P2",
				bucketRank: 2,
			}),
		]);
	});
	it("keeps idle, fresh success, and newly pending consumers quiet", () => {
		for (const overrides of [
			{ oldestPendingAt: null },
			{ lastSuccessAt: hoursAgo(1) },
			{ oldestPendingAt: hoursAgo(1) },
			{ oldestPendingAt: hoursAgo(6) },
		])
			expect(
				graphProjectionConsumerHealthConditions(
					[{ ...row, ...overrides }],
					nowMs,
				),
			).toEqual([]);
	});
	it.each([null, "invalid", "2099-01-01T00:00:00.000Z"])(
		"uses pending age when success evidence is missing or invalid: %s",
		(lastSuccessAt) => {
			expect(
				graphProjectionConsumerHealthConditions(
					[{ ...row, lastSuccessAt }],
					nowMs,
				),
			).toHaveLength(1);
			expect(
				graphProjectionConsumerHealthConditions(
					[{ ...row, lastSuccessAt, oldestPendingAt: hoursAgo(1) }],
					nowMs,
				),
			).toEqual([]);
		},
	);
	it("reports invalid pending evidence without silently clearing it", () => {
		expect(
			graphProjectionConsumerHealthConditions(
				[{ ...row, oldestPendingAt: "invalid" }],
				nowMs,
			),
		).toEqual([
			expect.objectContaining({
				key: "graph-projection-stale:org-1",
				bucketRank: 1,
				detail: expect.stringContaining("invalid pending timestamp"),
			}),
		]);
	});
	it("deduplicates by tenant and resolves once caught up", () => {
		const conditions = graphProjectionConsumerHealthConditions(
			[row, { ...row, organizationId: "org-2" }],
			nowMs,
		);
		const previous = conditions.map((c) =>
			openState({ conditionKey: c.key, metricBucket: String(c.bucketRank) }),
		);
		expect(
			reconcileHealthConditions(conditions, previous, NOW).newConditions,
		).toEqual([]);
		const recovered = graphProjectionConsumerHealthConditions(
			[{ ...row, oldestPendingAt: null }],
			nowMs,
		);
		expect(
			reconcileHealthConditions(recovered, [previous[0]!], NOW).resolvedKeys,
		).toEqual(["graph-projection-stale:org-1"]);
	});
});

it("includes stalled consumers in the live health collector even when unrelated probes fail", async () => {
	const probe = vi
		.spyOn(projectionQueries, "listGraphProjectionConsumerHealth")
		.mockResolvedValue([
			{
				organizationId: "org-stuck",
				lastSuccessAt: "2026-07-20T08:00:00.000Z",
				oldestPendingAt: "2026-07-26T08:00:00.000Z",
			},
		]);
	const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const db = {} as DbClient;
		const conditions = await collectHealthConditions(db, Date.parse(NOW));
		expect(probe).toHaveBeenCalledWith(db);
		expect(conditions).toContainEqual(
			expect.objectContaining({ key: "graph-projection-stale:org-stuck" }),
		);
	} finally {
		probe.mockRestore();
		warnings.mockRestore();
	}
});

vi.mock("@tedix/db/queries/billing/health", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/billing/health")>()),
	getRecentProviderPricingHealth: vi.fn(),
}));
vi.mock("@tedix/db/queries/ops-alert-state", () => ({
	listOpenAlertStates: vi.fn(),
	recordAlertState: vi.fn(),
	markAlertsResolved: vi.fn(),
}));
vi.mock("./ops-alert-egress", () => ({ sendOpsAlert: vi.fn() }));
import * as pricingQueries from "@tedix/db/queries/billing/health";
import * as alertQueries from "@tedix/db/queries/ops-alert-state";
import * as fleet from "./fleet-authority";
import * as egress from "./ops-alert-egress";
import {
	providerPricingHealthConditions,
	runPlatformHealthDigest,
} from "./health-digest";

function pricingHealth(
	count = 1,
): Awaited<ReturnType<typeof pricingQueries.getRecentProviderPricingHealth>> {
	return {
		affectedRows: count,
		affectedTokens: count * 12,
		unattributedRows: count,
		unreservedRows: count,
		missingRateRows: count,
		firstObservedAt: NOW,
		lastObservedAt: NOW,
		omittedGroupCount: 0,
		groups: count
			? [
					{
						provider: "azure-openai",
						model: "model\n<script>".repeat(100),
						gatewayId: "gateway",
						providerResource: null,
						providerOrigin: null,
						deployment: null,
						reason: "missing_rate",
						rowCount: count,
						tokens: count * 12,
						unattributedCount: count,
						unreservedCount: count,
						firstObservedAt: NOW,
						lastObservedAt: NOW,
					},
				]
			: [],
	};
}

describe("recent pricing evidence digest lifecycle", () => {
	it("uses a stable bounded condition and resolves age-out without claiming historical repair", () => {
		expect(providerPricingHealthConditions(pricingHealth(0))).toEqual([]);
		const condition = providerPricingHealthConditions(pricingHealth())[0]!;
		expect(condition).toMatchObject({
			key: "provider-pricing-incomplete",
			severity: "P2",
			bucketRank: 1,
		});
		expect(condition.detail).not.toMatch(/[\n<>]/);
		expect(condition.detail.length).toBeLessThan(900);
		expect(condition.detail).toContain("not historical repair or charging");
		const created = reconcileHealthConditions([condition], [], NOW);
		expect(created.newConditions).toHaveLength(1);
		const previous = openState({
			...created.writes[0]!,
			conditionKey: condition.key,
		});
		expect(
			buildHealthDigest(
				reconcileHealthConditions([condition], [previous], NOW),
				{ isWeeklyHeartbeat: false, nowIso: NOW },
			),
		).toBeNull();
		expect(
			reconcileHealthConditions(
				providerPricingHealthConditions(pricingHealth(10)),
				[previous],
				NOW,
			).escalated,
		).toHaveLength(1);
		expect(
			providerPricingHealthConditions(pricingHealth(100))[0]?.bucketRank,
		).toBe(3);
		expect(reconcileHealthConditions([], [previous], NOW).resolvedKeys).toEqual(
			[condition.key],
		);
	});
	it.each([
		[false, true],
		[true, true],
		[true, false],
	])(
		"preserves unresolved pricing in weekly presentation (failure=%s, other incidents=%s)",
		async (failure, otherIncidents) => {
			const db = {} as DbClient;
			const availability = vi
				.spyOn(fleet, "assertFleetAuthorityAvailable")
				.mockImplementation(() => {});
			const database = vi
				.spyOn(fleet, "resolveFleetAuthorityDb")
				.mockReturnValue(db);
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			vi.mocked(
				projectionQueries.listGraphProjectionConsumerHealth,
			).mockResolvedValue([]);
			const open = [
				openState({ conditionKey: "provider-pricing-incomplete" }),
				openState({ conditionKey: "cloudflare-credential-drift:api:gateway" }),
				...(otherIncidents
					? [openState({ conditionKey: "billing-settlement-dark" })]
					: []),
			];
			vi.mocked(alertQueries.listOpenAlertStates).mockResolvedValue(open);
			vi.mocked(alertQueries.recordAlertState).mockClear();
			vi.mocked(alertQueries.markAlertsResolved).mockClear();
			vi.mocked(egress.sendOpsAlert).mockClear().mockResolvedValue({
				emailed: false,
				webhookPosted: false,
			});
			const query = vi.mocked(pricingQueries.getRecentProviderPricingHealth);
			if (failure)
				query.mockRejectedValueOnce(new Error("pricing query unavailable"));
			else query.mockResolvedValueOnce(pricingHealth(0));
			try {
				await runPlatformHealthDigest({} as CloudflareEnv, {
					scheduledTimeMs: Date.parse(NOW),
				});
				expect(query).toHaveBeenLastCalledWith(db, {
					sinceInclusive: "2026-07-26T08:00:00.000Z",
					untilExclusive: NOW,
				});
				const resolved = vi
					.mocked(alertQueries.markAlertsResolved)
					.mock.calls.flatMap((args) => args[1]);
				expect(resolved.includes("billing-settlement-dark")).toBe(
					otherIncidents,
				);
				expect(resolved).not.toContain(
					"cloudflare-credential-drift:api:gateway",
				);
				expect(resolved.includes("provider-pricing-incomplete")).toBe(!failure);
				expect(
					vi
						.mocked(alertQueries.recordAlertState)
						.mock.calls.some(
							(args) => args[1].conditionKey === "provider-pricing-incomplete",
						),
				).toBe(false);
				expect(error).toHaveBeenCalledTimes(failure ? 1 : 0);
				if (failure) {
					const sent = vi.mocked(egress.sendOpsAlert).mock.calls.at(-1)?.[1];
					expect(sent).toBeDefined();
					expect(sent!.subject).not.toMatch(/nominal|no open incidents/i);
					expect(sent!.text).not.toMatch(
						/no incidents fired|no open incidents/i,
					);
					expect(sent!.text).toContain("STILL OPEN:");
					expect(sent!.text).toContain(
						"source unavailable; still unresolved (current status unknown)",
					);
					expect(sent!.text).toContain("prior detail");
					if (!otherIncidents) expect(sent!.subject).toContain("1 open");
				}
			} finally {
				availability.mockRestore();
				database.mockRestore();
				warn.mockRestore();
				error.mockRestore();
				log.mockRestore();
			}
		},
	);
});
