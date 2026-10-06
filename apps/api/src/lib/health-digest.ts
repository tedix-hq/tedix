/**
 * Platform-Health Alert Digest
 *
 * The "went dark/dead" counterpart to the cost-anomaly digest (which pages when
 * spend spikes up). This pages when a pipeline or cron goes silent — a failure
 * mode that can otherwise hide for days (an empty cost ledger, silently
 * unscheduled cognitive crons). Runs daily at 08:00 UTC from the apps/api cron.
 *
 * Design:
 * - FIRE-ONLY: silence == healthy. No daily "all green" mail (the top cause of
 *   alert fatigue). A weekly Monday dead-man's-switch heartbeat distinguishes
 *   healthy silence from a dead digest cron.
 * - STATE-TRACKED dedup via ops_alert_state: emails NEW / ESCALATED / RESOLVED
 *   transitions, never an unchanged open condition — the mechanism that keeps
 *   the digest trustworthy. Escalation fires on coarse BUCKETS, not raw deltas.
 * - EDGES not LEVELS: only real state changes get in (ingestion dark, a newly-
 *   dark cron), never standing levels (blocked counts, quality scores) that are
 *   never zero and would train the recipient to filter the sender.
 */

import type { getRecentProviderPricingHealth } from "@tedix/db/queries/billing/health";
import type { DbClient } from "@tedix/db/client";
import type { listGraphProjectionConsumerHealth } from "@tedix/db/queries/graph-projection";
import type {
	NewOpsAlertStateRow,
	OpsAlertStateRow,
} from "@tedix/db/schema/ops-alert-state";
import {
	assertFleetAuthorityAvailable,
	resolveFleetAuthorityDb,
} from "./fleet-authority";

export type HealthSeverity = "P1" | "P2";

export interface HealthCondition {
	/** Deterministic condition identity (the ops_alert_state key). */
	key: string;
	severity: HealthSeverity;
	/** Escalation rank; an open condition re-pages only when this rises. */
	bucketRank: number;
	/** One-line summary for the subject + body. */
	detail: string;
}

export interface ReconcileResult {
	newConditions: HealthCondition[];
	escalated: Array<{ condition: HealthCondition; fromDetail: string }>;
	resolved: OpsAlertStateRow[];
	ongoing: Array<{ condition: HealthCondition; state: OpsAlertStateRow }>;
	/** Rows to upsert (every still-firing condition). */
	writes: NewOpsAlertStateRow[];
	/** Keys to mark resolved (were open, no longer firing). */
	resolvedKeys: string[];
}

/**
 * Conditions reconciled by faster, direct probes retain their own lifecycle.
 * The daily digest may read the same ledger, but it must not infer "resolved"
 * merely because an independently-owned condition was absent from its detector
 * set. Cloudflare credential drift clears only after a complete provider probe.
 */
export function filterHealthDigestOwnedAlertStates(
	states: OpsAlertStateRow[],
): OpsAlertStateRow[] {
	return states.filter(
		(state) => !state.conditionKey.startsWith("cloudflare-credential-drift:"),
	);
}

/**
 * Pure diff of the current firing set against stored open state. New conditions
 * page; conditions whose escalation bucket rose page as ESCALATED; unchanged
 * open conditions are suppressed (state refreshed, no page); open conditions no
 * longer firing resolve.
 */
