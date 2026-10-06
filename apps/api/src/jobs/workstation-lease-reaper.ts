/**
 * Idle workstation-lease reaper.
 *
 * `createWorkstationLease()` defaults `expiresAt` to null and callers do not
 * pass one, so without this job the only way a lease ends is an explicit
 * `POST /release`, and leaked leases stay non-terminal indefinitely.
 *
 * Two things follow from that, and this job fixes both:
 *  - Leaked leases are never reclaimed.
 *  - Their container time is unattributable forever, because
 *    `workstation-compute-metering` reads `releasedAt ?? expiresAt` and a
 *    lease that never terminates has neither.
 *
 * IDLE, NOT AGED. `updated_at` moves on every workstation operation, so
 * idleness is what distinguishes a leak from a long-running legitimate
 * session. A fixed TTL from creation would reclaim the first by killing the
 * second — and dev servers are an explicitly supported workstation use.
 *
 * Runs BEFORE metering on the same tick so a newly expired lease is billed in
 * the same pass rather than waiting for the next one.
 *
 * RECLAIMING THE LEASE IS NOT RECLAIMING THE BUNDLE. Expiry flips the lease and
 * stops; a real release also closes participants, sessions, and the workstation.
 * So the two ways a lease can end left the database in two different shapes, and
 * every reaped lease stranded its children — 162 participants still `active`,
 * 643 sessions still open, and 165 unarchived workstations against 181 terminal
 * leases in production. `closeTerminalLeaseBundles` converges both paths on the
 * same terminal shape and heals the existing backlog, which patching expiry
 * alone could not: the reaper never revisits a lease once it is terminal.
 */

import type { DbClient } from "@tedix/db/client";
import {
	WORKSTATION_LEASE_IDLE_EXPIRY_HOURS,
	closeTerminalLeaseBundles,
	expireIdleWorkstationLeases,
} from "@tedix/db/queries/workstations";
import type { BillingSettlementBindings } from "../lib/billing-settlement-mode";
import type { FleetAuthorityEnv } from "../lib/fleet-authority";

export type WorkstationReaperEnv = BillingSettlementBindings &
	FleetAuthorityEnv & { TEDI_SERVICE?: Fetcher };

/**
 * Bound so a wedged edge cannot hold the cron tick open. A missed reap is one
 * tick of container time; a stuck tick stops lease reclamation entirely.
 */
const BODY_REAP_TIMEOUT_MS = 20_000;

/**
 * Reclaiming the lease row is not reclaiming the container.
 *
 * Expiry and bundle closure both stop at D1, so a body kept running after its
 * last lease went terminal was billed forever and no operator could safely stop
 * it — the lease named no instance. apps/tedi now records the container
 * identity on the lease and owns the only mechanism that can stop one (a
 * Durable Object can destroy its own container; no REST or Wrangler call can
 * stop a single instance), so this tick asks that edge to reap.
 *
 * Never fatal: the lease ledger is already correct by the time this runs.
 */
async function reapWorkstationBodies(
	env: WorkstationReaperEnv,
): Promise<number> {
	const service = env.TEDI_SERVICE;
	if (!service) return 0;
	try {
		const response = await service.fetch(
			"http://tedi/internal/workstation/reap",
			{
				method: "POST",
				headers: { "X-Service-Binding": "true" },
				signal: AbortSignal.timeout(BODY_REAP_TIMEOUT_MS),
			},
		);
		if (!response.ok) return 0;
		const body = (await response.json()) as {
			results?: { reaped?: unknown }[];
		};
		return (body.results ?? []).filter((result) => result.reaped === true)
			.length;
	} catch (error) {
		console.warn(
			"[workstation-lease-reaper] body reap failed (non-fatal):",
			error instanceof Error ? error.message : String(error),
		);
		return 0;
	}
}

/**
 * Bounded per tick. The first production run has a ~137 lease backlog to clear,
 * and each expiry is its own guarded UPDATE; draining it over a few ticks keeps
 * one cron invocation inside its time budget.
 */
