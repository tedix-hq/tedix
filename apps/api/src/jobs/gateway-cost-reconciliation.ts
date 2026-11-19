/**
 * Daily ledger-vs-AI-Gateway cost reconciliation.
 *
 * At 02:00 UTC this compares, for the previous UTC day, the provider cost in
 * our ledger (`billing_usage_charges`) with the cost Cloudflare AI Gateway
 * analytics report for the production LLM gateway. It stores one row per
 * provider and normalized model plus a provider-day total in
 * `billing_gateway_reconciliations`; the 08:00 platform-health digest turns
 * non-matching rows into billing health alerts.
 *
 * Gateway analytics are a second opinion, not a bill: Azure OpenAI is billed by
 * Azure, and the Gateway's cost for it comes from Cloudflare's own price table.
 * A drift therefore means "look at this", never "rewrite the ledger". Nothing
 * here changes charges, credits, or Stripe.
 */

import { safeExceptionTopology } from "../lib/safe-log-metadata";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { NewBillingGatewayReconciliationRow } from "@tedix/db/schema/billing-gateway-reconciliations";
import type { BillingSettlementBindings } from "../lib/billing-settlement-mode";
import type { FleetAuthorityEnv } from "../lib/fleet-authority";

const CF_GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

/** Drift alerts need both: more than 5% of the Gateway figure and more than $5. */
export const DRIFT_RELATIVE_THRESHOLD = 0.05;
export const DRIFT_ABSOLUTE_THRESHOLD_MICROS = 5_000_000;
/** Cost on one side only alerts above $1. */
export const ONE_SIDED_THRESHOLD_MICROS = 1_000_000;
/** Analytics groups per query; one day of one gateway is far below this. */
const GRAPHQL_GROUP_LIMIT = 10_000;

export type GatewayReconciliationEnv = BillingSettlementBindings &
	FleetAuthorityEnv & {
		CF_ACCOUNT_ID?: string;
		/** Account Analytics Read; already used for Analytics Engine SQL. */
		CF_ANALYTICS_TOKEN?: string;
		/** The production LLM gateway, e.g. `tedix-llm-production`. */
		AI_GATEWAY_LLM_ID?: string;
	};

type ReconciliationStatus = NewBillingGatewayReconciliationRow["status"];

/**
 * Put Gateway and ledger model names on one key.
 *
 * The Gateway reports Azure OpenAI calls by bare model (`gpt-6.1-sol`) while
 * the ledger stores the catalog id (`openai/gpt-6.1-sol`). Workers AI models
 * are `@cf/...` on both sides and pass through unchanged.
 */
export function normalizeReconciliationKey(
	provider: string,
	model: string,
): { provider: string; model: string } {
	const p = provider.trim().toLowerCase();
	const m = model.trim().toLowerCase();
	if (p === "azure-openai" || p === "openai") {
		return { provider: p, model: `openai/${m.replace(/^openai\//, "")}` };
	}
	return { provider: p, model: m };
}

/**
 * Classify one comparison. One-sided cost is checked first; otherwise the row
 * drifts when the difference exceeds both 5% of the Gateway figure and $5.
 */
export function classifyReconciliation(
	ledgerCostMicros: number,
	gatewayCostMicros: number,
): ReconciliationStatus {
	if (gatewayCostMicros === 0 && ledgerCostMicros > ONE_SIDED_THRESHOLD_MICROS)
		return "ledger_only";
	if (ledgerCostMicros === 0 && gatewayCostMicros > ONE_SIDED_THRESHOLD_MICROS)
		return "gateway_only";
	const difference = Math.abs(ledgerCostMicros - gatewayCostMicros);
	if (
		difference > DRIFT_ABSOLUTE_THRESHOLD_MICROS &&
		difference > gatewayCostMicros * DRIFT_RELATIVE_THRESHOLD
	)
		return "drift";
	return "matched";
}

export interface GatewayAnalyticsGroup {
	count?: number | null;
	sum?: {
		cost?: number | null;
		uncachedTokensIn?: number | null;
		uncachedTokensOut?: number | null;
		cachedTokensIn?: number | null;
	} | null;
	dimensions?: {
		model?: string | null;
		provider?: string | null;
		gateway?: string | null;
	} | null;
}

interface GraphqlResponse {
	data?: {
		viewer?: {
			accounts?: Array<{
				aiGatewayRequestsAdaptiveGroups?: GatewayAnalyticsGroup[] | null;
			}> | null;
		} | null;
	} | null;
	errors?: Array<{ message?: string }> | null;
}

const GATEWAY_COST_QUERY = `query GatewayCostByModel($accountTag: string!, $start: Time!, $end: Time!, $limit: uint64!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      aiGatewayRequestsAdaptiveGroups(
        limit: $limit
        filter: { datetimeHour_geq: $start, datetimeHour_leq: $end }
      ) {
        count
        sum { cost uncachedTokensIn uncachedTokensOut cachedTokensIn }
        dimensions { model provider gateway }
      }
    }
  }
}`;

