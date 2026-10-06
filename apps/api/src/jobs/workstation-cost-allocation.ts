/**
 * Container cost allocation — the replacement for pricing lease wall-clock.
 *
 * Multiplying lease duration by a rate card over-estimates container cost by
 * orders of magnitude. The problem is the quantity, not the rate.
 * `listWorkstationLeaseComputeWindows` derives compute seconds from
 * `(releasedAt ?? expiresAt) - createdAt`, a D1 lifecycle span. Containers
 * sleep after ~15m idle (`resolveWorkstationSleepAfter`) and wake on demand, so
 * that span is an envelope containing the container's real activity, not a
 * measure of it: a span can run for weeks around a container that was awake
 * in bursts.
 *
 * No amount of releasing leases sooner fixes that: a shorter envelope is still
 * an envelope. And nothing else in D1 measures container-active time either
 * (`workstation_sessions` are the same shape, and many never close).
 *
 * So this inverts the direction. Cloudflare's actual per-period Containers
 * charge is the numerator, and lease-seconds are demoted to a share key. The
 * allocated total is bounded by construction — it cannot exceed what the
 * account was billed, which is exactly the failure mode that made the estimate
 * worthless.
 *
 * What this does not claim. A wall-clock share is a proxy. Two tenants whose
 * containers were awake for very different fractions of their lease envelopes
 * will be allocated as if they were awake for the same fraction. That is
 * recorded honestly in `allocationBasis` rather than hidden, and it is a
 * bounded misattribution BETWEEN tenants instead of an unbounded error in the
 * total.
 *
 * The unallocated remainder is the signal. Allocation deliberately spreads the
 * charge only across rows that exist. If Cloudflare billed for Containers in a
 * period where no lease row landed, the remainder stays unallocated and is
 * reported — that is container spend we cannot tie to any lease, and it is the
 * one thing worth waking someone for. Allocating the remainder evenly would
 * erase that signal and make the reconciliation self-fulfilling.
 */

import type { DbClient } from "@tedix/db/client";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	applyWorkstationComputeCostAllocation,
	listWorkstationComputeForAllocation,
} from "@tedix/db/queries/billing/provider-usage";

/** Bounded so one period cannot fan out unboundedly on a backlog replay. */
const MAX_ROWS_PER_PERIOD = 500;

export interface ContainerCostAllocation {
	id: string;
	costMicros: number;
	/** Share of the period's charge, in basis points, for audit. */
	shareBasisPoints: number;
}

export interface ContainerCostAllocationPlan {
	allocations: ContainerCostAllocation[];
	allocatedMicros: number;
	unallocatedMicros: number;
	totalQuantity: number;
}

/**
 * Distribute one period's charge across rows pro-rata by quantity.
 *
 * Largest-remainder, so the allocated micros sum EXACTLY to the charge instead
 * of drifting by a few micros per row — a floor-only split of 147 rows loses
 * real money at the bottom and makes the reconciliation report a variance that
 * is pure rounding.
 *
 * With no rows, or no quantity to divide by, nothing is allocated and the whole
 * charge is returned as unallocated. Spreading a charge evenly across rows that
 * did no work would be inventing attribution.
 */
export function planContainerCostAllocation(input: {
	totalCostMicros: number;
	rows: { id: string; quantity: number }[];
}): ContainerCostAllocationPlan {
	const charge = Math.max(0, Math.round(input.totalCostMicros));
	const rows = input.rows.filter((row) => row.quantity > 0);
	const totalQuantity = rows.reduce((sum, row) => sum + row.quantity, 0);
	if (charge === 0 || totalQuantity === 0) {
		return {
			allocatedMicros: 0,
			allocations: [],
			totalQuantity,
			unallocatedMicros: charge,
		};
	}

	const exact = rows.map((row) => {
		const share = (row.quantity * charge) / totalQuantity;
		const floor = Math.floor(share);
		return {
			floor,
			id: row.id,
			quantity: row.quantity,
			remainder: share - floor,
		};
	});
	let assigned = exact.reduce((sum, row) => sum + row.floor, 0);
	// Ties break on the row order the caller supplied, which is ordered by id,
	// so replaying a settled period distributes the same micros to the same rows.
	const byRemainder = [...exact].sort((a, b) => b.remainder - a.remainder);
	const micros = new Map(exact.map((row) => [row.id, row.floor]));
	for (const row of byRemainder) {
		if (assigned >= charge) break;
		micros.set(row.id, (micros.get(row.id) ?? 0) + 1);
		assigned += 1;
	}

	const allocations = exact.map((row) => ({
		costMicros: micros.get(row.id) ?? 0,
		id: row.id,
		shareBasisPoints: Math.round((row.quantity / totalQuantity) * 10_000),
	}));
	return {
		allocatedMicros: assigned,
		allocations,
		totalQuantity,
		unallocatedMicros: charge - assigned,
	};
}

export interface ContainerCostAllocationResult {
	rows: number;
	updated: number;
	allocatedMicros: number;
	unallocatedMicros: number;
	totalQuantity: number;
}

/**
 * Allocate a Containers charge onto the period's `workstation_compute` ledger.
 *
 * Idempotent: re-running a period recomputes the same split from the same rows
 * and overwrites the same values, so a replayed billing window settles rather
 * than accumulates.
 */
export async function allocateContainerCostForPeriod(
	db: DbClient,
	options: {
		periodStart: string;
		periodEnd: string;
		totalCostMicros: number;
		evidenceRef: string;
		now: string;
	},
): Promise<ContainerCostAllocationResult> {
	const targets = await listWorkstationComputeForAllocation(db, {
		limit: MAX_ROWS_PER_PERIOD,
		periodEnd: options.periodEnd,
		periodStart: options.periodStart,
	});
	const plan = planContainerCostAllocation({
		rows: targets.map((target) => ({
			id: target.id,
			quantity: target.quantity,
		})),
		totalCostMicros: options.totalCostMicros,
	});
	const shareById = new Map(
		plan.allocations.map((allocation) => [allocation.id, allocation]),
	);
	const updates = targets.flatMap((target) => {
		const allocation = shareById.get(target.id);
		if (!allocation) return [];
		const metadata: Record<string, JsonValue> = {
			...target.metadata,
			allocation: {
				// Named so nobody reads the cost as a measurement of container
				// uptime. It is a share of a real bill, keyed on a proxy.
				basis: "workstation_lease_wall_clock_share",
				chargePeriod: `${options.periodStart}..${options.periodEnd}`,
				chargeSourceRef: options.evidenceRef,
				chargeTotalMicros: options.totalCostMicros,
				shareBasisPoints: allocation.shareBasisPoints,
			},
			pricingStatus: "allocated",
		};
		return [
			{
				id: target.id,
				metadata,
				providerCostMicros: allocation.costMicros,
			},
		];
	});
	const updated = await applyWorkstationComputeCostAllocation(db, updates);
	return {
		allocatedMicros: plan.allocatedMicros,
		rows: targets.length,
		totalQuantity: plan.totalQuantity,
		unallocatedMicros: plan.unallocatedMicros,
		updated,
	};
}
