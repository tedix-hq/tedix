import { describe, expect, test } from "vite-plus/test";
import {
	buildCostDrilldown,
	type LedgerSessionType,
	mergeCostDrilldowns,
	type NormalizedLedgerRow,
	normalizeLedgerRows,
} from "./usage-ledger";

function row(
	overrides: Partial<NormalizedLedgerRow> & {
		id: string;
		sessionType: LedgerSessionType;
		totalTokens: number;
		estimatedCostUsd: number | null;
	},
) {
	return {
		providerCostEvidence: overrides.providerCostEvidence ?? null,
		sourceRetired: overrides.sourceRetired ?? false,
		costBasis: overrides.costBasis ?? "legacy_estimate",
		rateVersionId: null,
		callDurationMs: overrides.callDurationMs ?? null,
		executionId: overrides.executionId ?? null,
		costReason: null,
		id: overrides.id,
		tediId: overrides.tediId ?? "tedi-1",
		tediName: overrides.tediName ?? "CTO",
		tediSlug: overrides.tediSlug ?? "cto",
		snapshotAt: overrides.snapshotAt ?? "2026-05-18T10:00:00.000Z",
		model: overrides.model ?? "gpt-5.6-terra",
		provider:
			"provider" in overrides
				? (overrides.provider ?? null)
				: "azure-openai-responses",
		providerResource:
			"providerResource" in overrides
				? (overrides.providerResource ?? null)
				: "tedix",
		providerBaseUrl:
			"providerBaseUrl" in overrides
				? (overrides.providerBaseUrl ?? null)
				: null,
		deployment:
			"deployment" in overrides
				? (overrides.deployment ?? null)
				: "gpt-5.6-terra",
		runId: overrides.runId ?? null,
		workItemId: overrides.workItemId ?? null,
		sessionKeyHash: null,
		sessionType: overrides.sessionType,
		source: overrides.source ?? "ai-gateway-log",
		inputTokens: overrides.inputTokens ?? Math.floor(overrides.totalTokens / 2),
		outputTokens: overrides.outputTokens ?? 100,
		cacheReadTokens:
			overrides.cacheReadTokens ??
			overrides.totalTokens -
				Math.floor(overrides.totalTokens / 2) -
				(overrides.outputTokens ?? 100),
		cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
		totalTokens: overrides.totalTokens,
		estimatedCostUsd: overrides.estimatedCostUsd,
		dataQuality: overrides.dataQuality ?? "ok",
		sessionCount: overrides.sessionCount ?? 1,
		createdAt: overrides.createdAt ?? null,
	};
}

