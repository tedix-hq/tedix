/**
 * At 02:00 UTC, match the previous UTC day's Gateway logs to ledger charges.
 * Raw Gateway prices are informational: Azure cached-input pricing can differ
 * from the ledger even when every call is charged. Only missing charges alert
 * in the 08:00 digest. This job never changes charges, credits, or Stripe.
 */

import { safeExceptionTopology } from "../lib/safe-log-metadata";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { getGatewayLedgerCharges } from "@tedix/db/queries/billing/gateway-reconciliation";
import type {
	GatewayReconciliationCoverage,
	NewBillingGatewayReconciliationRow,
} from "@tedix/db/schema/billing-gateway-reconciliations";
import type { BillingSettlementBindings } from "../lib/billing-settlement-mode";
import type { FleetAuthorityEnv } from "../lib/fleet-authority";
import { hasMaterialGatewayDrift } from "../lib/gateway-reconciliation-threshold";
import type { AiGatewayLogRow } from "./gateway-cost-ingestion";

export type GatewayReconciliationEnv = BillingSettlementBindings &
	FleetAuthorityEnv & {
		CF_ACCOUNT_ID?: string;
		/** Same AI Gateway Read credential used by log ingestion. */
		CF_AI_GATEWAY_TOKEN?: string;
		/** The production LLM gateway, e.g. `tedix-llm-production`. */
		AI_GATEWAY_LLM_ID?: string;
	};

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