export function reconcileHealthConditions(
	conditions: HealthCondition[],
	openStates: OpsAlertStateRow[],
	nowIso: string,
): ReconcileResult {
	const openByKey = new Map(openStates.map((s) => [s.conditionKey, s]));
	const firingKeys = new Set(conditions.map((c) => c.key));

	const newConditions: HealthCondition[] = [];
	const escalated: ReconcileResult["escalated"] = [];
	const ongoing: ReconcileResult["ongoing"] = [];
	const writes: NewOpsAlertStateRow[] = [];

	for (const c of conditions) {
		const prev = openByKey.get(c.key);
		if (!prev) {
			newConditions.push(c);
			writes.push({
				conditionKey: c.key,
				severity: c.severity,
				metricBucket: String(c.bucketRank),
				detail: c.detail,
				status: "open",
				firstSeenAt: nowIso,
				lastSeenAt: nowIso,
				lastNotifiedAt: nowIso,
				notifyCount: 1,
			});
			continue;
		}
		const prevRank = Number(prev.metricBucket ?? "0");
		if (c.bucketRank > prevRank) {
			escalated.push({ condition: c, fromDetail: prev.detail });
			writes.push({
				conditionKey: c.key,
				severity: c.severity,
				metricBucket: String(c.bucketRank),
				detail: c.detail,
				status: "open",
				firstSeenAt: prev.firstSeenAt,
				lastSeenAt: nowIso,
				lastNotifiedAt: nowIso,
				notifyCount: (prev.notifyCount ?? 0) + 1,
			});
		} else {
			ongoing.push({ condition: c, state: prev });
			writes.push({
				conditionKey: c.key,
				severity: prev.severity,
				metricBucket: prev.metricBucket,
				detail: c.detail,
				status: "open",
				firstSeenAt: prev.firstSeenAt,
				lastSeenAt: nowIso,
				lastNotifiedAt: prev.lastNotifiedAt ?? null,
				notifyCount: prev.notifyCount ?? 0,
			});
		}
	}

	const resolved = openStates.filter((s) => !firingKeys.has(s.conditionKey));
	return {
		newConditions,
		escalated,
		resolved,
		ongoing,
		writes,
		resolvedKeys: resolved.map((s) => s.conditionKey),
	};
}

export interface HealthDigest {
	subject: string;
	text: string;
}

/**
 * Build the digest email, or return null when nothing warrants sending — a
 * non-weekly run with no NEW/ESCALATED/RESOLVED transitions (fire-only). On a
 * weekly run it always returns a message (the dead-man's-switch heartbeat).
 */
export function buildHealthDigest(
	result: ReconcileResult,
	opts: { isWeeklyHeartbeat: boolean; nowIso: string },
): HealthDigest | null {
	const { newConditions, escalated, resolved, ongoing } = result;
	const hasChanges =
		newConditions.length > 0 || escalated.length > 0 || resolved.length > 0;

	if (!hasChanges && !opts.isWeeklyHeartbeat) return null;

	const sections: string[] = [];
	if (newConditions.length > 0) {
		sections.push(
			`NEW:\n${newConditions
				.map((c) => `  • [${c.severity}] ${c.detail}`)
				.join("\n")}`,
		);
	}
	if (escalated.length > 0) {
		sections.push(
			`ESCALATED:\n${escalated
				.map(
					(e) =>
						`  • [${e.condition.severity}] ${e.condition.detail} (was: ${e.fromDetail})`,
				)
				.join("\n")}`,
		);
	}
	if (resolved.length > 0) {
		sections.push(
			`RESOLVED:\n${resolved
				.map((s) => `  ✓ ${s.detail || s.conditionKey}`)
				.join("\n")}`,
		);
	}
	if (opts.isWeeklyHeartbeat && ongoing.length > 0) {
		sections.push(
			`STILL OPEN:\n${ongoing
				.map(
					(o) =>
						`  • [${o.state.severity}] ${o.condition.detail} (since ${o.state.firstSeenAt})`,
				)
				.join("\n")}`,
		);
	}

	// Subject: stable filterable prefix + severity + count + top condition.
	const active = [...newConditions, ...escalated.map((e) => e.condition)];
	const activeCount = active.length;
	// P1 sorts before P2 lexically, so the first is the highest severity.
	const topSeverity =
		[...active].sort((a, b) => a.severity.localeCompare(b.severity))[0]
			?.severity ?? "P2";
	const topDetail =
		newConditions[0]?.detail ??
		escalated[0]?.condition.detail ??
		resolved[0]?.detail ??
		"";

	let subject: string;
	if (activeCount > 0) {
		subject = `[Tedix Health] ${topSeverity} · ${activeCount} issue${activeCount === 1 ? "" : "s"} · ${topDetail}`;
	} else if (resolved.length > 0) {
		subject = `[Tedix Health] ✓ resolved · ${topDetail}`;
	} else if (ongoing.length > 0) {
		subject = `[Tedix Health] ${ongoing.length} open · weekly summary`;
	} else {
		subject = "[Tedix Health] ✓ nominal · no open incidents";
	}

	const isPureHeartbeat =
		!hasChanges && opts.isWeeklyHeartbeat && ongoing.length === 0;
	const header = isPureHeartbeat
		? "Weekly platform-health heartbeat — no incidents fired in the reporting window. This liveness beat confirms the health digest cron is running."
		: `Platform-health digest at ${opts.nowIso}.`;
	const body =
		sections.length > 0 ? `${header}\n\n${sections.join("\n\n")}` : header;

	return {
		subject,
		text: `${body}\n\nFire-only digest (silence = healthy); the weekly Monday heartbeat confirms liveness. Source: apps/api platform-health cron over D1.`,
	};
}

