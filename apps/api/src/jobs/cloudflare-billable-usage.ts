/**
 * Cloudflare Billable Usage → `billing_provider_reconciliations` ingestion.
 *
 * Cloudflare Workers AI billed cost is a reconciliation input.
 * `billing.recordProviderReconciliation` takes `providerCostMicros` as operator
 * input; this job is the automated source for it.
 *
 * `GET /accounts/{id}/billable-usage`: one call returns account usage and cost broken down by product and charge
 * period, in FOCUS-aligned columns. Workers AI rows are Cloudflare's own
 * billed cost for the inference we already ledger per tedi in
 * `tedi_call_costs`/`billing_usage_charges`, which is exactly the pairing the
 * reconciliation table exists to hold.
 *
 * Deliberate scope — only the Workers AI family becomes a reconciliation:
 * `recordBillingProviderReconciliation` computes variance against
 * `billing_usage_charges` for the same provider. Workers AI has a real ledger
 * to compare against; R2/D1/Workers/Images/Stream do not, and recording them
 * as `provider = "cloudflare"` would mint permanent `variance` rows that only
 * mean "we never claimed a per-tedi ledger for storage". Those products are
 * still captured — as an explicit cost breakdown in the reconciliation
 * metadata, and in the returned totals — without being dressed up as a ledger
 * disagreement.
 *
 * Boundaries this job does NOT cross:
 *  - It never marks a rate-card estimate as provider-reported. It writes only
 *    what Cloudflare billed.
 *  - It never converts currency. A non-USD billing currency is skipped loudly
 *    rather than silently converted at an invented rate.
 *  - It is evidence, not entitlement. Nothing here admits inference, changes a
 *    customer charge, or touches the Stripe outbox.
 */

import type { DbClient } from "@tedix/db/client";
import { recordBillingProviderReconciliation } from "@tedix/db/queries/billing/health";
import { sumWorkstationComputeMicros } from "@tedix/db/queries/billing/provider-usage";
import type { BillingSettlementBindings } from "../lib/billing-settlement-mode";
import type { FleetAuthorityEnv } from "../lib/fleet-authority";
import { allocateContainerCostForPeriod } from "./workstation-cost-allocation";

/**
 * Exactly what this tick needs, named explicitly rather than taking the whole
 * `CloudflareEnv` global — the dependencies are then visible at the call site
 * and the module stays trivially testable without a Worker type reference.
 */
export type BillableUsageTickEnv = BillingSettlementBindings &
	FleetAuthorityEnv & {
		CF_ACCOUNT_ID?: string;
		CF_BILLING_TOKEN?: string;
	};

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/**
 * Cloudflare's FOCUS-aligned billable-usage row. Only the fields this job
 * relies on are modelled; the payload carries more (cumulative totals, zone
 * attribution) that we keep verbatim in metadata rather than re-typing.
 */
export interface BillableUsageRow {
	BillingCurrency?: string;
	BillingPeriodStart?: string;
	ChargePeriodStart?: string;
	ChargePeriodEnd?: string;
	ServiceName?: string;
	ServiceFamilyName?: string;
	ConsumedQuantity?: number;
	ConsumedUnit?: string;
	PricingQuantity?: number;
	ContractedCost?: number;
}

export interface BillableUsageIngestionResult {
	/** Reconciliation rows written (one per Workers AI charge period). */
	reconciled: number;
	/** USD micros Cloudflare billed for Workers AI across the window. */
	workersAiCostMicros: number;
	/** USD micros Cloudflare billed for everything else (evidence only). */
	otherCostMicros: number;
	/** Rows the API returned, before filtering. */
	rowsFetched: number;
	/** Rows skipped, by reason, for operator visibility. */
	skipped: Record<string, number>;
	/** Set when the window produced no reconciliation; never thrown. */
	failure?: string;
}

/**
 * Cloudflare bills Workers AI under this service family. Matched
 * case-insensitively because FOCUS `ServiceFamilyName` is a display-shaped
 * string, not an enum.
 */