const MAX_LEASES_PER_TICK = 50;

/**
 * Bundle closure is bounded separately: it issues three guarded UPDATEs per
 * lease, so a smaller batch keeps one tick inside its time budget while the
 * ~165 lease backlog drains over a few ticks.
 */
const MAX_BUNDLES_PER_TICK = 25;

export interface WorkstationReaperResult {
	expired: number;
	byPreviousStatus: Record<string, number>;
}

export function workstationIdleCutoff(
	now: Date,
	idleHours = WORKSTATION_LEASE_IDLE_EXPIRY_HOURS,
): string {
	return new Date(now.getTime() - idleHours * 60 * 60 * 1000).toISOString();
}

export async function reapIdleWorkstationLeases(
	db: DbClient,
	options: { idleBefore: string; now: string; limit?: number },
): Promise<WorkstationReaperResult> {
	const expired = await expireIdleWorkstationLeases(db, {
		idleBefore: options.idleBefore,
		limit: options.limit ?? MAX_LEASES_PER_TICK,
		now: options.now,
	});
	const byPreviousStatus: Record<string, number> = {};
	for (const lease of expired) {
		byPreviousStatus[lease.previousStatus] =
			(byPreviousStatus[lease.previousStatus] ?? 0) + 1;
	}
	return { byPreviousStatus, expired: expired.length };
}

export async function runWorkstationLeaseReaperTick(
	env: WorkstationReaperEnv,
): Promise<Record<string, number>> {
	const { resolveBillingSettlementMode } =
		await import("../lib/billing-settlement-mode");
	if (resolveBillingSettlementMode(env) !== "managed") return {};
	try {
		const { resolveFleetAuthorityDb } = await import("../lib/fleet-authority");
		const db = resolveFleetAuthorityDb(env);
		const now = new Date();
		const result = await reapIdleWorkstationLeases(db, {
			idleBefore: workstationIdleCutoff(now),
			now: now.toISOString(),
		});
		// Runs AFTER expiry so a lease reaped on this tick has its bundle closed
		// on the same tick rather than waiting for the next one.
		const closed = await closeTerminalLeaseBundles(db, {
			limit: MAX_BUNDLES_PER_TICK,
			now: now.toISOString(),
		});
		// Runs LAST: a body becomes reapable only once every lease naming it is
		// terminal, which expiry and closure on this same tick may have just made
		// true.
		const bodiesReaped = await reapWorkstationBodies(env);
		const bundleTotals = closed.reduce(
			(totals, bundle) => ({
				participants: totals.participants + bundle.participants,
				sessions: totals.sessions + bundle.sessions,
				workstations:
					totals.workstations + (bundle.workstationArchived ? 1 : 0),
			}),
			{ participants: 0, sessions: 0, workstations: 0 },
		);
		// Emitted on every tick, including zero. A reaper that silently stops
		// looks identical to a fleet with nothing to reclaim, and the backlog it
		// leaves stays invisible until leases pile up — so the health digest
		// carries a `workstation-lease-reclamation-dark` condition off the same
		// underlying data.
		console.log(
			JSON.stringify({
				asOf: now.toISOString(),
				bodiesReaped,
				bundlesClosed: closed.length,
				byPreviousStatus: result.byPreviousStatus,
				expired: result.expired,
				idleHours: WORKSTATION_LEASE_IDLE_EXPIRY_HOURS,
				participantsClosed: bundleTotals.participants,
				sessionsArchived: bundleTotals.sessions,
				signal: "workstation.lease.reaped",
				workstationsArchived: bundleTotals.workstations,
			}),
		);
		return {
			bodiesReaped,
			leasesExpired: result.expired,
			bundlesClosed: closed.length,
			participantsClosed: bundleTotals.participants,
			sessionsArchived: bundleTotals.sessions,
			workstationsArchived: bundleTotals.workstations,
		};
	} catch (error) {
		console.warn(
			"[workstation-lease-reaper] tick failed (non-fatal):",
			error instanceof Error ? error.message : String(error),
		);
		throw error;
	}
}
