/**
 * These pin the doctrine, not just the code paths. Each assertion below
 * corresponds to a claim the module's header makes about what this deployment
 * can and cannot honestly say about a dollar figure. If a future change makes
 * one of them false, the header is wrong and the surfaces built on it are
 * lying.
 */

import { describe, expect, it } from "vite-plus/test";
import {
	classifyCredentialHealth,
	classifyLedgerFreshness,
	COST_INGESTION_INTERVAL_MINUTES,
	COST_LEDGER_STALE_BUCKET_HOURS,
	COST_PROVENANCE_DETAIL,
	COST_PROVENANCE_ORDER,
	COST_PROVENANCE_PRODUCED_TODAY,
	COST_PROVENANCE_SOURCE,
	CostProvenanceSchema,
	ledgerRowProvenance,
	provenanceFloor,
} from "./cost-provenance";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");
const minutesAgo = (minutes: number) =>
	new Date(NOW - minutes * 60_000).toISOString();

describe("the provenance vocabulary", () => {
	it("covers every label with a detail and a canonical read location", () => {
		for (const label of CostProvenanceSchema.options) {
			expect(COST_PROVENANCE_DETAIL[label].length).toBeGreaterThan(0);
			expect(COST_PROVENANCE_SOURCE[label].length).toBeGreaterThan(0);
			expect(COST_PROVENANCE_ORDER).toContain(label);
		}
	});

	it("declares provider-reported unproducible — nothing here reads a provider bill", () => {
		expect(COST_PROVENANCE_PRODUCED_TODAY.provider_reported).toBe(false);
		expect(COST_PROVENANCE_DETAIL.provider_reported).toContain(
			"never provider-reported",
		);
	});
});

describe("ledgerRowProvenance", () => {
	const base = {
		costBasis: "governed_estimate" as const,
		provider: "azure-openai",
		dataQuality: "ok" as const,
		estimatedCostUsd: 1,
		totalTokens: 100,
	};

	it("quarantine wins over every other discriminator", () => {
		expect(
			ledgerRowProvenance({
				...base,
				costBasis: "gateway_reported" as const,
				provider: "workers-ai",
				dataQuality: "quarantined_failed",
			}),
		).toBe("quarantined");
		expect(
			ledgerRowProvenance({ ...base, dataQuality: "quarantined_no_pricing" }),
		).toBe("quarantined");
	});

	it("calls a priced Workers AI row gateway-reported — Cloudflare's own charge", () => {
		expect(
			ledgerRowProvenance({
				...base,
				costBasis: "gateway_reported" as const,
				provider: "workers-ai",
			}),
		).toBe("gateway_reported");
	});

	it("marks an unreported Workers AI amount unknown", () => {
		expect(
			ledgerRowProvenance({
				...base,
				costBasis: "gateway_reported" as const,
				provider: "workers-ai",
				estimatedCostUsd: null,
			}),
		).toBe("unknown");
	});

	it("calls every other priced row a pricing-table estimate, never provider-reported", () => {
		for (const provider of ["azure-openai", "anthropic", "openai", null]) {
			expect(ledgerRowProvenance({ ...base, provider })).toBe(
				"pricing_table_estimate",
			);
		}
	});

	it("refuses a basis for an unquarantined unpriced row that spent tokens", () => {
		expect(ledgerRowProvenance({ ...base, estimatedCostUsd: null })).toBe(
			"unknown",
		);
	});

	it("never returns provider_reported for any input", () => {
		for (const provider of ["workers-ai", "azure-openai", null]) {
			for (const dataQuality of [
				"ok",
				"quarantined_no_pricing",
				"quarantined_failed",
			] as const) {
				for (const estimatedCostUsd of [0, 5]) {
					for (const totalTokens of [0, 500]) {
						expect(
							ledgerRowProvenance({
								provider,
								dataQuality,
								estimatedCostUsd,
								totalTokens,
							}),
						).not.toBe("provider_reported");
					}
				}
			}
		}
	});
});

