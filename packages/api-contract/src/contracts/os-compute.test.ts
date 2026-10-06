/**
 * The posture envelope accepts its producer's range: getBillingBalanceSnapshot
 * passes included_monthly_tokens through, including negative unlimited-plan
 * sentinels. Absent billing state remains distinct from a zero allowance.
 */

import { describe, expect, it } from "vite-plus/test";
import {
	COST_ATTRIBUTION_GAP_DETAIL,
	COST_ADMISSION_POLICY_DETAIL,
	COST_PROVIDER_HEALTH_DETAIL,
} from "../schemas/cost-provenance";
import { ComputePostureSchema } from "./os-compute";

/** A posture envelope in the shape the handler returns. */
function posture(overrides: Record<string, unknown> = {}) {
	return {
		window: "7d" as const,
		from: "2026-08-10T00:00:00.000Z",
		to: "2026-08-17T00:00:00.000Z",
		freshness: {
			state: "fresh" as const,
			lastRowAt: "2026-08-17T00:00:00.000Z",
			staleMinutes: 3,
			rowsLast24h: 12,
			rowsLast30d: 400,
			detail: "Ingested within the last 15 minutes.",
		},
		spend: {
			knownSubtotalUsd: 1,
			pricedRowCount: 1,
			unpricedRowCount: 0,
			unpricedTokens: 0,
			costCompleteness: "complete",
			quarantinedKnownSubtotalUsd: 0,
			rowCount: 1,
			totalTokens: 100,
			costUsd: 1,
			quarantinedCostUsd: 0,
			quarantinedTokens: 0,
			quarantinedRowCount: 0,
			provenanceFloor: "pricing_table_estimate" as const,
		},
		provenance: [],
		budget: {
			configured: true,
			includedTokens: 20_000_000,
			usedTokens: 4_120_000,
			reservedTokens: 60_000,
			remainingIncludedTokens: 15_820_000,
			unlimitedTokenUsage: false,
			allowOverage: false,
			entitlementActive: true,
			detail: "Copied from the canonical billing balance snapshot.",
		},
		routing: {
			modelRef: "azure-openai/gpt-5.6-luna",
			selectedBy: "org_default" as const,
			detail: "Chat turns route at the org default.",
			allowedCount: 3,
			deniedCount: 1,
			wiredProviders: ["azure-openai"],
			observedProviders: ["azure-openai"],
			fallbackDetail: null,
		},
		credentialHealth: {
			status: "evidenced_ok" as const,
			scope: "platform_ai_gateway" as const,
			observedAt: "2026-08-17T00:00:00.000Z",
			detail: "Rows arrived within one ingestion interval.",
		},
		providerHealth: {
			status: "unknown" as const,
			detail: COST_PROVIDER_HEALTH_DETAIL,
		},
		admissionPolicy: {
			state: "d1_authoritative" as const,
			desiredDailyTokenLimit: null,
			desiredDailySpendLimitMicros: null,
			detail: COST_ADMISSION_POLICY_DETAIL,
		},
		attribution: {
			unattributedCostUsd: 0,
			unattributedTokens: 0,
			unattributedRowCount: 0,
			unattributedQuarantinedRowCount: 0,
			orphanedRowsVisible: false as const,
			detail: COST_ATTRIBUTION_GAP_DETAIL,
		},
		...overrides,
	};
}

describe("ComputePostureSchema accepts what the producers emit", () => {
	it("accepts the ordinary finite-allowance envelope", () => {
		expect(() => ComputePostureSchema.parse(posture())).not.toThrow();
	});

	// An unlimited plan reports a negative includedTokens sentinel; rejecting
	// it would 500 the whole read.
	it("accepts an unlimited plan's negative token sentinel", () => {
		const parsed = ComputePostureSchema.parse(
			posture({
				budget: {
					...posture().budget,
					includedTokens: -1,
					remainingIncludedTokens: -1,
					unlimitedTokenUsage: true,
				},
			}),
		);
		expect(parsed.budget.includedTokens).toBe(-1);
		expect(parsed.budget.remainingIncludedTokens).toBe(-1);
	});

	it("accepts an absent billing account without flattening it to zero", () => {
		const parsed = ComputePostureSchema.parse(
			posture({
				budget: {
					configured: false,
					includedTokens: null,
					usedTokens: null,
					reservedTokens: null,
					remainingIncludedTokens: null,
					unlimitedTokenUsage: null,
					allowOverage: null,
					entitlementActive: null,
					detail: "No billing account is configured.",
				},
			}),
		);
		expect(parsed.budget.includedTokens).toBeNull();
	});

	// The other half of the same lesson: `selectedBy` is the catalog's own
	// vocabulary, so a value the catalog cannot emit must be rejected rather
	// than travelling as free text.
	it("rejects a selection reason the model catalog cannot emit", () => {
		expect(() =>
			ComputePostureSchema.parse(
				posture({
					routing: { ...posture().routing, selectedBy: "deployment_default" },
				}),
			),
		).toThrow();
	});

	it("accepts a null selection when no model resolves", () => {
		const parsed = ComputePostureSchema.parse(
			posture({
				routing: { ...posture().routing, modelRef: null, selectedBy: null },
			}),
		);
		expect(parsed.routing.selectedBy).toBeNull();
	});
});

describe("explicit token usage semantic", () => {
	it("requires the semantic without an optional legacy fallback", () => {
		const value = posture();
		const { unlimitedTokenUsage: _discarded, ...budget } = value.budget;
		expect(() => ComputePostureSchema.parse({ ...value, budget })).toThrow();
	});
	it.each([true, false, null])(
		"preserves semantic %s independently of zero included allowance",
		(unlimitedTokenUsage) => {
			const value = posture();
			value.budget = {
				...value.budget,
				unlimitedTokenUsage,
				includedTokens: unlimitedTokenUsage === null ? null : 0,
				remainingIncludedTokens: unlimitedTokenUsage === null ? null : 0,
				configured: unlimitedTokenUsage !== null,
			};
			expect(ComputePostureSchema.parse(value).budget.unlimitedTokenUsage).toBe(
				unlimitedTokenUsage,
			);
		},
	);
});