const WORKERS_AI_FAMILY = "workers ai";

/**
 * Containers became reconcilable once `workstation_compute` started being
 * written: `billing_provider_usage` now holds a per-tenant ledger to compare
 * Cloudflare's account-level Containers charge against. Before that there was
 * nothing on our side and a reconciliation could only have reported the whole
 * charge as variance.
 */
const CONTAINERS_FAMILY = "containers";

/** Our ledger's provider key for Cloudflare-billed inference. */
const WORKERS_AI_PROVIDER = "workers-ai";

/** USD micros. Cloudflare returns a decimal USD amount. */
function toMicros(cost: number): number {
	return Math.round(cost * 1_000_000);
}

function bump(counter: Record<string, number>, key: string): void {
	counter[key] = (counter[key] ?? 0) + 1;
}

/**
 * Fetch one account's billable usage for an explicit window.
 *
 * `from`/`to` are ISO dates (YYYY-MM-DD). Omitting them returns the current
 * billing period, but this job always passes a window so a re-run is
 * reproducible rather than dependent on when the cron fired.
 */
export async function fetchBillableUsage(
	env: { CF_ACCOUNT_ID: string; CF_BILLING_TOKEN: string },
	window: { from: string; to: string },
): Promise<BillableUsageRow[]> {
	const query = new URLSearchParams({ from: window.from, to: window.to });
	const res = await fetch(
		`${CF_API_BASE}/accounts/${env.CF_ACCOUNT_ID}/billable-usage?${query.toString()}`,
		{ headers: { Authorization: `Bearer ${env.CF_BILLING_TOKEN}` } },
	);
	if (!res.ok) {
		// Name the status: a 403 here means the token lacks Billing Read, which
		// is a different fix from a 404 (wrong account path) — and the previous
		// Gateway-credential incident showed how expensive an unnamed
		// Cloudflare auth failure is to diagnose.
		throw new Error(
			`Cloudflare billable-usage returned HTTP ${res.status} for account ${env.CF_ACCOUNT_ID}`,
		);
	}
	const body = (await res.json()) as {
		success?: boolean;
		result?: BillableUsageRow[];
		errors?: unknown[];
	};
	if (body.success === false) {
		throw new Error(
			`Cloudflare billable-usage reported failure: ${JSON.stringify(body.errors ?? [])}`,
		);
	}
	return Array.isArray(body.result) ? body.result : [];
}

/**
 * Ingest one window of Cloudflare billable usage as provider-cost evidence.
 *
 * Idempotent: reconciliations upsert on
 * (provider, providerResource, periodStart, periodEnd), so re-running the same
 * window updates the row in place instead of duplicating it. That matters
 * because Cloudflare refines a charge period's cost for a day or two after it
 * closes — the latest read should win, not append.
 */