describe("usage ledger drilldown", () => {
	test("retains org-scoped platform rows without a tedi", () => {
		const source = {
			...row({
				id: "platform",
				sessionType: "unattributed",
				totalTokens: 1_000,
				estimatedCostUsd: 0.01,
			}),
			tediId: null,
			tediName: null,
			tediSlug: null,
		};

		expect(normalizeLedgerRows([source])[0]).toMatchObject({
			tediId: "unattributed",
			tediName: "Unattributed",
			tediSlug: "unattributed",
		});
	});

	test("preserves Jev duration and execution identity for authorized ledger reads", () => {
		const [normalized] = normalizeLedgerRows([
			row({
				id: "jev",
				sessionType: "kernel",
				totalTokens: 100,
				estimatedCostUsd: 0.00001,
				callDurationMs: 412.5,
				executionId: "jev-execution-1",
			}),
		]);
		expect(normalized).toMatchObject({
			callDurationMs: 412.5,
			executionId: "jev-execution-1",
		});
	});

	test("normalizes rows into stable billing categories by sessionType", () => {
		const rows = normalizeLedgerRows([
			row({
				id: "main",
				sessionType: "tedi",
				totalTokens: 10_000,
				estimatedCostUsd: 1,
			}),
			row({
				id: "kernel",
				sessionType: "kernel",
				totalTokens: 3_000,
				estimatedCostUsd: 0.3,
			}),
			row({
				id: "unattributed",
				sessionType: "unattributed",
				totalTokens: 20_000,
				estimatedCostUsd: 2,
			}),
		]);

		expect(rows.map((entry) => entry.billingCategory).sort()).toEqual([
			"kernel",
			"main_agent",
			"unattributed",
		]);
		expect(
			rows.every(
				(entry) => entry.attributionVersion === "immutable-execution-v3",
			),
		).toBe(true);
	});

	test("builds billing-grade drilldowns by category, source, model, resource, and day", () => {
		const rows = normalizeLedgerRows([
			row({
				id: "main",
				sessionType: "tedi",
				totalTokens: 10_000,
				estimatedCostUsd: 1,
			}),
			row({
				id: "cmo",
				sessionType: "tedi",
				tediId: "tedi-2",
				tediName: "CMO",
				tediSlug: "cmo",
				totalTokens: 1_000,
				estimatedCostUsd: 0.1,
			}),
			row({
				id: "kernel",
				sessionType: "kernel",
				snapshotAt: "2026-05-18T09:00:00.000Z",
				totalTokens: 5_000,
				estimatedCostUsd: 0.5,
			}),
			row({
				id: "unattributed",
				sessionType: "unattributed",
				snapshotAt: "2026-05-17T10:00:00.000Z",
				totalTokens: 20_000,
				estimatedCostUsd: 2,
			}),
		]);

		const drilldown = buildCostDrilldown({
			rows,
			period: "24h",
			days: 1,
		});

		expect(drilldown.totals.totalTokens).toBe(36_000);
		expect(drilldown.totals.billableTokens).toBe(36_000);
		expect(drilldown.totals.billableCostUsd).toBeCloseTo(3.6, 8);
		expect(drilldown.totals.quarantinedTokens).toBe(0);
		expect(drilldown.totals.unattributedCostUsd).toBe(2);
		expect(drilldown.billing.invoiceReady).toBe(true);
		expect(drilldown.billing.projectedMonthlyCostUsd).toBeCloseTo(108, 8);
		expect(drilldown.billing.unattributedShare).toBeCloseTo(2 / 3.6, 8);
		expect(drilldown.byCategory.map((entry) => entry.billingCategory)).toEqual([
			"unattributed",
			"main_agent",
			"kernel",
		]);
		expect(drilldown.bySource[0]?.source).toBe("ai-gateway-log");
		expect(drilldown.byTedi[0]?.tediSlug).toBe("cto");
		expect(drilldown.byModel[0]?.model).toBe("gpt-5.6-terra");
		expect(drilldown.byResource[0]?.providerResource).toBe("tedix");
		expect(drilldown.daily.map((entry) => entry.date)).toEqual([
			"2026-05-17",
			"2026-05-18",
		]);
	});

	test("merges paged aggregates into the same complete-window totals and quality", () => {
		const rows = normalizeLedgerRows([
			row({
				id: "newest",
				sessionType: "tedi",
				totalTokens: 10_000,
				estimatedCostUsd: 1,
			}),
			{
				...row({
					id: "unattributed",
					sessionType: "unattributed",
					totalTokens: 5_000,
					estimatedCostUsd: 0.5,
				}),
				tediId: null,
				tediName: null,
				tediSlug: null,
			},
			row({
				id: "failed",
				sessionType: "tedi",
				tediId: "tedi-2",
				tediName: "CMO",
				tediSlug: "cmo",
				totalTokens: 0,
				estimatedCostUsd: 0,
				dataQuality: "quarantined_failed",
			}),
			row({
				id: "oldest",
				sessionType: "kernel",
				snapshotAt: "2026-05-17T10:00:00.000Z",
				totalTokens: 2_000,
				estimatedCostUsd: 0.2,
			}),
		]);
		const complete = buildCostDrilldown({
			rows,
			period: "24h",
			days: 1,
		});
		const merged = mergeCostDrilldowns({
			parts: [
				buildCostDrilldown({
					rows: rows.slice(0, 2),
					period: "24h",
					days: 1,
				}),
				buildCostDrilldown({
					rows: rows.slice(2),
					period: "24h",
					days: 1,
				}),
			],
			period: "24h",
			days: 1,
		});

		expect(merged.totals).toEqual(complete.totals);
		expect(merged.billing).toEqual(complete.billing);
		expect(merged.dataQuality).toEqual(complete.dataQuality);
		expect(merged.byTedi).toEqual(complete.byTedi);
		expect(merged.bySource).toEqual(complete.bySource);
		expect(merged.byCategory).toEqual(complete.byCategory);
		expect(merged.byModel).toEqual(complete.byModel);
		expect(merged.byResource).toEqual(complete.byResource);
		expect(merged.daily).toEqual(complete.daily);
	});

	test("preserves historical zero-cost evidence without read-time repricing", () => {
		const rows = normalizeLedgerRows([
			row({
				id: "gemini",
				sessionType: "tedi",
				model: "gemini-3.1-pro-preview",
				provider: "google-generative-ai",
				providerResource: "google-ai-studio",
				deployment: "gemini-3.1-pro-preview",
				totalTokens: 200_000,
				estimatedCostUsd: 0,
			}),
		]);

		const drilldown = buildCostDrilldown({
			rows,
			period: "24h",
			days: 1,
		});

		expect(rows[0]).toMatchObject({
			costBasis: "legacy_estimate",
			rawEstimatedCostUsd: 0,
			billable: true,
			invoiceReady: true,
			reconciliationStatus: "ready",
			reconciliationReasons: [],
			quarantinedTokens: 0,
		});
		expect(rows[0]?.estimatedCostUsd).toBe(0);
		expect(drilldown.billing.invoiceReady).toBe(true);
		expect(drilldown.totals.invoiceReadyTokens).toBe(200_000);
		expect(drilldown.totals.quarantinedTokens).toBe(0);
		expect(drilldown.dataQuality.zeroCostTokenShare).toBe(0);
		expect(
			drilldown.dataQuality.issues.map((issue) => issue.code),
		).not.toContain("unpriced_tokens");
	});

	test("reports data-quality debt for unpriced, unknown-model, and ingestion-quarantined rows", () => {
		const rows = normalizeLedgerRows([
			row({
				id: "good",
				sessionType: "tedi",
				totalTokens: 10_000,
				estimatedCostUsd: 1,
			}),
			row({
				id: "unknown",
				costBasis: "unknown",
				sessionType: "tedi",
				model: "unknown",
				provider: null,
				providerResource: null,
				providerBaseUrl: null,
				deployment: null,
				totalTokens: 5_000,
				estimatedCostUsd: null,
			}),
			row({
				// Failed AI Gateway calls carry zero tokens/cost per the ingestion
				// mapping — only the dataQuality flag distinguishes them.
				id: "failed",
				sessionType: "tedi",
				totalTokens: 0,
				estimatedCostUsd: 0,
				dataQuality: "quarantined_failed",
			}),
		]);

		const drilldown = buildCostDrilldown({
			rows,
			period: "24h",
			days: 1,
		});

		expect(drilldown.dataQuality.level).toBe("critical");
		expect(drilldown.billing.invoiceReady).toBe(false);
		expect(drilldown.dataQuality.issueRowCount).toBe(2);
		expect(drilldown.totals.billableTokens).toBe(10_000);
		expect(drilldown.totals.quarantinedTokens).toBe(5_000);
		expect(rows.find((entry) => entry.id === "unknown")).toMatchObject({
			billable: false,
			invoiceReady: false,
			reconciliationStatus: "quarantined",
		});
		expect(
			rows.find((entry) => entry.id === "unknown")?.reconciliationReasons,
		).toEqual(expect.arrayContaining(["unknown_model", "unpriced_tokens"]));
		expect(
			rows.find((entry) => entry.id === "failed")?.reconciliationReasons,
		).toEqual(["unpriced_tokens", "ingestion_quarantined"]);
		expect(drilldown.dataQuality.issues.map((issue) => issue.code)).toContain(
			"unpriced_tokens",
		);
		expect(drilldown.dataQuality.issues.map((issue) => issue.code)).toContain(
			"unknown_model",
		);
		expect(drilldown.dataQuality.issues.map((issue) => issue.code)).toContain(
			"ingestion_quarantined",
		);
		expect(drilldown.dataQuality.recentProblemRows[0]?.flags).toContain(
			"unknown_model",
		);
	});
});