/** Hourly analytics groups for one UTC day (`00:00` through `23:00` buckets). */
export async function fetchGatewayCostGroups(
	env: { CF_ACCOUNT_ID: string; CF_ANALYTICS_TOKEN: string },
	day: string,
): Promise<GatewayAnalyticsGroup[]> {
	const res = await fetch(CF_GRAPHQL_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			query: GATEWAY_COST_QUERY,
			variables: {
				accountTag: env.CF_ACCOUNT_ID,
				start: `${day}T00:00:00Z`,
				end: `${day}T23:00:00Z`,
				limit: GRAPHQL_GROUP_LIMIT,
			},
		}),
	});
	if (!res.ok) {
		throw new Error(
			`Cloudflare GraphQL returned HTTP ${res.status} for AI Gateway analytics`,
		);
	}
	const body = (await res.json()) as GraphqlResponse;
	// GraphQL reports auth and schema failures as HTTP 200 with `errors`.
	if (body.errors && body.errors.length > 0) {
		throw new Error(
			`Cloudflare GraphQL AI Gateway analytics failed: ${body.errors
				.map((error) => error.message ?? "unknown error")
				.slice(0, 3)
				.join("; ")}`,
		);
	}
	const accounts = body.data?.viewer?.accounts;
	if (!accounts || accounts.length === 0) {
		throw new Error(
			"Cloudflare GraphQL returned no account for AI Gateway analytics",
		);
	}
	return accounts[0]?.aiGatewayRequestsAdaptiveGroups ?? [];
}

function toMicros(usd: number | null | undefined): number {
	return typeof usd === "number" && Number.isFinite(usd) && usd > 0
		? Math.round(usd * 1_000_000)
		: 0;
}

interface SideTotals {
	ledgerCostMicros: number;
	gatewayCostMicros: number;
	ledgerRowCount: number;
	gatewayRequestCount: number;
}

/**
 * Merge both sides into reconciliation rows: one per provider and model, and
 * one provider-day total (`model = ''`).
 */
export function buildReconciliationRows(input: {
	day: string;
	gatewayId: string;
	computedAt: string;
	ledger: Array<{
		provider: string;
		model: string;
		costMicros: number;
		rowCount: number;
	}>;
	gateway: GatewayAnalyticsGroup[];
}): NewBillingGatewayReconciliationRow[] {
	const byModel = new Map<
		string,
		SideTotals & { provider: string; model: string }
	>();
	const entry = (provider: string, model: string) => {
		const key = normalizeReconciliationKey(provider, model);
		const id = `${key.provider}\u0000${key.model}`;
		let totals = byModel.get(id);
		if (!totals) {
			totals = {
				...key,
				ledgerCostMicros: 0,
				gatewayCostMicros: 0,
				ledgerRowCount: 0,
				gatewayRequestCount: 0,
			};
			byModel.set(id, totals);
		}
		return totals;
	};
	for (const row of input.ledger) {
		const totals = entry(row.provider, row.model);
		totals.ledgerCostMicros += row.costMicros;
		totals.ledgerRowCount += row.rowCount;
	}
	for (const group of input.gateway) {
		if (group.dimensions?.gateway !== input.gatewayId) continue;
		const totals = entry(
			group.dimensions?.provider ?? "unknown",
			group.dimensions?.model ?? "unknown",
		);
		totals.gatewayCostMicros += toMicros(group.sum?.cost);
		totals.gatewayRequestCount += group.count ?? 0;
	}

	const byProvider = new Map<string, SideTotals>();
	const rows: NewBillingGatewayReconciliationRow[] = [];
	const push = (provider: string, model: string, totals: SideTotals) =>
		rows.push({
			id: crypto.randomUUID(),
			day: input.day,
			gatewayId: input.gatewayId,
			provider,
			model,
			ledgerCostMicros: totals.ledgerCostMicros,
			gatewayCostMicros: totals.gatewayCostMicros,
			differenceMicros: totals.ledgerCostMicros - totals.gatewayCostMicros,
			ledgerRowCount: totals.ledgerRowCount,
			gatewayRequestCount: totals.gatewayRequestCount,
			status: classifyReconciliation(
				totals.ledgerCostMicros,
				totals.gatewayCostMicros,
			),
			computedAt: input.computedAt,
		});
	for (const totals of byModel.values()) {
		push(totals.provider, totals.model, totals);
		const sum = byProvider.get(totals.provider) ?? {
			ledgerCostMicros: 0,
			gatewayCostMicros: 0,
			ledgerRowCount: 0,
			gatewayRequestCount: 0,
		};
		sum.ledgerCostMicros += totals.ledgerCostMicros;
		sum.gatewayCostMicros += totals.gatewayCostMicros;
		sum.ledgerRowCount += totals.ledgerRowCount;
		sum.gatewayRequestCount += totals.gatewayRequestCount;
		byProvider.set(totals.provider, sum);
	}
	for (const [provider, totals] of byProvider) push(provider, "", totals);
	return rows.sort(
		(a, b) =>
			a.provider.localeCompare(b.provider) ||
			(a.model ?? "").localeCompare(b.model ?? ""),
	);
}