export async function ingestCloudflareBillableUsage(
	db: DbClient,
	env: {
		CF_ACCOUNT_ID?: string;
		CF_BILLING_TOKEN?: string;
	},
	options: { from: string; to: string; now: string },
): Promise<BillableUsageIngestionResult> {
	const empty: BillableUsageIngestionResult = {
		reconciled: 0,
		workersAiCostMicros: 0,
		otherCostMicros: 0,
		rowsFetched: 0,
		skipped: {},
	};
	if (!env.CF_ACCOUNT_ID?.trim() || !env.CF_BILLING_TOKEN?.trim()) {
		// Fail soft and explicit. This job is additive evidence: a missing
		// Billing Read token must not take down the daily billing tick, but it
		// must never look like "Cloudflare billed nothing" either.
		return {
			...empty,
			failure:
				"CF_BILLING_TOKEN or CF_ACCOUNT_ID is not set — Cloudflare provider cost is NOT being reconciled. Mint an API token with Billing Read and set the Worker secret.",
		};
	}

	let rows: BillableUsageRow[];
	try {
		rows = await fetchBillableUsage(
			{
				CF_ACCOUNT_ID: env.CF_ACCOUNT_ID,
				CF_BILLING_TOKEN: env.CF_BILLING_TOKEN,
			},
			{ from: options.from, to: options.to },
		);
	} catch (err) {
		return {
			...empty,
			failure: err instanceof Error ? err.message : String(err),
		};
	}

	const skipped: Record<string, number> = {};
	let workersAiCostMicros = 0;
	let otherCostMicros = 0;

	/** Per-charge-period Workers AI cost, plus the non-inference breakdown. */
	const workersAiByPeriod = new Map<
		string,
		{
			periodStart: string;
			periodEnd: string;
			costMicros: number;
			consumedQuantity: number;
		}
	>();
	const otherByService: Record<string, number> = {};
	const containersByPeriod = new Map<
		string,
		{ periodStart: string; periodEnd: string; costMicros: number }
	>();

	for (const row of rows) {
		const cost = row.ContractedCost;
		if (typeof cost !== "number" || !Number.isFinite(cost)) {
			bump(skipped, "non-numeric-cost");
			continue;
		}
		// Never convert. Our ledger is USD micros; applying an FX rate here
		// would fabricate provider-reported evidence.
		const currency = (row.BillingCurrency ?? "USD").toUpperCase();
		if (currency !== "USD") {
			bump(skipped, `non-usd-currency:${currency}`);
			continue;
		}
		const micros = toMicros(cost);
		const family = (row.ServiceFamilyName ?? "").trim().toLowerCase();

		if (family !== WORKERS_AI_FAMILY) {
			otherCostMicros += micros;
			const service = row.ServiceName?.trim() || "unknown";
			otherByService[service] = (otherByService[service] ?? 0) + micros;
			if (
				family === CONTAINERS_FAMILY &&
				row.ChargePeriodStart &&
				row.ChargePeriodEnd
			) {
				const key = `${row.ChargePeriodStart}..${row.ChargePeriodEnd}`;
				const seen = containersByPeriod.get(key);
				if (seen) {
					// Containers bill across several line items per period (vCPU,
					// memory, disk, egress); the reconciliation compares the family.
					seen.costMicros += micros;
				} else {
					containersByPeriod.set(key, {
						costMicros: micros,
						periodEnd: row.ChargePeriodEnd,
						periodStart: row.ChargePeriodStart,
					});
				}
			}
			continue;
		}

		const periodStart = row.ChargePeriodStart;
		const periodEnd = row.ChargePeriodEnd;
		if (!periodStart || !periodEnd) {
			bump(skipped, "workers-ai-row-without-charge-period");
			continue;
		}
		workersAiCostMicros += micros;
		const key = `${periodStart}..${periodEnd}`;
		const existing = workersAiByPeriod.get(key);
		if (existing) {
			// Cloudflare can split one family across several ServiceName rows
			// in the same period; the reconciliation compares family totals.
			existing.costMicros += micros;
			existing.consumedQuantity += row.ConsumedQuantity ?? 0;
		} else {
			workersAiByPeriod.set(key, {
				periodStart,
				periodEnd,
				costMicros: micros,
				consumedQuantity: row.ConsumedQuantity ?? 0,
			});
		}
	}

	let reconciled = 0;
	for (const [key, period] of workersAiByPeriod) {
		await recordBillingProviderReconciliation(db, {
			id: crypto.randomUUID(),
			provider: WORKERS_AI_PROVIDER,
			// Empty resource = the whole provider for this period. The health
			// query treats '' as "do not filter by providerResource", which is
			// what an account-level Cloudflare total actually is.
			providerResource: "",
			periodStart: period.periodStart,
			periodEnd: period.periodEnd,
			providerCostMicros: period.costMicros,
			evidenceRef: `cloudflare-billable-usage:${env.CF_ACCOUNT_ID}:${key}`,
			reconciledBy: "job:cloudflare-billable-usage",
			metadata: {
				source: "cloudflare-billable-usage-api",
				accountId: env.CF_ACCOUNT_ID,
				requestedWindow: { from: options.from, to: options.to },
				// Infrastructure spend is real Cloudflare cost that has no
				// per-tedi ledger to reconcile against. Keep it as evidence
				// beside the inference comparison instead of discarding it or
				// minting a misleading variance row for it.
				nonInferenceCostMicrosByService: otherByService,
				// Cloudflare bills Workers AI in Neurons and our usage currently
				// sits inside the free allowance, so every cost field comes back
				// 0 while real inference is happening. Cost alone would therefore record nothing but zeros. The consumed
				// quantity is the leading indicator of when we start paying, so
				// keep it beside the cost.
				consumedQuantity: period.consumedQuantity,
			},
			now: options.now,
		});
		reconciled += 1;
	}

	// Containers: allocate Cloudflare's account-level charge onto the tenant
	// ledger, then reconcile. The charge is the numerator and lease-seconds are
	// only the share key — see `workstation-cost-allocation.ts` for why pricing
	// lease wall-clock produced a 473x over-estimate and cannot be repaired.
	//
	// The reconciliation stays a real check because allocation spreads the
	// charge ONLY across rows that exist. Variance is therefore container spend
	// with no lease to tie it to, which is the condition worth alerting on. If
	// allocation ever back-filled the remainder, this comparison would report
	// zero forever and prove nothing.
	for (const [key, period] of containersByPeriod) {
		const evidenceRef = `cloudflare-billable-usage:${env.CF_ACCOUNT_ID}:containers:${key}`;
		const allocation = await allocateContainerCostForPeriod(db, {
			evidenceRef,
			now: options.now,
			periodEnd: period.periodEnd,
			periodStart: period.periodStart,
			totalCostMicros: period.costMicros,
		});
		const attributed = await sumWorkstationComputeMicros(
			db,
			period.periodStart,
			period.periodEnd,
		);
		await recordBillingProviderReconciliation(db, {
			evidenceRef,
			id: crypto.randomUUID(),
			ledgerCostMicrosOverride: attributed.micros,
			metadata: {
				accountId: env.CF_ACCOUNT_ID,
				allocatedCostMicros: allocation.allocatedMicros,
				// A share of a real bill, keyed on lease wall-clock. The key is a
				// proxy for container-active time, not a measurement of it; the
				// TOTAL is exact because it comes from Cloudflare.
				attributionBasis: "cloudflare_charge_allocated_by_lease_wall_clock",
				leaseRowsAllocated: allocation.updated,
				source: "cloudflare-billable-usage-api",
				// Non-zero means containers billed in a period with no lease rows
				// to carry the cost.
				unallocatedCostMicros: allocation.unallocatedMicros,
			},
			now: options.now,
			periodEnd: period.periodEnd,
			periodStart: period.periodStart,
			provider: "cloudflare-containers",
			providerCostMicros: period.costMicros,
			providerResource: "",
			reconciledBy: "job:cloudflare-billable-usage",
			usageRowCountOverride: attributed.rows,
		});
		reconciled += 1;
	}

	return {
		reconciled,
		workersAiCostMicros,
		otherCostMicros,
		rowsFetched: rows.length,
		skipped,
		// Zero ROWS is a failure; zero COST is not. An account can legitimately
		// have zero Workers AI charges in a window — free-tier usage bills at
		// zero and Cloudflare may omit the row rather than return a zero one —
		// so flagging that would fire every day and train everyone to ignore
		// this job. But an empty row set from an account that bills Workers,
		// D1, R2, Durable Objects and Containers every single day means the
		// window is wrong, not that nothing was spent: a too-short lookback
		// returns `success: true` with zero rows and no complaint.
		...(rows.length === 0
			? {
					failure:
						`Cloudflare returned ZERO billable-usage rows for ${options.from}..${options.to}. ` +
						"This account bills daily, so an empty window means `from` is after the billing " +
						"period start, not that nothing was spent — see BILLABLE_USAGE_LOOKBACK_DAYS.",
				}
			: Object.keys(skipped).length > 0 && reconciled === 0
				? {
						failure: `Every candidate row was skipped (${Object.entries(skipped)
							.map(([reason, count]) => `${reason}=${count}`)
							.join(" ")}) — no provider reconciliation was written.`,
					}
				: {}),
	};
}