// ============================================================================
// Detectors — each fail-soft so one broken probe never suppresses the others.
// ============================================================================

/** Coarse staleness ladder (hours) for cost-ledger-dark escalation buckets. */
const LEDGER_STALE_BUCKETS_HOURS = [6, 24, 72, 168] as const;

function stalenessBucketRank(hoursStale: number): number {
	let rank = 0;
	for (let i = 0; i < LEDGER_STALE_BUCKETS_HOURS.length; i++) {
		if (hoursStale >= LEDGER_STALE_BUCKETS_HOURS[i]!) rank = i + 1;
	}
	return rank;
}

export function billingSettlementHealthConditions(
	health: {
		unsettledReservedSuccessCount: number;
		oldestUnsettledAt: string | null;
		latestSettledAt: string | null;
		nonLegacyQuarantined24h: number;
	},
	nowMs: number,
): HealthCondition[] {
	const conditions: HealthCondition[] = [];
	if (health.unsettledReservedSuccessCount > 0 && health.oldestUnsettledAt) {
		const hoursStale =
			(nowMs - new Date(health.oldestUnsettledAt).getTime()) / (60 * 60 * 1000);
		if (hoursStale >= 1) {
			const rounded = Math.round(hoursStale * 10) / 10;
			conditions.push({
				key: "billing-settlement-dark",
				severity: "P1",
				bucketRank: Math.max(1, stalenessBucketRank(hoursStale)),
				detail: `billing settlement dark ${rounded}h (${health.unsettledReservedSuccessCount} reserved successful Gateway rows pending; latest charge ${health.latestSettledAt ?? "never"})`,
			});
		}
	}
	if (health.nonLegacyQuarantined24h > 0) {
		conditions.push({
			key: "billing-settlement-quarantine",
			severity: "P2",
			bucketRank:
				health.nonLegacyQuarantined24h >= 100
					? 3
					: health.nonLegacyQuarantined24h >= 10
						? 2
						: 1,
			detail: `${health.nonLegacyQuarantined24h} current billing usage row${health.nonLegacyQuarantined24h === 1 ? "" : "s"} quarantined in 24h`,
		});
	}
	return conditions;
}

type McpScanBacklog = {
	totalEnabledMcp: number;
	dueNow: number;
	staleOver7d: number;
};

type McpScanRun = {
	status: "queued" | "running" | "completed" | "failed";
	startedAt: string;
	completedAt: string | null;
	workflowId: string;
	output: Record<string, unknown> | null;
};