/**
 * A failing ingestion cron that swallows AI Gateway fetch errors leaves
 * `tedi_call_costs` empty, and `get_cost_drilldown` would then report zero
 * usage with a clean data-quality score while the org is busy.
 *
 * An empty ledger is indistinguishable from a fully broken pipeline, so it must
 * never be reported as clean or invoice-ready. It also silently neutered
 * `cost-latency-anomaly-watcher` ("alert if spend is 2x the 7-day baseline" —
 * both sides read 0, so it could never fire).
 */
describe("usage ledger — an EMPTY ledger is not a CLEAN ledger", () => {
	const empty = () => buildCostDrilldown({ rows: [], period: "7d", days: 7 });

	test("zero rows do NOT score as healthy", () => {
		const d = empty();
		expect(d.dataQuality.rowCount).toBe(0);
		expect(d.dataQuality.level).not.toBe("ok");
		expect(d.dataQuality.score).toBe(0);
	});

	test("zero rows raise an explicit empty_ledger issue", () => {
		const codes = empty().dataQuality.issues.map((i) => i.code);
		expect(codes).toContain("empty_ledger");
	});

	test("an empty ledger is never invoice-ready (never bill $0 off a broken pipeline)", () => {
		expect(empty().billing.invoiceReady).toBe(false);
	});

	test("the recommendation points at the ingestion cron, not at 'clean'", () => {
		const recs = empty().dataQuality.recommendations.join(" ");
		expect(recs).toMatch(/ingestion/i);
		expect(recs).not.toMatch(/clean/i);
	});

	test("a NON-empty clean ledger still reports ok/1 (no false alarm)", () => {
		const d = buildCostDrilldown({
			rows: normalizeLedgerRows([
				row({
					id: "ok",
					sessionType: "tedi",
					totalTokens: 1_000,
					estimatedCostUsd: 0.1,
				}),
			]),
			period: "7d",
			days: 7,
		});
		expect(d.dataQuality.level).toBe("ok");
		expect(d.dataQuality.score).toBe(1);
		expect(d.billing.invoiceReady).toBe(true);
	});
});

