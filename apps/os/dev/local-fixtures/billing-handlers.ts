/**
 * Local fixture handlers: Billing, usage, MCP payment and compute
 * procedures.
 */

import {
	CALL_COSTS,
	CREDIT_PERIOD_END,
	CREDIT_PERIOD_START,
	CREDIT_PLANS,
	CREDIT_TOP_UP_PACKS,
	creditUsage,
	MCP_PAYMENT_EVENTS,
	MCP_PAYMENT_POLICIES,
} from "./billing";
import { ORG_ID, RpcError, T1, T4, T5, TEDI_JUNO, TEDI_MILES } from "./core";
import { state } from "./state";

export const billingHandlers: Record<string, (input: never) => unknown> = {
	"tediUsage/getCallCosts": (input: {
		tediId: string;
		period?: "24h" | "7d" | "30d";
	}) => {
		const rows = CALL_COSTS.filter((row) => row.tediId === input.tediId);
		const priced = rows.filter(
			(row) => row.dataQuality === "ok" && row.estimatedCostUsd !== null,
		);
		const knownSubtotalUsd = priced.reduce(
			(sum, row) => sum + row.estimatedCostUsd!,
			0,
		);
		const unpriced = rows.length - priced.length;
		return {
			tediId: input.tediId,
			period: input.period ?? "7d",
			costs: rows,
			summary: [
				{
					knownSubtotalUsd,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: priced.length,
					unpricedRowCount: unpriced,
					unpricedTokens: unpriced * 22300,
					costCompleteness:
						priced.length === 0
							? ("unknown" as const)
							: unpriced > 0
								? ("partial" as const)
								: ("complete" as const),
					model: "claude-sonnet-4-5",
					provider: "anthropic",
					providerResource: null,
					deployment: null,
					totalInputTokens: rows.length * 12_400,
					totalOutputTokens: rows.length * 1_900,
					totalCacheReadTokens: rows.length * 8_000,
					totalCacheWriteTokens: 0,
					totalTokens: rows.length * 22_300,
					totalCostUsd: unpriced > 0 ? null : knownSubtotalUsd,
					snapshotCount: rows.length,
				},
			],
			sourceSummary: [
				{
					knownSubtotalUsd,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: priced.length,
					unpricedRowCount: unpriced,
					unpricedTokens: unpriced * 22300,
					costCompleteness:
						priced.length === 0
							? ("unknown" as const)
							: unpriced > 0
								? ("partial" as const)
								: ("complete" as const),
					source: "ai-gateway",
					sessionType: "tedi",
					totalInputTokens: rows.length * 12_400,
					totalOutputTokens: rows.length * 1_900,
					totalCacheReadTokens: rows.length * 8_000,
					totalCacheWriteTokens: 0,
					totalTokens: rows.length * 22_300,
					totalCostUsd: unpriced > 0 ? null : knownSubtotalUsd,
					rowCount: rows.length,
				},
			],
		};
	},
	/**
	 * Compute posture. Deliberately NOT a clean, fully-labeled reading: the dev
	 * lane exercises the honest states, so this window carries a quarantined
	 * bucket and an unknown-basis bucket beside the estimate, reports credential
	 * health as `unattested` (nothing stores a passing probe) and provider health
	 * as `unknown`, and reports D1 as the sole admission authority. Every literal below is
	 * written out rather than imported because vite.config.ts loads this module
	 * under raw Node, where package subpaths do not resolve.
	 */
	"osCompute/posture": (input: { window?: "24h" | "7d" | "30d" }) => {
		const window = input.window ?? "7d";
		const days = window === "24h" ? 1 : window === "7d" ? 7 : 30;
		const to = new Date();
		const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
		return {
			window,
			from: from.toISOString(),
			to: to.toISOString(),
			freshness: {
				state: "ingestion_pending" as const,
				lastRowAt: T4,
				staleMinutes: 42,
				rowsLast24h: 4,
				rowsLast30d: 6,
				detail:
					"The cost ledger ingests every 15 minutes; work newer than the last tick is not counted yet.",
			},
			spend: {
				pricedRowCount: 4,
				unpricedRowCount: 2,
				unpricedTokens: 44600,
				costCompleteness: "partial" as const,
				rowCount: 6,
				totalTokens: 111_500,
				quarantinedTokens: 22_300,
				quarantinedRowCount: 1,
				provenanceFloor: "unknown" as const,
			},
			provenance: [
				{
					provenance: "pricing_table_estimate" as const,
					rowCount: 4,
					totalTokens: 89_200,
				},
				{
					provenance: "unknown" as const,
					rowCount: 1,
					totalTokens: 22_300,
				},
				{
					provenance: "quarantined" as const,
					rowCount: 1,
					totalTokens: 22_300,
				},
			],
			budget: {
				configured: true,
				includedCredits: creditUsage.includedCredits,
				usedCredits: creditUsage.usedCredits,
				heldCredits: 40,
				topUpCredits: creditUsage.topUpCredits,
				availableCredits:
					creditUsage.remainingIncludedCredits + creditUsage.topUpCredits,
				entitlementActive: true,
				detail:
					"Copied from the canonical credit pool the admission path reads; available already nets out credits held by calls in flight.",
			},
			routing: {
				modelRef: "azure-openai/gpt-5.6-luna",
				selectedBy: "org_default" as const,
				detail:
					"No tedi is named, so the chat slot resolves to the deployment default deployment.",
				allowedCount: 6,
				deniedCount: 2,
				wiredProviders: ["azure-openai", "workers-ai"],
				observedProviders: ["anthropic"],
				fallbackDetail:
					"Calls in this window were served by anthropic while the model catalog selects azure-openai/gpt-5.6-luna. Runtime fallback is not recorded durably — the only breaker is an in-memory, per-isolate circuit in the Agent runtime — so the reason and the time of the switch are unknown.",
			},
			credentialHealth: {
				scope: "platform_ai_gateway" as const,
				status: "unattested" as const,
				observedAt: T4,
				detail:
					"No open credential-drift condition and no fresh ingestion to evidence the credentials. Nothing stores a passing probe, so credential health is unattested here — not healthy.",
			},
			providerHealth: {
				status: "unknown" as const,
				detail:
					"No durable provider-health signal exists. The only breaker is an in-memory, per-isolate circuit inside the Agent runtime, unreadable from the control plane — so provider health is unknown here, not healthy.",
			},
			admissionPolicy: {
				state: "d1_authoritative" as const,
				allowedModelTiers: null,
				detail:
					"D1 is the sole inference-admission authority. Monthly credits are checked atomically with reservations; AI Gateway only records provider usage and cost.",
			},
			attribution: {
				unattributedTokens: 22_300,
				unattributedRowCount: 1,
				unattributedQuarantinedRowCount: 0,
				orphanedRowsVisible: false as const,
				detail:
					"Unattributed rows that still carry this organization. Rows with no organization at all are invisible to every org-scoped read, so this is a floor on unattributed spend, never a total.",
			},
		};
	},
	"billing/listPlans": () => CREDIT_PLANS,
	"billing/listTopUpPacks": () => CREDIT_TOP_UP_PACKS,
	"billing/setCreditCaps": (input: {
		tediCaps?: Array<{ tediId: string; monthlyCapCredits: number | null }>;
		memberCaps?: Array<{ userId: string; monthlyCapCredits: number | null }>;
	}) => {
		for (const cap of input.tediCaps ?? []) {
			const row = creditUsage.tedis.find((tedi) => tedi.tediId === cap.tediId);
			if (!row) throw new RpcError("NOT_FOUND", "Tedi not found");
			row.monthlyCapCredits = cap.monthlyCapCredits;
		}
		for (const cap of input.memberCaps ?? []) {
			const row = creditUsage.members.find(
				(member) => member.userId === cap.userId,
			);
			if (!row) throw new RpcError("NOT_FOUND", "Member not found");
			row.monthlyCapCredits = cap.monthlyCapCredits;
		}
		return structuredClone(creditUsage);
	},
	"billing/setPayAsYouGo": (input: {
		enabled: boolean;
		monthlyCapMicros: number | null;
	}) => {
		creditUsage.payAsYouGo = {
			...creditUsage.payAsYouGo,
			enabled: input.enabled,
			monthlyCapMicros: input.enabled ? input.monthlyCapMicros : null,
		};
		return structuredClone(creditUsage);
	},
	"billing/getOverview": () => ({
		stripeEnvironment: "test" as const,
		account: {
			status: "active" as const,
			billingMode: "trial" as const,
			periodStart: CREDIT_PERIOD_START,
			periodEnd: CREDIT_PERIOD_END,
			hasStripeCustomer: false,
		},
		plan: CREDIT_PLANS[1],
		credits: structuredClone(creditUsage),
		admission: {
			available: true,
			blockingReason: null,
			unblockAction: "none" as const,
		},
		workstationCostCoverage: {
			periodStart: CREDIT_PERIOD_START,
			periodEnd: CREDIT_PERIOD_END,
			observedAt: CREDIT_PERIOD_START,
			unit: "compute_seconds" as const,
			basis: "recorded_lease_end_wall_clock" as const,
			status: "none" as const,
			knownAttributedCostMicros: null,
			total: { rowCount: 0, leaseSeconds: 0 },
			reconciled: { rowCount: 0, leaseSeconds: 0 },
			pending: { rowCount: 0, leaseSeconds: 0 },
			unproven: { rowCount: 0, leaseSeconds: 0 },
		},
	}),
	"orgUsage/getOrgUsage": (input: {
		organizationId: string;
		period?: "24h" | "7d" | "30d";
		window?: { from: string; to: string };
	}) => {
		if (input.organizationId !== ORG_ID)
			throw new RpcError("NOT_FOUND", "Organization not found");
		return {
			organization: {
				id: ORG_ID,
				name: state.organization.name,
				tier: "growth" as const,
				status: "active" as const,
			},
			period: input.period ?? ("30d" as const),
			window: input.window ?? {
				from: "2026-07-22T00:00:00.000Z",
				to: "2026-08-21T00:00:00.000Z",
			},
			totals: {
				totalTokens: 1_260_000,
				inputTokens: 940_000,
				outputTokens: 320_000,
				cacheReadTokens: 210_000,
				cacheWriteTokens: 45_000,
				estimatedCostUsd: 3.4,
				knownSubtotalUsd: 3.4,
				reviewedEstimateRowCount: 0,
				reviewedEstimateTokens: 0,
				reviewedEstimateMicros: 0,
				sourceRetiredRowCount: 0,
				pricedRowCount: 1,
				unpricedRowCount: 0,
				unpricedTokens: 0,
				costCompleteness: "complete" as const,
				activeTedis: 2,
			},
			planLimits: {
				includedCreditsPerMonth: creditUsage.includedCredits,
				currentMonthCredits: creditUsage.usedCredits,
				usagePct: creditUsage.usedCredits / creditUsage.includedCredits,
				maxTedis: 1,
				currentTedis: 2,
			},
			daily: [
				{
					date: "2026-08-11",
					totalTokens: 82_000,
					estimatedCostUsd: 0.19,
					knownSubtotalUsd: 0.19,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 61_000,
					outputTokens: 21_000,
				},
				{
					date: "2026-08-12",
					totalTokens: 96_000,
					estimatedCostUsd: 0.24,
					knownSubtotalUsd: 0.24,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 73_000,
					outputTokens: 23_000,
				},
				{
					date: "2026-08-13",
					totalTokens: 104_000,
					estimatedCostUsd: 0.27,
					knownSubtotalUsd: 0.27,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 77_000,
					outputTokens: 27_000,
				},
				{
					date: "2026-08-14",
					totalTokens: 91_000,
					estimatedCostUsd: 0.22,
					knownSubtotalUsd: 0.22,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 68_000,
					outputTokens: 23_000,
				},
				{
					date: "2026-08-15",
					totalTokens: 126_000,
					estimatedCostUsd: 0.31,
					knownSubtotalUsd: 0.31,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 93_000,
					outputTokens: 33_000,
				},
				{
					date: "2026-08-16",
					totalTokens: 113_000,
					estimatedCostUsd: 0.28,
					knownSubtotalUsd: 0.28,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 84_000,
					outputTokens: 29_000,
				},
				{
					date: "2026-08-17",
					totalTokens: 148_000,
					estimatedCostUsd: 0.38,
					knownSubtotalUsd: 0.38,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 111_000,
					outputTokens: 37_000,
				},
				{
					date: "2026-08-18",
					totalTokens: 132_000,
					estimatedCostUsd: 0.34,
					knownSubtotalUsd: 0.34,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 98_000,
					outputTokens: 34_000,
				},
				{
					date: "2026-08-19",
					totalTokens: 164_000,
					estimatedCostUsd: 0.51,
					knownSubtotalUsd: 0.51,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 121_000,
					outputTokens: 43_000,
				},
				{
					date: "2026-08-20",
					totalTokens: 204_000,
					estimatedCostUsd: 0.66,
					knownSubtotalUsd: 0.66,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					inputTokens: 154_000,
					outputTokens: 50_000,
				},
			],
			tediBreakdown: [
				{
					tediId: TEDI_MILES,
					tediName: "Miles",
					tediSlug: "miles",
					totalTokens: 824_000,
					estimatedCostUsd: 2.37,
					knownSubtotalUsd: 2.37,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					cacheHitRate: 0.28,
				},
				{
					tediId: TEDI_JUNO,
					tediName: "Juno",
					tediSlug: "juno",
					totalTokens: 436_000,
					estimatedCostUsd: 1.03,
					knownSubtotalUsd: 1.03,
					reviewedEstimateRowCount: 0,
					reviewedEstimateTokens: 0,
					reviewedEstimateMicros: 0,
					sourceRetiredRowCount: 0,
					pricedRowCount: 1,
					unpricedRowCount: 0,
					unpricedTokens: 0,
					costCompleteness: "complete" as const,
					cacheHitRate: 0.19,
				},
			],
			modelBreakdown: [],
			sourceBreakdown: [],
		};
	},
	// --- MCP payment ledger (read-only) ---
	"mcpPayments/listEvents": (
		input:
			| {
					status?: "required" | "settled" | "rejected";
					appSlug?: string;
					toolId?: string;
					tediId?: string;
					limit?: number;
			  }
			| undefined,
	) => ({
		events: MCP_PAYMENT_EVENTS.filter(
			(event) =>
				(input?.status === undefined || event.status === input.status) &&
				(input?.appSlug === undefined || event.appSlug === input.appSlug) &&
				(input?.toolId === undefined || event.toolId === input.toolId) &&
				(input?.tediId === undefined || event.tediId === input.tediId),
		).slice(0, input?.limit ?? 100),
	}),
	"mcpPayments/getReceipt": (input: { id: string }) => {
		const receipt = MCP_PAYMENT_EVENTS.find(
			(event) => event.id === input.id && event.settled,
		);
		if (!receipt) throw new RpcError("NOT_FOUND", "Receipt not found");
		return {
			receipt,
			events: MCP_PAYMENT_EVENTS.filter(
				(event) => event.requirementId === receipt.requirementId,
			),
		};
	},
	"mcpPayments/spendSummary": (
		input:
			| {
					lastHours?: number;
					appSlug?: string;
					toolId?: string;
					tediId?: string;
			  }
			| undefined,
	) => {
		const settled = MCP_PAYMENT_EVENTS.filter(
			(event) =>
				event.settled &&
				(input?.appSlug === undefined || event.appSlug === input.appSlug) &&
				(input?.toolId === undefined || event.toolId === input.toolId) &&
				(input?.tediId === undefined || event.tediId === input.tediId),
		);
		const lastHours = input?.lastHours ?? 24;
		return {
			lastHours,
			since: new Date(Date.now() - lastHours * 3_600_000).toISOString(),
			summary: settled.map((event) => ({
				appSlug: event.appSlug,
				toolId: event.toolId,
				currency: event.currency,
				asset: event.asset,
				network: event.network,
				settledCount: 1,
				totalAmount: Number(event.amount),
				firstSettledAt: event.createdAt,
				lastSettledAt: event.createdAt,
			})),
			totals: settled.length
				? [
						{
							currency: settled[0]!.currency,
							asset: settled[0]!.asset,
							network: settled[0]!.network,
							settledCount: settled.length,
							totalAmount: settled.reduce(
								(sum, event) => sum + Number(event.amount),
								0,
							),
						},
					]
				: [],
		};
	},
	"mcpPayments/listPolicies": (
		input:
			| { appSlug?: string; toolId?: string; tediId?: string; limit?: number }
			| undefined,
	) => ({
		policies: MCP_PAYMENT_POLICIES.filter(
			(policy) =>
				(input?.appSlug === undefined || policy.appSlug === input.appSlug) &&
				(input?.toolId === undefined || policy.toolId === input.toolId) &&
				(input?.tediId === undefined || policy.tediId === input.tediId),
		).slice(0, input?.limit ?? 100),
	}),
};
