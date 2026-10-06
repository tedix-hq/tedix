/**
 * Fixture discipline: `posture()` builds the exact `ComputePosture` shape
 * `osCompute.posture` returns — every field, no invented ones. The literal
 * strings for detail text come from the contract's own constants
 * (`@tedix/api-contract/schemas/cost-provenance`) rather than being re-typed, so
 * a drift in the API's wording fails here instead of silently diverging.
 */

import type { ComputePosture } from "@tedix/api-contract/contracts/os-compute";
import {
	COST_ATTRIBUTION_GAP_DETAIL,
	COST_ADMISSION_POLICY_DETAIL,
	COST_PROVIDER_HEALTH_DETAIL,
} from "@tedix/api-contract/schemas/cost-provenance";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { USAGE_PERIOD_OPTIONS } from "@/components/kumo/segmented-control";
import { computePostureQueryOptions } from "@/lib/os-query-options";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	AttributionCard,
	BudgetCard,
	ComputePage,
	consumedShare,
	credentialLabel,
	credentialTone,
	freshnessLabel,
	freshnessTone,
	HealthCard,
	LedgerCard,
	ProvenanceCard,
	provenanceLegend,
	remainingTokensLabel,
	RoutingCard,
} from "./compute-page";

function posture(overrides: Partial<ComputePosture> = {}): ComputePosture {
	return {
		window: "7d",
		from: "2026-08-06T00:00:00.000Z",
		to: "2026-08-13T00:00:00.000Z",
		freshness: {
			state: "fresh",
			lastRowAt: "2026-08-12T23:55:00.000Z",
			staleMinutes: 5,
			rowsLast24h: 40,
			rowsLast30d: 900,
			detail: "Ingested within the last 15 minutes.",
		},
		spend: {
			knownSubtotalUsd: 1.25,
			pricedRowCount: 10 - 0,
			unpricedRowCount: 0,
			unpricedTokens: 0,
			costCompleteness: "complete",
			quarantinedKnownSubtotalUsd: 0,

			rowCount: 10,
			totalTokens: 100_000,
			costUsd: 1.25,
			quarantinedCostUsd: 0,
			quarantinedTokens: 0,
			quarantinedRowCount: 0,
			provenanceFloor: "pricing_table_estimate",
		},
		provenance: [
			{
				knownSubtotalUsd: 1.25,

				provenance: "pricing_table_estimate",
				rowCount: 10,
				totalTokens: 100_000,
				costUsd: 1.25,
			},
		],
		budget: {
			configured: true,
			includedTokens: 1_000_000,
			usedTokens: 400_000,
			reservedTokens: 1_000,
			remainingIncludedTokens: 599_000,
			allowOverage: false,
			entitlementActive: true,
			detail: "Copied from the canonical billing balance snapshot.",
		},
		routing: {
			modelRef: "azure-openai/gpt-5.6-luna",
			selectedBy: "org_default",
			detail: "Deployment default resolves the chat slot.",
			allowedCount: 6,
			deniedCount: 2,
			wiredProviders: ["azure-openai"],
			observedProviders: ["azure-openai"],
			fallbackDetail: null,
		},
		credentialHealth: {
			scope: "platform_ai_gateway",
			status: "evidenced_ok",
			observedAt: "2026-08-12T23:55:00.000Z",
			detail: "Cost rows arrived within the last ingestion interval.",
		},
		providerHealth: { status: "unknown", detail: COST_PROVIDER_HEALTH_DETAIL },
		admissionPolicy: {
			state: "d1_authoritative",
			desiredDailyTokenLimit: 5_000_000,
			desiredDailySpendLimitMicros: 25_000_000,
			detail: COST_ADMISSION_POLICY_DETAIL,
		},
		attribution: {
			unattributedCostUsd: 0,
			unattributedTokens: 0,
			unattributedRowCount: 0,
			unattributedQuarantinedRowCount: 0,
			orphanedRowsVisible: false,
			detail: COST_ATTRIBUTION_GAP_DETAIL,
		},
		...overrides,
	};
}

