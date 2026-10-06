/**
 * Workstation container time → `billing_provider_usage` metering.
 *
 * Cloudflare's Containers charge is account-level: it cannot say which
 * tenant, tedi, or Work Item caused it. `workstation_leases` carries `org_id`,
 * `work_item_id` and (through participants) the lead `tedi_id`, so this writes
 * the `workstation_compute` row that joins container time to those keys.
 *
 * Why a sweep, not a hook on release:
 *  - Leases also end by expiry. A reaped lease consumed container time and
 *    never ran release code, so a release hook would under-count exactly the
 *    runaway case this is meant to catch.
 *  - `POST /release` lives in `apps/tedi`, and billing tables are owned by the
 *    `apps/api` fleet-authority boundary. Sweeping keeps the write on the right
 *    side of that line.
 *
 * Cost record only, and unpriced. Rows are `customer_metering_ready = false`
 * by construction: `recordBillingProviderUsage` never creates a customer
 * charge or a Stripe outbox entry.
 *
 * Attribution only, no cost. Leases and sessions are D1 lifecycle records that
 * can outlive the container by days; Cloudflare bills allocated time while
 * the DO is awake, which D1 cannot observe, so pricing lease wall-clock
 * over-estimates by orders of magnitude.
 *
 * So this sweep writes the attribution and nothing else: quantity plus the
 * org/tedi/work-item keys, `providerCostMicros: 0`, and
 * `pricingStatus: "pending_allocation"`. Cost is filled in afterwards by
 * `workstation-cost-allocation.ts`, which distributes Cloudflare's actual
 * per-period Containers charge across these rows pro-rata. Deriving cost here
 * would have to guess at a rate; there it is bounded by the real bill.
 *
 * Note what the quantity is and is not. A lease span is an ENVELOPE around the
 * container's activity, not a measurement of it — containers sleep after ~15m
 * idle and wake on demand. It is a serviceable share key and a bad absolute.
 */

import type { DbClient } from "@tedix/db/client";
import { recordBillingProviderUsage } from "@tedix/db/queries/billing/provider-usage";
import { listWorkstationLeaseComputeWindows } from "@tedix/db/queries/workstations";
import type { BillingSettlementBindings } from "../lib/billing-settlement-mode";
import type { FleetAuthorityEnv } from "../lib/fleet-authority";

export type WorkstationMeteringEnv = BillingSettlementBindings &
	FleetAuthorityEnv;

/** Provider key for Cloudflare-billed infrastructure, not model inference. */
const CONTAINER_PROVIDER = "cloudflare";

/** Recorded as the `model` so the ledger keeps the billed instance shape. */
const CONTAINER_MODEL = "container:standard-1";

/**
 * Trailing window. Wide enough that a missed tick self-heals, and safe to
 * re-read because every write is idempotent on the lease-derived id.
 */
export const WORKSTATION_METERING_LOOKBACK_HOURS = 48;

/** Bounded so one tick cannot fan out unboundedly on a backlog. */
const MAX_LEASES_PER_TICK = 200;

export interface WorkstationMeteringResult {
	scanned: number;
	recorded: number;
	computeSeconds: number;
	/** Leases whose lead tedi could not be resolved; still metered per-org. */
	withoutTedi: number;
	failures: string[];
}

/**
 * A lease is metered exactly once. `billing_provider_usage` has a partial
 * unique index on `provider_usage_id` and `recordBillingProviderUsage` does
 * ON CONFLICT DO NOTHING, so replaying a window is free rather than duplicative.
 */
export function workstationUsageId(leaseId: string): string {
	return `workstation-lease:${leaseId}`;
}

export function workstationMeteringWindow(
	now: Date,
	lookbackHours = WORKSTATION_METERING_LOOKBACK_HOURS,
): { since: string; until: string } {
	const until = new Date(now);
	const since = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
	return { since: since.toISOString(), until: until.toISOString() };
}

export async function meterWorkstationCompute(
	db: DbClient,
	options: { since: string; until: string; now: string; limit?: number },
): Promise<WorkstationMeteringResult> {
	const result: WorkstationMeteringResult = {
		computeSeconds: 0,
		failures: [],
		recorded: 0,
		scanned: 0,
		withoutTedi: 0,
	};
	const windows = await listWorkstationLeaseComputeWindows(db, {
		limit: options.limit ?? MAX_LEASES_PER_TICK,
		since: options.since,
		until: options.until,
	});
	result.scanned = windows.length;

	for (const window of windows) {
		try {
			await recordBillingProviderUsage(db, {
				id: crypto.randomUUID(),
				metadata: {
					instanceType: "standard-1",
					leaseId: window.leaseId,
					// Cost arrives later, from allocation of Cloudflare's actual
					// Containers charge. This sweep deliberately does NOT price the
					// row: estimating from lease wall-clock is what produced the 473x
					// over-estimate, and leaving a rate-card call here would let it
					// return silently — and then double-count against the allocation.
					pricingStatus: "pending_allocation",
					profileId: window.profileId,
					recordingPath: "workstation_lease_sweep",
					terminalStatus: window.terminalStatus,
					vcpuExcluded: true,
					...(window.workItemId ? { workItemId: window.workItemId } : {}),
				},
				model: CONTAINER_MODEL,
				now: options.now,
				// The lease END is when the cost is known, so that is when it
				// occurred for reconciliation purposes.
				occurredAt: window.endedAt,
				organizationId: window.orgId,
				provider: CONTAINER_PROVIDER,
				providerCostMicros: 0,
				providerCostQuality: "estimated",
				providerUsageId: workstationUsageId(window.leaseId),
				quantity: window.computeSeconds,
				tediId: window.leadTediId,
				unit: "compute_seconds",
				usageKind: "workstation_compute",
			});
			result.recorded += 1;
			result.computeSeconds += window.computeSeconds;
			if (!window.leadTediId) result.withoutTedi += 1;
		} catch (error) {
			// One unmeterable lease must not strand the rest of the window.
			result.failures.push(
				`${window.leaseId}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return result;
}

export async function runWorkstationComputeMeteringTick(
	env: WorkstationMeteringEnv,
): Promise<Record<string, number>> {
	const { resolveBillingSettlementMode } =
		await import("../lib/billing-settlement-mode");
	if (resolveBillingSettlementMode(env) !== "managed") return {};
	try {
		const { resolveFleetAuthorityDb } = await import("../lib/fleet-authority");
		const db = resolveFleetAuthorityDb(env);
		const now = new Date();
		const result = await meterWorkstationCompute(db, {
			...workstationMeteringWindow(now),
			now: now.toISOString(),
		});
		// Always emit, including a zero scan. An early return here would make a
		// broken sweep indistinguishable from a quiet one.
		console.log(
			JSON.stringify({
				computeSeconds: result.computeSeconds,
				failures: result.failures.length,
				asOf: now.toISOString(),
				orgOnlyAttribution: result.withoutTedi,
				recorded: result.recorded,
				scanned: result.scanned,
				signal: "workstation.compute.metered",
			}),
		);
		if (result.failures.length > 0) {
			console.error(
				`[workstation-compute-metering] ${result.failures.length} lease(s) failed :: ${result.failures.slice(0, 3).join(" | ")}`,
			);
		}
		return {
			scanned: result.scanned,
			recorded: result.recorded,
			withoutTedi: result.withoutTedi,
			failures: result.failures.length,
		};
	} catch (error) {
		console.warn(
			"[workstation-compute-metering] tick failed (non-fatal):",
			error instanceof Error ? error.message : String(error),
		);
		throw error;
	}
}
