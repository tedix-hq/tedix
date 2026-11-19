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
import type { CreditUsage } from "@/lib/billing-credits";
import {
	billingOverviewQueryOptions,
	computePostureQueryOptions,
} from "@/lib/os-query-options";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	AttributionCard,
	ComputePage,
	CreditsCard,
	credentialLabel,
	credentialTone,
	freshnessLabel,
	freshnessTone,
	HealthCard,
	LedgerCard,
	ProvenanceCard,
	provenanceLegend,
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
			includedCredits: 15_000,
			usedCredits: 6_000,
			heldCredits: 10,
			topUpCredits: 1_000,
			availableCredits: 9_990,
			entitlementActive: true,
			detail: "Copied from the canonical credit pool.",
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
			allowedModelTiers: null,
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

function credits(overrides: Partial<CreditUsage> = {}): CreditUsage {
	return {
		periodStart: "2026-08-01T00:00:00.000Z",
		periodEnd: "2026-09-01T00:00:00.000Z",
		includedCredits: 15_000,
		usedCredits: 6_000,
		remainingIncludedCredits: 9_000,
		topUpCredits: 1_000,
		breakdown: { ai: 5_000, codeRuns: 600, services: 400 },
		notices: [],
		payAsYouGo: { enabled: false, monthlyCapMicros: null, spentMicros: 0 },
		tedis: [],
		members: [],
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

describe("provenanceLegend", () => {
	it("keeps every label in the legend, including the one nothing can produce", () => {
		const legend = provenanceLegend([]);
		expect(legend).toHaveLength(6);
		expect(
			legend.some((entry) => entry.provenance === "reviewed_provider_estimate"),
		).toBe(true);
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
		expect(html).toContain("0 calls in 7d");
	});

	it("reports held calls without any money amount", () => {
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
		expect(html).toContain("12 calls in 7d");
		expect(html).toContain("2 calls are held for review");
		expect(html).not.toContain("$");
	});
});

describe("ProvenanceCard", () => {
	it("uses one Kumo progressive disclosure at every viewport", () => {
		const html = renderToStaticMarkup(<ProvenanceCard posture={posture()} />);
		expect(html).toContain('data-kumo-component="CollapsibleTrigger"');
		expect(html).toContain("max-sm:min-h-11");
		expect(html).not.toContain("sm:hidden");
		expect(html).not.toContain("hidden gap-2 sm:grid");
		expect(html).toContain("6 sources");
		expect(html).toContain("reviewed provider estimate");
	});

	it("states that provider-reported is never produced here", () => {
		const html = renderToStaticMarkup(<ProvenanceCard posture={posture()} />);
		expect(html).toContain("never produced here");
		expect(html).toContain("provider reported");
	});

	// Customers see credits only: a provider cost in USD would reveal the
	// markup, so the legend reports call counts and never an amount.
	it("reports calls per source and never a money amount", () => {
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
		expect(html).toContain("3 calls");
		expect(html).toContain("5 calls");
		expect(html).not.toContain("$");
		expect(html).not.toContain("0.0777");
	});
});

describe("CreditsCard", () => {
	it("shows credits used, included, left and the breakdown", () => {
		const html = renderToStaticMarkup(<CreditsCard credits={credits()} />);
		expect(html).toContain("Credits this month");
		expect(html).toContain("10,000 credits left");
		expect(html).toContain("6,000 credits used of 15,000 credits included");
		expect(html).toContain("Code runs");
		expect(html.toLowerCase()).not.toContain("token");
		const doc = new DOMParser().parseFromString(html, "text/html");
		expect(
			doc.querySelector('[role="meter"]')?.getAttribute("aria-valuenow"),
		).toBe("40");
	});

	it("says work has stopped when no credits are left", () => {
		const html = renderToStaticMarkup(
			<CreditsCard
				credits={credits({
					usedCredits: 15_000,
					remainingIncludedCredits: 0,
					topUpCredits: 0,
				})}
			/>,
		);
		expect(html).toContain("Out of credits");
		expect(html).toContain("New work that uses credits has stopped");
	});
});

describe("RoutingCard", () => {
	it("labels the model Auto and keeps missing selection explicit", () => {
		expect(renderToStaticMarkup(<RoutingCard posture={posture()} />)).toContain(
			">Auto</span>",
		);
		const html = renderToStaticMarkup(
			<RoutingCard
				posture={posture({ routing: { ...posture().routing, modelRef: null } })}
			/>,
		);
		expect(html).toContain("No model selected");
	});
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
		expect(html).not.toContain("daily ceiling");
	});
});

describe("AttributionCard", () => {
	it("states that orphaned rows are invisible, so the figure is a floor", () => {
		const html = renderToStaticMarkup(<AttributionCard posture={posture()} />);
		expect(html).toContain("never a total");
	});

	it("counts unattributed calls without their USD cost", () => {
		const html = renderToStaticMarkup(
			<AttributionCard
				posture={posture({
					attribution: {
						...posture().attribution,
						unattributedCostUsd: 0.42,
						unattributedRowCount: 4,
					},
				})}
			/>,
		);
		expect(html).toContain("4 calls");
		expect(html).not.toContain("$");
	});
});

describe("compute posture summaries support both composition levels", () => {
	it.each([
		["LedgerCard", LedgerCard],
		["ProvenanceCard", ProvenanceCard],
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
		client.setQueryData(billingOverviewQueryOptions().queryKey, {
			credits: credits(),
		} as never);
		const doc = new DOMParser().parseFromString(
			renderToStaticMarkup(
				<QueryClientProvider client={client}>
					<ComputePage />
				</QueryClientProvider>,
			),
			"text/html",
		);
		expect(doc.querySelector("h1")?.textContent).toBe("Usage");
		expect(doc.querySelector('a[href="/admin/billing"]')?.textContent).toBe(
			"Billing",
		);
		const advanced = [...doc.querySelectorAll("button")].find(
			(button) => button.textContent === "Advanced usage diagnostics",
		);
		expect(advanced?.getAttribute("aria-expanded")).toBe("false");
		const collections = [
			...doc.querySelectorAll('[data-slot="collection"]'),
		].map((collection) => collection.getAttribute("aria-label"));
		expect(collections).toEqual(
			expect.arrayContaining([
				"Cost and budget status",
				"Monthly limits",
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

describe("AI call record", () => {
	it("shows held and unpriced calls without pricing them", () => {
		const value = posture();
		value.spend.rowCount = 12;
		value.spend.quarantinedRowCount = 2;
		value.spend.quarantinedTokens = 40;
		value.spend.quarantinedCostUsd = 0.4;
		value.spend.quarantinedKnownSubtotalUsd = 0.4;
		value.spend.unpricedRowCount = 2;
		value.spend.unpricedTokens = 40;
		value.spend.costCompleteness = "partial";
		value.spend.costUsd = null;
		const html = renderToStaticMarkup(<LedgerCard posture={value} />);
		expect(html).toContain("AI call record");
		expect(html).toContain("2 calls are held for review");
		expect(html).toContain("2 unpriced calls");
		expect(html).not.toContain("tokens");
		expect(html).not.toContain("$");
	});
});