/** The previous closed UTC day for a run at `scheduledTimeMs`. */
export function previousUtcDay(scheduledTimeMs: number): string {
	const date = new Date(scheduledTimeMs);
	date.setUTCDate(date.getUTCDate() - 1);
	return date.toISOString().slice(0, 10);
}

function nextUtcDay(day: string): string {
	const date = new Date(`${day}T00:00:00.000Z`);
	date.setUTCDate(date.getUTCDate() + 1);
	return date.toISOString().slice(0, 10);
}

export interface GatewayReconciliationResult {
	day: string;
	rows: NewBillingGatewayReconciliationRow[];
	gatewayGroups: number;
}

export async function reconcileGatewayCostDay(
	db: DbQueryClient,
	env: { CF_ACCOUNT_ID: string; CF_ANALYTICS_TOKEN: string },
	params: { day: string; gatewayId: string; now: string },
): Promise<GatewayReconciliationResult> {
	const { sumLedgerCostByProviderModel, replaceGatewayReconciliationDay } =
		await import("@tedix/db/queries/billing/gateway-reconciliation");
	const gateway = await fetchGatewayCostGroups(env, params.day);
	const ledger = await sumLedgerCostByProviderModel(db, {
		gatewayId: params.gatewayId,
		sinceInclusive: `${params.day}T00:00:00.000Z`,
		untilExclusive: `${nextUtcDay(params.day)}T00:00:00.000Z`,
	});
	const rows = buildReconciliationRows({
		day: params.day,
		gatewayId: params.gatewayId,
		computedAt: params.now,
		ledger,
		gateway,
	});
	await replaceGatewayReconciliationDay(db, {
		day: params.day,
		gatewayId: params.gatewayId,
		rows,
	});
	return { day: params.day, rows, gatewayGroups: gateway.length };
}

export async function runGatewayCostReconciliationTick(
	env: GatewayReconciliationEnv,
	scheduledTimeMs: number,
): Promise<Record<string, number>> {
	const { resolveBillingSettlementMode } =
		await import("../lib/billing-settlement-mode");
	if (resolveBillingSettlementMode(env) !== "managed") return {};
	const missing = (
		["CF_ACCOUNT_ID", "CF_ANALYTICS_TOKEN", "AI_GATEWAY_LLM_ID"] as const
	).filter((name) => !env[name]);
	if (missing.length > 0) {
		throw new Error(
			`Gateway cost reconciliation needs ${missing.join(", ")} configured`,
		);
	}
	try {
		const { resolveFleetAuthorityDb } = await import("../lib/fleet-authority");
		const db = resolveFleetAuthorityDb(env);
		const now = new Date().toISOString();
		const result = await reconcileGatewayCostDay(
			db,
			{
				CF_ACCOUNT_ID: env.CF_ACCOUNT_ID as string,
				CF_ANALYTICS_TOKEN: env.CF_ANALYTICS_TOKEN as string,
			},
			{
				day: previousUtcDay(scheduledTimeMs),
				gatewayId: env.AI_GATEWAY_LLM_ID as string,
				now,
			},
		);
		const totals = result.rows.filter((row) => row.model === "");
		const driftProviders = totals.filter((row) => row.status === "drift");
		const oneSidedModels = result.rows.filter(
			(row) =>
				row.model !== "" &&
				(row.status === "ledger_only" || row.status === "gateway_only"),
		);
		console.log(
			JSON.stringify({
				signal: "billing.gateway.reconciliation",
				day: result.day,
				gatewayGroups: result.gatewayGroups,
				providers: totals.map((row) => ({
					provider: row.provider,
					ledgerCostMicros: row.ledgerCostMicros,
					gatewayCostMicros: row.gatewayCostMicros,
					status: row.status,
				})),
				oneSidedModels: oneSidedModels.length,
			}),
		);
		return {
			rowsWritten: result.rows.length,
			gatewayGroups: result.gatewayGroups,
			driftProviders: driftProviders.length,
			oneSidedModels: oneSidedModels.length,
		};
	} catch (err) {
		console.warn("[gateway-cost-reconciliation] tick failed", {
			exception: safeExceptionTopology(err),
		});
		throw err;
	}
}