describe("freshnessTone / freshnessLabel", () => {
	it("tones an empty ledger as bad, not neutral — it is what a blackout looks like", () => {
		expect(freshnessTone("never_ingested")).toBe("bad");
		expect(freshnessLabel("never_ingested")).toBe("No rows ingested");
	});

	it("separates a normal ingestion gap from a stalled pipeline", () => {
		expect(freshnessTone("ingestion_pending")).toBe("warn");
		expect(freshnessTone("dark")).toBe("bad");
	});
});

describe("credentialTone / credentialLabel", () => {
	it("has no healthy state to render, only evidenced or unattested", () => {
		expect(credentialTone("evidenced_ok")).toBe("ok");
		expect(credentialTone("unattested")).toBe("unknown");
		expect(credentialTone("firing")).toBe("bad");
		expect(credentialLabel("unattested")).toContain("unattested");
	});
});

describe("remainingTokensLabel / consumedShare", () => {
	it("says no budget is known rather than showing zero remaining", () => {
		expect(
			remainingTokensLabel({
				configured: false,
				remainingIncludedTokens: null,
			}),
		).toBe("No budget known");
	});

	it("renders the unlimited sentinel as unlimited, not as a negative balance", () => {
		expect(
			remainingTokensLabel({ configured: true, remainingIncludedTokens: -1 }),
		).toBe("Unlimited");
	});

	it("has no consumed share when the denominator is unknown or unlimited", () => {
		expect(
			consumedShare({
				configured: false,
				includedTokens: null,
				usedTokens: null,
			}),
		).toBeNull();
		expect(
			consumedShare({
				configured: true,
				includedTokens: -1,
				usedTokens: 100,
			}),
		).toBeNull();
	});
});

describe("provenanceLegend", () => {
	it("keeps every label in the legend, including the one nothing can produce", () => {
		const legend = provenanceLegend([]);
		const providerReported = legend.find(
			(entry) => entry.provenance === "provider_reported",
		);
		expect(providerReported).toBeDefined();
		expect(providerReported?.producible).toBe(false);
		expect(providerReported?.bucket).toBeNull();
	});

	it("distinguishes 'no rows this window' from 'never produced here'", () => {
		const legend = provenanceLegend([]);
		const gateway = legend.find(
			(entry) => entry.provenance === "gateway_reported",
		);
		expect(gateway?.producible).toBe(true);
		expect(gateway?.bucket).toBeNull();
	});
});

describe("LedgerCard", () => {
	it("renders an empty ledger as an absence with the blackout warning", () => {
		const html = renderToStaticMarkup(
			<LedgerCard
				posture={posture({
					freshness: {
						state: "never_ingested",
						lastRowAt: null,
						staleMinutes: null,
						rowsLast24h: 0,
						rowsLast30d: 0,
						detail:
							"No cost rows in the last 30 days. This is indistinguishable from a stalled ingestion job, so no spend can be attested for this workspace — it is not $0.",
					},
					spend: {
						knownSubtotalUsd: 0,
						pricedRowCount: 0 - 0,
						unpricedRowCount: 0,
						unpricedTokens: 0,
						costCompleteness: "complete",
						quarantinedKnownSubtotalUsd: 0,

						rowCount: 0,
						totalTokens: 0,
						costUsd: null,
						quarantinedCostUsd: 0,
						quarantinedTokens: 0,
						quarantinedRowCount: 0,
						provenanceFloor: null,
					},
					provenance: [],
				})}
			/>,
		);
		expect(html).toContain("No rows ingested");
		expect(html).toContain('data-cost-kind="absent"');
		expect(html).toContain("it is not $0");
	});

	it("reports quarantined rows beside the amount, never inside it", () => {
		const html = renderToStaticMarkup(
			<LedgerCard
				posture={posture({
					spend: {
						knownSubtotalUsd: 1.25,
						pricedRowCount: 12 - 2,
						unpricedRowCount: 2,
						unpricedTokens: 0,
						costCompleteness: "partial",
						quarantinedKnownSubtotalUsd: 0.4,

						rowCount: 12,
						totalTokens: 100_000,
						costUsd: 1.25,
						quarantinedCostUsd: 0.4,
						quarantinedTokens: 20_000,
						quarantinedRowCount: 2,
						provenanceFloor: "pricing_table_estimate",
					},
				})}
			/>,
		);
		expect(html).toContain("$1.25");
		expect(html).toContain("not part of the amount above");
	});
});