function finiteOutputNumber(
	output: Record<string, unknown> | null,
	key: string,
): number | null {
	const throughput = output?.throughput;
	if (!throughput || typeof throughput !== "object") return null;
	const value = (throughput as Record<string, unknown>)[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Turn durable scan evidence into incident edges. The hourly runner is dark
 * after two missed cadences; a seven-day stale inventory pages only after it
 * crosses a material fleet-relative floor, then deduplicates in ops_alert_state.
 */
export function mcpScanOperationalConditions(
	backlog: McpScanBacklog,
	latest: McpScanRun | null,
	nowMs: number,
): HealthCondition[] {
	if (backlog.totalEnabledMcp === 0) return [];
	const conditions: HealthCondition[] = [];

	if (!latest) {
		conditions.push({
			key: "mcp-scan-dark",
			severity: "P2",
			bucketRank: 1,
			detail: `MCP catalog scan has no durable run evidence for ${backlog.totalEnabledMcp} enabled endpoints`,
		});
	} else {
		const evidenceAt = latest.completedAt ?? latest.startedAt;
		const hoursStale = (nowMs - new Date(evidenceAt).getTime()) / 3_600_000;
		if (latest.status === "failed") {
			conditions.push({
				key: "mcp-scan-dark",
				severity: "P2",
				bucketRank: 2,
				detail: `MCP catalog scan failed: ${latest.workflowId} at ${evidenceAt}`,
			});
		} else if (hoursStale > 2) {
			conditions.push({
				key: "mcp-scan-dark",
				severity: "P2",
				bucketRank: hoursStale > 6 ? 2 : 1,
				detail: `MCP catalog scan evidence dark ${Math.round(hoursStale * 10) / 10}h (last ${latest.status} run ${latest.workflowId} at ${evidenceAt})`,
			});
		}
	}

	const staleFloor = Math.max(25, Math.ceil(backlog.totalEnabledMcp * 0.05));
	if (backlog.staleOver7d >= staleFloor) {
		const staleRatio = backlog.staleOver7d / backlog.totalEnabledMcp;
		const scansPerMinute = finiteOutputNumber(
			latest?.output ?? null,
			"scansPerMinute",
		);
		const clearanceMinutes = finiteOutputNumber(
			latest?.output ?? null,
			"estimatedMinutesToClear",
		);
		const throughput = scansPerMinute
			? `; latest ${scansPerMinute} scans/min${clearanceMinutes ? `, ${clearanceMinutes}m estimated clearance` : ""}`
			: "";
		conditions.push({
			key: "mcp-scan-backlog",
			severity: "P2",
			bucketRank: staleRatio >= 0.5 ? 3 : staleRatio >= 0.25 ? 2 : 1,
			detail: `MCP scan backlog materially stale: ${backlog.staleOver7d}/${backlog.totalEnabledMcp} endpoints over 7d, ${backlog.dueNow} due now${throughput}`,
		});
	}

	return conditions;
}

/**
 * Pending work and successful progress must both be over six hours old before
 * paging. An idle consumer or a newly resumed queue is not a stalled consumer.
 * Missing, malformed or future success stamps are not proof of progress: the
 * pending head supplies their grace window. Invalid pending stamps are explicit
 * evidence failures rather than NaN comparisons that silently resolve alerts.
 * Reuse the digest's six-hour darkness floor and coarse escalation ladder.
 */
export function graphProjectionConsumerHealthConditions(
	rows: Awaited<ReturnType<typeof listGraphProjectionConsumerHealth>>,
	nowMs: number,
): HealthCondition[] {
	return rows.flatMap((row): HealthCondition[] => {
		if (row.oldestPendingAt === null) return [];
		const pendingMs = Date.parse(row.oldestPendingAt);
		const successMs =
			row.lastSuccessAt === null ? Number.NaN : Date.parse(row.lastSuccessAt);
		const validSuccess = Number.isFinite(successMs) && successMs <= nowMs;
		const key = `graph-projection-stale:${row.organizationId}`;
		if (!Number.isFinite(pendingMs) || pendingMs > nowMs) {
			return [
				{
					key,
					severity: "P2",
					bucketRank: 1,
					detail: `graph projection consumer ${row.organizationId}: invalid pending timestamp; successful progress cannot be assessed`,
				},
			];
		}
		const stalledHours =
			(nowMs - Math.max(pendingMs, validSuccess ? successMs : pendingMs)) /
			3_600_000;
		if (stalledHours <= LEDGER_STALE_BUCKETS_HOURS[0]) return [];
		const successLabel =
			row.lastSuccessAt === null
				? "never"
				: validSuccess
					? row.lastSuccessAt
					: "invalid";
		return [
			{
				key,
				severity: "P2",
				bucketRank: stalenessBucketRank(stalledHours),
				detail: `graph projection consumer ${row.organizationId} stalled ${Math.round(stalledHours * 10) / 10}h (last success ${successLabel}; pending since ${row.oldestPendingAt})`,
			},
		];
	});
}

/** Collect every currently-firing health condition. */
export async function collectHealthConditions(
	db: DbClient,
	nowMs: number,
): Promise<HealthCondition[]> {
	const conditions: HealthCondition[] = [];

	// 1. Cost-ledger ingestion darkness (P1) — row freshness, never dollars.
	try {
		const { getCostLedgerFreshness } =
			await import("@tedix/db/queries/tedi-usage");
		const freshness = await getCostLedgerFreshness(db, nowMs);
		if (freshness.count30d > 0 && freshness.maxSnapshotAt) {
			const hoursStale =
				(nowMs - new Date(freshness.maxSnapshotAt).getTime()) /
				(60 * 60 * 1000);
			if (hoursStale > 6) {
				const rounded = Math.round(hoursStale * 10) / 10;
				conditions.push({
					key: "cost-ledger-dark",
					severity: "P1",
					bucketRank: stalenessBucketRank(hoursStale),
					detail: `cost ledger ingestion dark ${rounded}h (last row ${freshness.maxSnapshotAt}; ${freshness.count24h} rows/24h, ${freshness.count30d}/30d)`,
				});
			}
		}
	} catch (err) {
		console.warn("[health-digest] cost-ledger freshness check failed:", err);
	}

	// 1b. Workstation lease reclamation darkness (P2). Counts leases the reaper
	// should already have expired: a non-zero backlog means reclamation stopped,
	// which silently strands container cost as unattributable and leaks leases.
	// Freshness of a pipeline, never dollars — same shape as the cost ledger
	// check above.
	try {
		const { WORKSTATION_LEASE_IDLE_EXPIRY_HOURS, countStaleWorkstationLeases } =
			await import("@tedix/db/queries/workstations");
		// One full idle window of slack past the threshold, so a lease that only
		// just aged out does not page before the next tick can claim it.
		const graceHours = WORKSTATION_LEASE_IDLE_EXPIRY_HOURS * 2;
		const backlog = await countStaleWorkstationLeases(
			db,
			new Date(nowMs - graceHours * 60 * 60 * 1_000).toISOString(),
		);
		if (backlog.stale > 0) {
			const oldestHours = backlog.oldestUpdatedAt
				? Math.round(
						((nowMs - new Date(backlog.oldestUpdatedAt).getTime()) /
							(60 * 60 * 1_000)) *
							10,
					) / 10
				: 0;
			conditions.push({
				bucketRank: stalenessBucketRank(oldestHours),
				detail: `workstation lease reclamation dark: ${backlog.stale} lease(s) idle past ${graceHours}h unreaped (oldest ${oldestHours}h, last alive ${backlog.oldestUpdatedAt ?? "unknown"})`,
				key: "workstation-lease-reclamation-dark",
				severity: "P2",
			});
		}
	} catch (err) {
		console.warn(
			"[health-digest] workstation lease backlog check failed:",
			err,
		);
	}

	// 2. Billing settlement darkness (P1) and current attribution quarantine (P2).
	try {
		const { getBillingSettlementHealth } =
			await import("@tedix/db/queries/billing/health");
		const health = await getBillingSettlementHealth(
			db,
			new Date(nowMs - 24 * 60 * 60 * 1_000).toISOString(),
		);
		conditions.push(...billingSettlementHealthConditions(health, nowMs));
	} catch (err) {
		console.warn("[health-digest] billing settlement check failed:", err);
	}

	// 3. Cron darkness (P2) — dark cognitive crons, minus budget-suppressed.
	try {
		const { findDarkCognitiveCrons } =
			await import("@tedix/db/queries/flywheel/cron-darkness");
		const { getGovernedLearningScheduleStates } =
			await import("@tedix/db/queries/flywheel/cron-executions");
		const darkCrons = await findDarkCognitiveCrons(db, { now: nowMs });
		if (darkCrons.length > 0) {
			// A cron the S5 homeostat intentionally throttled reads as dark but is
			// working as designed — subtract any actively budget-suppressed cron.
			const byTedi = new Map<string, typeof darkCrons>();
			for (const c of darkCrons) {
				const list = byTedi.get(c.tediId) ?? [];
				list.push(c);
				byTedi.set(c.tediId, list);
			}
			const suppressed = new Set<string>();
			for (const [tediId, crons] of byTedi) {
				try {
					const states = await getGovernedLearningScheduleStates(db, {
						tediId,
						orgId: crons[0]!.orgId,
					});
					for (const s of states) {
						const active = Boolean(
							s.lastBudgetResetAt &&
							new Date(s.lastBudgetResetAt).getTime() > nowMs,
						);
						if (active) suppressed.add(`${tediId}:${s.cronName}`);
					}
				} catch (stateErr) {
					console.warn(
						`[health-digest] budget-state check failed for tedi ${tediId}:`,
						stateErr,
					);
				}
			}
			for (const c of darkCrons) {
				if (suppressed.has(`${c.tediId}:${c.cronName}`)) continue;
				const label = c.tediSlug ?? c.tediId;
				conditions.push({
					key: `cron-dark:${c.tediId}:${c.cronName}`,
					severity: "P2",
					bucketRank: 0,
					detail: `cognitive cron dark: ${label}/${c.cronName} — ${c.hoursSinceLastExecution}h since last stamp (every ${c.expectedIntervalHours}h)`,
				});
			}
		}
	} catch (err) {
		console.warn("[health-digest] cron-darkness check failed:", err);
	}

	// 3. Cron RUN-FAILED (P2) — a cron that fires on schedule but settles failure
	//    reads as healthy to the darkness check (which only inspects freshness).
	//    Reuse the SAME fleet rows for the failure filter and the dark set so a
	//    cron that is both overdue AND failed lists once (dark supersedes).
	try {
		const {
			getEnabledGovernedLearningCronNamesByTedi,
			getFleetLatestCronExecutions,
			findDarkCognitiveCronsFromLedger,
		} = await import("@tedix/db/queries/flywheel/cron-darkness");
		const rows = await getFleetLatestCronExecutions(db);
		const enabledByTedi = await getEnabledGovernedLearningCronNamesByTedi(
			db,
			rows,
		);
		const darkSet = new Set(
			findDarkCognitiveCronsFromLedger(rows, nowMs, enabledByTedi).map(
				(c) => `${c.tediId}:${c.cronName}`,
			),
		);
		for (const row of rows) {
			if (row.status !== "failure") continue;
			if (!enabledByTedi.get(row.tediId)?.has(row.cronName)) continue;
			if (darkSet.has(`${row.tediId}:${row.cronName}`)) continue;
			const label = row.tediSlug ?? row.tediId;
			conditions.push({
				key: `cron-failed:${row.tediId}:${row.cronName}`,
				severity: "P2",
				bucketRank: 0,
				detail: `cognitive cron failed: ${label}/${row.cronName} (${row.mechanism ?? "cron"}) — latest stamp ${row.startedAt} settled failure`,
			});
		}
	} catch (err) {
		console.warn("[health-digest] cron-failed check failed:", err);
	}

	// 4. Runtime/cognition ledger darkness (P1) — tedi_runtime_events is the
	//    canonical, busiest write plane (every turn/tool-call/run/skill). If it
	//    stops emitting fleet-wide, the whole observability + learning stack goes
	//    dark and nothing else here would catch it. Row freshness, not dollars.
	try {
		const { getRuntimeLedgerFreshness } =
			await import("@tedix/db/queries/tedi-usage");
		const rt = await getRuntimeLedgerFreshness(db, nowMs);
		// count7d floor guards a trivially-seeded/empty deployment from paging.
		if (rt.count7d > 100 && rt.maxCreatedAt) {
			const hoursStale =
				(nowMs - new Date(rt.maxCreatedAt).getTime()) / (60 * 60 * 1000);
			if (hoursStale > 6) {
				const rounded = Math.round(hoursStale * 10) / 10;
				conditions.push({
					key: "runtime-ledger-dark",
					severity: "P1",
					bucketRank: stalenessBucketRank(hoursStale),
					detail: `runtime/cognition ledger dark ${rounded}h (last event ${rt.maxCreatedAt}; ${rt.count1h}/1h, ${rt.count24h}/24h, ${rt.count7d}/7d)`,
				});
			}
		}
	} catch (err) {
		console.warn("[health-digest] runtime-ledger freshness check failed:", err);
	}

	// 5. MCP scan operations (P2). The hourly workflow has a durable ledger,
	//    while the catalog summary distinguishes a transient due queue from a
	//    materially stale seven-day backlog. Both conditions keep stable keys so
	//    the digest pages transitions instead of repeating standing counts.
	try {
		const [
			{ getCatalogScanBacklogSummary },
			{ getLatestWorkflowRunRecordsByTypes },
		] = await Promise.all([
			import("@tedix/db/queries/catalog/health-metrics"),
			import("@tedix/db/queries/workflow-runs"),
		]);
		const [backlog, latestRuns] = await Promise.all([
			getCatalogScanBacklogSummary(db),
			getLatestWorkflowRunRecordsByTypes(db, ["mcp_scan"]),
		]);
		conditions.push(
			...mcpScanOperationalConditions(backlog, latestRuns[0] ?? null, nowMs),
		);
	} catch (err) {
		console.warn("[health-digest] MCP scan operations check failed:", err);
	}

	// Successful projection, not lease activity, is the progress signal.
	try {
		const { listGraphProjectionConsumerHealth } =
			await import("@tedix/db/queries/graph-projection");
		conditions.push(
			...graphProjectionConsumerHealthConditions(
				await listGraphProjectionConsumerHealth(db),
				nowMs,
			),
		);
	} catch (err) {
		console.warn(
			"[health-digest] graph projection consumer check failed:",
			err,
		);
	}

	return conditions;
}

const PRICING_CONDITION_KEY = "provider-pricing-incomplete";

/** Bounded diagnostic text, never raw metadata or high-cardinality alert keys. */
export function providerPricingHealthConditions(
	health: Awaited<ReturnType<typeof getRecentProviderPricingHealth>>,
): HealthCondition[] {
	if (health.affectedRows === 0) return [];
	const display = (value: string | null) =>
		(value ?? "unknown")
			.replace(/[\p{Cc}\p{Cf}]/gu, " ")
			.replace(/[<>&]/g, "")
			.slice(0, 70);
	const examples = health.groups
		.slice(0, 3)
		.map(
			(group) =>
				`${display(group.provider)}/${display(group.model)} gateway=${display(group.gatewayId)} resource=${display(group.providerResource)} deployment=${display(group.deployment)}: ${display(group.reason)} (${group.rowCount})`,
		)
		.join("; ");
	return [
		{
			key: PRICING_CONDITION_KEY,
			severity: "P2",
			bucketRank:
				health.affectedRows >= 100 ? 3 : health.affectedRows >= 10 ? 2 : 1,
			detail: `${health.affectedRows} incomplete provider pricing observations in the last 24h (${health.missingRateRows} missing rate, ${health.affectedRows - health.missingRateRows} other evidence gaps; ${health.unattributedRows} unattributed, ${health.unreservedRows} unreserved). ${examples}${health.omittedGroupCount ? `; ${health.omittedGroupCount} additional groups outside the query examples` : ""}. Resolution means no recent incomplete observations, not historical repair or charging.`,
		},
	];
}

export interface HealthDigestRunResult {
	conditionCount: number;
	newCount: number;
	escalatedCount: number;
	resolvedCount: number;
	emailed: boolean;
}

/**
 * Run the daily platform-health digest: detect → reconcile against stored state
 * → persist → email NEW/ESCALATED/RESOLVED (or the weekly heartbeat). Never
 * throws into the cron; the caller also guards. A no-op on email delivery until
 * HEALTH_ALERT_EMAIL is set, but the structured `platform.health.digest` log
 * fires every run regardless.
 */
export async function runPlatformHealthDigest(
	env: CloudflareEnv,
	opts: { scheduledTimeMs: number },
): Promise<HealthDigestRunResult> {
	const { listOpenAlertStates, recordAlertState, markAlertsResolved } =
		await import("@tedix/db/queries/ops-alert-state");
	assertFleetAuthorityAvailable(env);
	const db = resolveFleetAuthorityDb(env);

	const nowMs = opts.scheduledTimeMs;
	const nowIso = new Date(nowMs).toISOString();
	// Weekly dead-man's-switch heartbeat on Mondays (UTC day 1).
	const isWeeklyHeartbeat = new Date(nowMs).getUTCDay() === 1;

	const conditions = await collectHealthConditions(db, nowMs);
	let pricingQuerySucceeded = false;
	try {
		const { getRecentProviderPricingHealth } =
			await import("@tedix/db/queries/billing/health");
		const pricing = await getRecentProviderPricingHealth(db, {
			sinceInclusive: new Date(nowMs - 24 * 60 * 60 * 1000).toISOString(),
			untilExclusive: nowIso,
		});
		conditions.push(...providerPricingHealthConditions(pricing));
		pricingQuerySucceeded = true;
	} catch (error) {
		console.error(
			"[health-digest] provider pricing evidence query failed:",
			error,
		);
	}
	const ownedStates = filterHealthDigestOwnedAlertStates(
		await listOpenAlertStates(db),
	);
	const unverifiedPricingStates = pricingQuerySucceeded
		? []
		: ownedStates.filter(
				(state) => state.conditionKey === PRICING_CONDITION_KEY,
			);
	const result = reconcileHealthConditions(
		conditions,
		ownedStates.filter(
			(state) =>
				pricingQuerySucceeded || state.conditionKey !== PRICING_CONDITION_KEY,
		),
		nowIso,
	);
	// Retain the unresolved incident in presentation, without claiming a fresh
	// observation or adding a persistence write/resolution on detector failure.
	for (const state of unverifiedPricingStates) {
		result.ongoing.push({
			state,
			condition: {
				key: state.conditionKey,
				severity: state.severity as HealthSeverity,
				bucketRank: Number(state.metricBucket ?? "0"),
				detail: `Provider pricing evidence source unavailable; still unresolved (current status unknown): ${state.detail}`,
			},
		});
	}

	// Persist state (open upserts + resolutions) before emailing.
	for (const row of result.writes) {
		try {
			await recordAlertState(db, row);
		} catch (err) {
			console.warn(
				`[health-digest] failed to persist alert state ${row.conditionKey}:`,
				err,
			);
		}
	}
	if (result.resolvedKeys.length > 0) {
		try {
			await markAlertsResolved(db, result.resolvedKeys, nowIso);
		} catch (err) {
			console.warn("[health-digest] failed to mark resolutions:", err);
		}
	}

	const digest = buildHealthDigest(result, { isWeeklyHeartbeat, nowIso });
	let emailed = false;
	// Deliver via the shared multi-channel egress. Each channel self-gates, so
	// the webhook backstop fires even when HEALTH_ALERT_EMAIL is empty — the
	// whole point of the dead-man's-switch having an independent second path.
	if (digest) {
		try {
			const { sendOpsAlert } = await import("./ops-alert-egress");
			const res = await sendOpsAlert(env, {
				subject: digest.subject,
				text: digest.text,
				emailRecipients: env.HEALTH_ALERT_EMAIL,
				webhookUrl: env.HEALTH_ALERT_WEBHOOK,
				fromName: "Tedix Platform Health",
				meta: {
					firing: conditions.length,
					new: result.newConditions.length,
					escalated: result.escalated.length,
					resolved: result.resolved.length,
					weeklyHeartbeat: isWeeklyHeartbeat,
				},
			});
			emailed = res.emailed;
		} catch (err) {
			console.warn("[health-digest] alert egress failed:", err);
		}
	}

	console.log(
		JSON.stringify({
			signal: "platform.health.digest",
			asOf: nowIso,
			firing: conditions.length,
			new: result.newConditions.length,
			escalated: result.escalated.length,
			resolved: result.resolved.length,
			ongoing: result.ongoing.length,
			emailed,
			weeklyHeartbeat: isWeeklyHeartbeat,
		}),
	);

	return {
		conditionCount: conditions.length,
		newCount: result.newConditions.length,
		escalatedCount: result.escalated.length,
		resolvedCount: result.resolved.length,
		emailed,
	};
}