/** Read the entire closed day, or fail without replacing the previous result. */
async function fetchGatewayDayLogs(
	env: { CF_ACCOUNT_ID: string; CF_AI_GATEWAY_TOKEN: string },
	day: string,
	gatewayId: string,
): Promise<AiGatewayLogRow[]> {
	const logs = new Map<string, AiGatewayLogRow>();
	const start = `${day}T00:00:00.000Z`;
	const end = `${nextUtcDay(day)}T00:00:00.000Z`;
	for (let page = 1; page <= 2_000; page++) {
		const query = new URLSearchParams({
			page: String(page),
			per_page: "50",
			order_by: "created_at",
			order_by_direction: "asc",
			filters: JSON.stringify([
				{
					key: "created_at",
					operator: "gt",
					value: [new Date(Date.parse(start) - 1).toISOString()],
				},
				{ key: "created_at", operator: "lt", value: [end] },
			]),
		});
		const res = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/logs?${query}`,
			{ headers: { Authorization: `Bearer ${env.CF_AI_GATEWAY_TOKEN}` } },
		);
		if (!res.ok) throw new Error(`AI Gateway logs returned HTTP ${res.status}`);
		const body = (await res.json()) as {
			success: boolean;
			result: AiGatewayLogRow[];
			result_info?: { total_count?: number; truncated?: boolean };
		};
		if (
			!body.success ||
			!Array.isArray(body.result) ||
			body.result_info?.truncated
		)
			throw new Error("AI Gateway logs returned an incomplete day");
		for (const log of body.result) {
			const time = Date.parse(log.created_at);
			if (
				!log.id ||
				!Number.isFinite(time) ||
				time < Date.parse(start) ||
				time >= Date.parse(end)
			)
				throw new Error(
					"AI Gateway logs returned a row outside the requested day",
				);
			logs.set(log.id, log);
		}
		const total = body.result_info?.total_count;
		if (body.result.length < 50) {
			if (total !== undefined && logs.size < total)
				throw new Error("AI Gateway logs ended before the full day was read");
			return [...logs.values()];
		}
	}
	throw new Error(
		"AI Gateway logs exceeded the daily reconciliation page limit",
	);
}

function toMicros(usd: number | null | undefined): number {
	return typeof usd === "number" && Number.isFinite(usd) && usd > 0
		? Math.round(usd * 1_000_000)
		: 0;
}

function emptyCoverage(): GatewayReconciliationCoverage {
	return {
		missingCallCount: 0,
		missingCostMicros: 0,
		missingUnpricedCallCount: 0,
		tokenCheckedCallCount: 0,
		tokenMismatchCallCount: 0,
		tokenUnknownCallCount: 0,
		platformOverheadCallCount: 0,
		platformOverheadCostMicros: 0,
	};
}

interface SideTotals {
	ledgerCostMicros: number;
	gatewayCostMicros: number;
	ledgerRowCount: number;
	gatewayRequestCount: number;
	coverage: GatewayReconciliationCoverage;
}

// These Clef classifiers support platform triage. Clef has no customer model
// catalog entry, and its Gateway logs report cost without token usage.
const CLEF_OVERHEAD_SURFACES = new Set<unknown>([
	"agent-turn-triage",
	"agent-reply-label",
	"reply-draft-routing",
]);

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
	gateway: AiGatewayLogRow[];
	charges: Awaited<ReturnType<typeof getGatewayLedgerCharges>>;
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
				coverage: emptyCoverage(),
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
	const charges = new Map(
		input.charges.map((charge) => [charge.gatewayLogId, charge]),
	);
	for (const log of new Map(
		input.gateway.map((log) => [log.id, log]),
	).values()) {
		const totals = entry(log.provider, log.model);
		totals.gatewayCostMicros += toMicros(log.cost);
		totals.gatewayRequestCount++;
		const coverage = totals.coverage;
		if (
			log.provider === "workers-ai" &&
			(log.metadata?.surface === "lane-lesson" ||
				(CLEF_OVERHEAD_SURFACES.has(log.metadata?.surface) &&
					!charges.has(log.id)))
		) {
			coverage.platformOverheadCallCount++;
			coverage.platformOverheadCostMicros += toMicros(log.cost);
			continue;
		}
		// Failed requests and Gateway response-cache hits incur no provider usage.
		// Provider prompt-cache tokens (usage_metadata) still require a charge.
		if (!log.success || log.cached) continue;
		const charge = charges.get(log.id);
		if (!charge) {
			coverage.missingCallCount++;
			coverage.missingCostMicros += toMicros(log.cost);
			if (log.cost === null || !Number.isFinite(log.cost) || log.cost < 0)
				coverage.missingUnpricedCallCount++;
			continue;
		}
		const inputTokens = log.usage_metadata?.input_tokens ?? log.tokens_in;
		const outputTokens = log.usage_metadata?.output_tokens ?? log.tokens_out;
		if (inputTokens === null || outputTokens === null) {
			coverage.tokenUnknownCallCount++;
		} else {
			coverage.tokenCheckedCallCount++;
			if (
				inputTokens !== charge.inputTokens ||
				outputTokens !== charge.outputTokens
			)
				coverage.tokenMismatchCallCount++;
		}
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
			coverage: totals.coverage,
			status: !hasMaterialGatewayDrift(totals)
				? "matched"
				: totals.coverage.tokenCheckedCallCount +
							totals.coverage.tokenUnknownCallCount ===
					  0
					? "gateway_only"
					: "drift",
			computedAt: input.computedAt,
		});
	for (const totals of byModel.values()) {
		push(totals.provider, totals.model, totals);
		const sum = byProvider.get(totals.provider) ?? {
			ledgerCostMicros: 0,
			gatewayCostMicros: 0,
			ledgerRowCount: 0,
			gatewayRequestCount: 0,
			coverage: emptyCoverage(),
		};
		sum.ledgerCostMicros += totals.ledgerCostMicros;
		sum.gatewayCostMicros += totals.gatewayCostMicros;
		sum.ledgerRowCount += totals.ledgerRowCount;
		sum.gatewayRequestCount += totals.gatewayRequestCount;
		for (const key of Object.keys(sum.coverage) as Array<
			keyof GatewayReconciliationCoverage
		>)
			sum.coverage[key] += totals.coverage[key];
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
	gatewayLogs: number;
}

export async function reconcileGatewayCostDay(
	db: DbQueryClient,
	env: { CF_ACCOUNT_ID: string; CF_AI_GATEWAY_TOKEN: string },
	params: { day: string; gatewayId: string; now: string },
): Promise<GatewayReconciliationResult> {
	const {
		sumLedgerCostByProviderModel,
		replaceGatewayReconciliationDay,
		getGatewayLedgerCharges,
	} = await import("@tedix/db/queries/billing/gateway-reconciliation");
	const gateway = await fetchGatewayDayLogs(env, params.day, params.gatewayId);
	const charges = await getGatewayLedgerCharges(db, {
		gatewayId: params.gatewayId,
		gatewayLogIds: gateway.map((log) => log.id),
	});
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
		charges,
	});
	await replaceGatewayReconciliationDay(db, {
		day: params.day,
		gatewayId: params.gatewayId,
		rows,
	});
	return { day: params.day, rows, gatewayLogs: gateway.length };
}

export async function runGatewayCostReconciliationTick(
	env: GatewayReconciliationEnv,
	scheduledTimeMs: number,
): Promise<Record<string, number>> {
	const { resolveBillingSettlementMode } =
		await import("../lib/billing-settlement-mode");
	if (resolveBillingSettlementMode(env) !== "managed") return {};
	const missing = (
		["CF_ACCOUNT_ID", "CF_AI_GATEWAY_TOKEN", "AI_GATEWAY_LLM_ID"] as const
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
				CF_AI_GATEWAY_TOKEN: env.CF_AI_GATEWAY_TOKEN as string,
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
				gatewayLogs: result.gatewayLogs,
				providers: totals.map((row) => ({
					provider: row.provider,
					ledgerCostMicros: row.ledgerCostMicros,
					gatewayCostMicros: row.gatewayCostMicros,
					status: row.status,
					coverage: row.coverage,
				})),
				oneSidedModels: oneSidedModels.length,
			}),
		);
		return {
			rowsWritten: result.rows.length,
			gatewayLogs: result.gatewayLogs,
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