describe("ProvenanceCard", () => {
	it("uses one Kumo progressive disclosure at every viewport", () => {
		const html = renderToStaticMarkup(<ProvenanceCard posture={posture()} />);
		expect(html).toContain('data-kumo-component="CollapsibleTrigger"');
		expect(html).toContain("max-sm:min-h-11");
		expect(html).not.toContain("sm:hidden");
		expect(html).not.toContain("hidden gap-2 sm:grid");
		expect(html).toContain("5 sources");
	});

	it("states that provider-reported is never produced here", () => {
		const html = renderToStaticMarkup(<ProvenanceCard posture={posture()} />);
		expect(html).toContain("never produced here");
		expect(html).toContain("provider reported");
	});

	// The legend sits two lines under the headline chip. When the chip correctly
	// refused to price unknown/quarantined rows, the legend priced the SAME rows
	// at $0.0000 — the page contradicted itself about the same window.
	it("does not price the buckets whose whole meaning is that no price resolved", () => {
		const html = renderToStaticMarkup(
			<ProvenanceCard
				posture={posture({
					provenance: [
						{
							knownSubtotalUsd: 0,

							provenance: "unknown",
							rowCount: 1,
							totalTokens: 5000,
							costUsd: null,
						},
						{
							knownSubtotalUsd: 0,

							provenance: "quarantined",
							rowCount: 2,
							totalTokens: 900,
							costUsd: null,
						},
					],
				})}
			/>,
		);
		expect(html).not.toContain("$0.0000");
		expect(html).toContain("amount unknown");
		expect(html).toContain("5,000 tokens");
	});

	// The exact shape production carries: 5 `quarantined_failed` rows that never
	// got far enough to spend a token. Cost 0 AND tokens 0 — and still not $0.00,
	// because a bucket that exists BECAUSE no price resolved has an unknown
	// held-out value, not a zero one.
	it("does not price a quarantined bucket that has neither cost nor tokens", () => {
		const html = renderToStaticMarkup(
			<ProvenanceCard
				posture={posture({
					provenance: [
						{
							knownSubtotalUsd: 0,

							provenance: "quarantined",
							rowCount: 5,
							totalTokens: 0,
							costUsd: null,
						},
					],
				})}
			/>,
		);
		expect(html).toContain("amount unknown");
		expect(html).not.toContain("$0.00");
	});

	it("still prints a real amount for a bucket that has one", () => {
		const html = renderToStaticMarkup(
			<ProvenanceCard
				posture={posture({
					provenance: [
						{
							knownSubtotalUsd: 0.0777,

							provenance: "gateway_reported",
							rowCount: 3,
							totalTokens: 900,
							costUsd: 0.0777,
						},
					],
				})}
			/>,
		);
		expect(html).toContain("$0.0777");
	});
});

describe("BudgetCard", () => {
	it("says consumption is unknown rather than zero when no account exists", () => {
		const html = renderToStaticMarkup(
			<BudgetCard
				posture={posture({
					budget: {
						configured: false,
						includedTokens: null,
						usedTokens: null,
						reservedTokens: null,
						remainingIncludedTokens: null,
						allowOverage: null,
						entitlementActive: null,
						detail: "No billing account is configured.",
					},
				})}
			/>,
		);
		expect(html).toContain("No budget known");
		expect(html).toContain("Consumption is unknown, not zero.");
	});

	it("warns when the admission gate is closed", () => {
		const html = renderToStaticMarkup(
			<BudgetCard
				posture={posture({
					budget: { ...posture().budget, entitlementActive: false },
				})}
			/>,
		);
		expect(html).toContain("Runtime inference is not admitted");
	});
});