/**
 * Daily tick: reconcile the trailing window.
 *
 * Cloudflare updates usage daily and refines a period after it closes, so the
 * window deliberately reaches back and re-upserts rather than ingesting only
 * yesterday once. Cheap (one request) and self-healing across a missed run.
 *
 * The lookback must span the billing period start. `from` is not a filter over
 * daily charge rows — the API returns nothing unless `from` is on or before the
 * start of the billing period the rows belong to, and a `from` one day after
 * the period start answers `success: true` with zero rows. A short (e.g.
 * 7-day) lookback therefore fetches real data only during the week after a
 * period boundary and reads as "Cloudflare billed nothing" for the rest of the
 * month.
 *
 * 45 days clears a ~monthly period start from any day inside it, with margin for
 * a long month and a missed tick. Widening costs one request returning a few
 * hundred rows; every write is an idempotent per-period upsert.
 */
export const BILLABLE_USAGE_LOOKBACK_DAYS = 45;

export function billableUsageWindow(now: Date): { from: string; to: string } {
	const to = new Date(now);
	const from = new Date(now);
	from.setUTCDate(from.getUTCDate() - BILLABLE_USAGE_LOOKBACK_DAYS);
	const iso = (d: Date) => d.toISOString().slice(0, 10);
	return { from: iso(from), to: iso(to) };
}