describe("provenanceFloor", () => {
	it("has no provenance for an empty mix rather than a default one", () => {
		expect(provenanceFloor([])).toBeNull();
	});

	it("claims only the weakest label present", () => {
		expect(
			provenanceFloor(["gateway_reported", "pricing_table_estimate"]),
		).toBe("pricing_table_estimate");
		expect(provenanceFloor(["gateway_reported", "unknown"])).toBe("unknown");
		expect(provenanceFloor(["unknown", "quarantined"])).toBe("quarantined");
	});
});

describe("classifyLedgerFreshness", () => {
	it("reports never_ingested BEFORE any age math, and says it is not $0", () => {
		const result = classifyLedgerFreshness(
			{ lastRowAt: null, rowsLast24h: 0, rowsLast30d: 0 },
			NOW,
		);
		expect(result.state).toBe("never_ingested");
		expect(result.staleMinutes).toBeNull();
		expect(result.detail).toContain("not $0");
	});

	it("treats a recent row as fresh within one ingestion interval", () => {
		expect(
			classifyLedgerFreshness(
				{
					lastRowAt: minutesAgo(COST_INGESTION_INTERVAL_MINUTES - 1),
					rowsLast24h: 5,
					rowsLast30d: 50,
				},
				NOW,
			).state,
		).toBe("fresh");
	});

	it("names the ordinary cron gap rather than calling it a stall", () => {
		expect(
			classifyLedgerFreshness(
				{ lastRowAt: minutesAgo(90), rowsLast24h: 5, rowsLast30d: 50 },
				NOW,
			).state,
		).toBe("ingestion_pending");
	});

	it("escalates at exactly the thresholds the platform pages on", () => {
		const [warn, dark] = COST_LEDGER_STALE_BUCKET_HOURS;
		expect(
			classifyLedgerFreshness(
				{ lastRowAt: minutesAgo(warn * 60), rowsLast24h: 0, rowsLast30d: 50 },
				NOW,
			).state,
		).toBe("lagging");
		expect(
			classifyLedgerFreshness(
				{ lastRowAt: minutesAgo(dark * 60), rowsLast24h: 0, rowsLast30d: 50 },
				NOW,
			).state,
		).toBe("dark");
	});

	it("refuses to age an unparseable timestamp", () => {
		expect(
			classifyLedgerFreshness(
				{ lastRowAt: "not-a-date", rowsLast24h: 1, rowsLast30d: 1 },
				NOW,
			).state,
		).toBe("never_ingested");
	});
});

describe("classifyCredentialHealth", () => {
	const fresh = classifyLedgerFreshness(
		{ lastRowAt: minutesAgo(2), rowsLast24h: 5, rowsLast30d: 50 },
		NOW,
	);
	const dark = classifyLedgerFreshness(
		{ lastRowAt: minutesAgo(7 * 24 * 60), rowsLast24h: 0, rowsLast30d: 50 },
		NOW,
	);

	it("an open drift condition wins over fresh ingestion", () => {
		expect(
			classifyCredentialHealth({
				alert: { status: "open", lastSeenAt: minutesAgo(1) },
				freshness: fresh,
			}).status,
		).toBe("firing");
	});

	it("evidences the credentials from arriving rows, not from an absent alarm", () => {
		const result = classifyCredentialHealth({ alert: null, freshness: fresh });
		expect(result.status).toBe("evidenced_ok");
		expect(result.observedAt).toBe(fresh.lastRowAt);
	});

	it("does NOT read a resolved condition as currently healthy", () => {
		const result = classifyCredentialHealth({
			alert: { status: "resolved", lastSeenAt: minutesAgo(60 * 24 * 30) },
			freshness: dark,
		});
		expect(result.status).toBe("unattested");
		expect(result.detail).toContain("not healthy");
	});

	it("always names its scope as the deployment, never the tenant", () => {
		expect(
			classifyCredentialHealth({ alert: null, freshness: dark }).scope,
		).toBe("platform_ai_gateway");
	});
});