describe("RoutingCard", () => {
	it("shows a detected fallback without inventing a reason for it", () => {
		const html = renderToStaticMarkup(
			<RoutingCard
				posture={posture({
					routing: {
						...posture().routing,
						observedProviders: ["workers-ai"],
						fallbackDetail:
							"Calls in this window were served by workers-ai while the model catalog selects azure-openai/gpt-5.6-luna. Runtime fallback is not recorded durably — the only breaker is an in-memory, per-isolate circuit in the Agent runtime — so the reason and the time of the switch are unknown.",
					},
				})}
			/>,
		);
		expect(html).toContain("workers-ai");
		expect(html).toContain("not recorded durably");
	});
});

describe("HealthCard", () => {
	it("always shows provider health as unknown, even with fresh traffic", () => {
		const html = renderToStaticMarkup(<HealthCard posture={posture()} />);
		expect(html).toContain('data-provider-health="unknown"');
		expect(html).toContain("unknown here, not healthy");
	});

	it("reports the D1 policy that atomically admits inference", () => {
		const html = renderToStaticMarkup(<HealthCard posture={posture()} />);
		expect(html).toContain("D1 is the sole inference-admission authority");
	});
});

describe("AttributionCard", () => {
	it("states that orphaned rows are invisible, so the figure is a floor", () => {
		const html = renderToStaticMarkup(<AttributionCard posture={posture()} />);
		expect(html).toContain("never a total");
	});
});

describe("compute posture summaries support both composition levels", () => {
	it.each([
		["LedgerCard", LedgerCard],
		["ProvenanceCard", ProvenanceCard],
		["BudgetCard", BudgetCard],
		["RoutingCard", RoutingCard],
		["HealthCard", HealthCard],
		["AttributionCard", AttributionCard],
	])("renders %s at the top-level panel tier", (_name, Card) => {
		const html = renderToStaticMarkup(<Card posture={posture()} />);

		expect(html).toContain('data-slot="surface"');
		expect(html).toContain('data-tier="panel"');
		expect(html).not.toContain('data-tier="well"');
	});

	it.each([
		["LedgerCard", LedgerCard],
		["ProvenanceCard", ProvenanceCard],
		["BudgetCard", BudgetCard],
		["RoutingCard", RoutingCard],
		["HealthCard", HealthCard],
		["AttributionCard", AttributionCard],
	])("drops %s chrome inside a shared collection", (_name, Card) => {
		const html = renderToStaticMarkup(<Card posture={posture()} embedded />);

		expect(html).not.toContain('data-slot="surface"');
		expect(html).toContain("px-4");
		expect(html).toContain("py-3");
	});

	it("groups the route into one divided Kumo collection per section", () => {
		const client = new QueryClient({
			defaultOptions: { queries: { enabled: false, retry: false } },
		});
		client.setQueryData(
			computePostureQueryOptions("7d").queryKey,
			posture() as never,
		);
		const doc = new DOMParser().parseFromString(
			renderToStaticMarkup(
				<QueryClientProvider client={client}>
					<ComputePage />
				</QueryClientProvider>,
			),
			"text/html",
		);
		const collections = [
			...doc.querySelectorAll('[data-slot="collection"]'),
		].map((collection) => collection.getAttribute("aria-label"));
		expect(collections).toEqual(
			expect.arrayContaining([
				"Cost and budget status",
				"Routing and model status",
				"Admission health status",
			]),
		);
		// Embedded cards drop their own surface chrome inside the collection.
		for (const collection of doc.querySelectorAll('[data-slot="collection"]'))
			expect(collection.querySelector('[data-slot="surface"]')).toBeNull();
		// One cost-window control, fed by the shared usage periods.
		const windowControl = doc.querySelector('[aria-label="Cost window"]');
		expect(windowControl).not.toBeNull();
		for (const option of USAGE_PERIOD_OPTIONS)
			expect(windowControl!.textContent).toContain(option.label);
		expect(doc.querySelector(".lg\\:grid-cols-2")).toBeNull();
	});
});