export async function runCloudflareBillableUsageTick(
	env: BillableUsageTickEnv,
): Promise<Record<string, number>> {
	const { resolveBillingSettlementMode } =
		await import("../lib/billing-settlement-mode");
	if (resolveBillingSettlementMode(env) !== "managed") return {};
	try {
		const { resolveFleetAuthorityDb } = await import("../lib/fleet-authority");
		const db = resolveFleetAuthorityDb(env);
		const now = new Date();
		const result = await ingestCloudflareBillableUsage(db, env, {
			...billableUsageWindow(now),
			now: now.toISOString(),
		});
		const skippedSummary = Object.entries(result.skipped)
			.map(([reason, count]) => `${reason}=${count}`)
			.join(" ");
		const summary =
			`rows=${result.rowsFetched} reconciled=${result.reconciled} ` +
			`workersAiMicros=${result.workersAiCostMicros} otherMicros=${result.otherCostMicros}` +
			(skippedSummary ? ` skipped(${skippedSummary})` : "");
		if (result.failure) {
			// A silent zero here would read as "Cloudflare billed nothing",
			// which is the same failure shape that once hid a dead Gateway
			// cursor for days. Make it loud.
			console.error(
				`[cloudflare-billable-usage] provider cost NOT reconciled: ${result.failure} (${summary})`,
			);
			throw new Error(result.failure);
		}
		// Structured so a silent daily tick is greppable, not just visible.
		console.log(
			JSON.stringify({
				asOf: now.toISOString(),
				nonInferenceCostMicros: result.otherCostMicros,
				reconciled: result.reconciled,
				rowsFetched: result.rowsFetched,
				signal: "cloudflare.billable.usage.ingested",
				skipped: result.skipped,
				workersAiCostMicros: result.workersAiCostMicros,
			}),
		);
		return {
			rowsFetched: result.rowsFetched,
			reconciliationsWritten: result.reconciled,
		};
	} catch (err) {
		console.warn(
			"[cloudflare-billable-usage] tick failed (non-fatal):",
			err instanceof Error ? err.message : String(err),
		);
		throw err;
	}
}