describe("reviewed provider estimates stay nonpayable", () => {
	test.each(["ok", "quarantined_no_pricing"] as const)(
		"retains raw provenance and original held cost with quality %s",
		(dataQuality) => {
			const input = row({
				id: "reviewed",
				sessionType: "tedi",
				totalTokens: 100,
				estimatedCostUsd: null,
				dataQuality,
				costBasis: "unknown",
				providerCostEvidence: {
					versionId: "00000000-0000-4000-8000-000000000001",
					pricingBasis: "reported_estimate",
					providerEstimatedCostMicros: 33199,
					basisFactsDigest: "a".repeat(64),
					sourceSnapshotDigest: "b".repeat(64),
					effectiveCostBasis: "reviewed_provider_estimate",
					originalCostBasis: "unknown",
					originalCostReason: "missing-price",
					originalDataQuality: "quarantined_no_pricing",
					originalEstimatedCostUsd: null,
				},
				sourceRetired: true,
			});
			const normalized = normalizeLedgerRows([input]);
			expect(normalized[0]).toMatchObject({
				estimatedCostUsd: 0.033199,
				rawEstimatedCostUsd: null,
				costBasis: "unknown",
				billable: false,
				invoiceReady: false,
				quarantinedTokens: 100,
				quarantinedCostUsd: 0,
				sourceRetired: true,
			});
			const drilldown = buildCostDrilldown({
				rows: normalized,
				period: "24h",
				now: new Date("2026-05-19T00:00:00Z"),
			});
			expect(drilldown.totals).toMatchObject({
				reviewedEstimateRowCount: 1,
				reviewedEstimateTokens: 100,
				reviewedEstimateMicros: 33199,
				sourceRetiredRowCount: 1,
				billableCostUsd: 0,
				invoiceReadyCostUsd: 0,
				quarantinedTokens: 100,
				quarantinedCostUsd: 0,
			});
		},
	);
});
