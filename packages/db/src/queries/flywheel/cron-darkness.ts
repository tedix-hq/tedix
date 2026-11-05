import { resolveEnabledGovernedLearningCronNames } from "@tedix/api-contract/utils/governed-learning";
import { and, eq, inArray, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../../client";
import {
	skillEntries,
	skillRuns,
	skillSchedules,
} from "../../schema/cognitive";
import { policyPacks } from "../../schema/control-plane";
import { tediCronExecutions } from "../../schema/cron-executions";
import { tedis } from "../../schema/tedis";
import { workItems } from "../../schema/work-items";
import { createWorkItem, type CreateWorkItemParams } from "../work-items/crud";
import { workItemPurposeFor } from "../work-items/purpose";
import {
	COGNITIVE_SKILL_SLUGS,
	CRON_DARKNESS_GRACE_FACTOR,
	EXPECTED_COGNITIVE_CRONS,
} from "./cron-executions";

/** Provenance source tag for cron-darkness alert work items. */
export const CRON_DARKNESS_ALERT_SOURCE = "flywheel.cronDarknessCheck";

/**
 * Deterministic dedupe key: one alert work item per tedi, ever —
 * `uniq_work_items_org_source_intent` makes (orgId, sourceIntentId) unique, so
 * repeated dark days upsert (refresh) the same item instead of duplicating.
 */
export function cronDarknessSourceIntentId(tediId: string): string {
	return `flywheel-cron-darkness:${tediId}`;
}

export interface FleetCronExecutionRow {
	tediId: string;
	orgId: string;
	tediSlug: string | null;
	cronName: string;
	/** Latest ledger stamp for this (tedi, cron). */
	startedAt: string;
	/**
	 * Oldest ledger stamp for this (tedi, cron) — the participation clock input.
	 * The never-stamped inference references MIN(firstStartedAt) across a tedi's
	 * cognitive crons, NOT the latest sibling stamps: on a healthy tedi every
	 * latest stamp is fresher than a daily cron's 36h grace, so a latest-stamp
	 * reference could never flag a permanently unscheduled daily cron.
	 */
	firstStartedAt: string;
	/** Status from the same row as MAX(started_at). */
	status: string;
	mechanism?: "legacy_cron" | "scheduled_skill_workflow";
}

export interface DarkCognitiveCron {
	tediId: string;
	orgId: string;
	tediSlug: string | null;
	cronName: string;
	expectedIntervalHours: number;
	/** Number of cognitive loops enabled for this tedi by policy/schedules. */
	expectedCronCount: number;
	/** Latest ledger stamp, or null when this cron never stamped at all. */
	lastStartedAt: string | null;
	lastStatus: string | null;
	/**
	 * Hours since the last stamp — or, for a never-stamped cron, hours since the
	 * tedi's oldest cognitive-cron stamp (its participation clock).
	 */
	hoursSinceLastExecution: number;
}

/**
 * Latest execution stamp per (active tedi, expected cognitive cron), plus the
 * oldest stamp per (tedi, cron) as the participation-clock input. Archived/
 * standby tedis are excluded — a standby tedi is expected-quiet, not dark.
 * Bare `status` rides the MAX(started_at) row (documented SQLite semantics,
 * same as {@link getLatestCronExecutions}).
 */
export async function getFleetLatestCronExecutions(
	db: DbClient,
	options: { orgId?: string } = {},
): Promise<FleetCronExecutionRow[]> {
	const executions = db.$with("executions").as(
		unionAll(
			db
				.select({
					tediId: sql<string>`${tediCronExecutions.tediId}`.as("tediId"),
					orgId: sql<string>`${tediCronExecutions.orgId}`.as("orgId"),
					cronName: sql<string>`${tediCronExecutions.cronName}`.as("cronName"),
					startedAt: sql<string>`${tediCronExecutions.startedAt}`.as(
						"startedAt",
					),
					status: sql<string>`${tediCronExecutions.status}`.as("status"),
					mechanism: sql<FleetCronExecutionRow["mechanism"]>`'legacy_cron'`.as(
						"mechanism",
					),
				})
				.from(tediCronExecutions)
				.where(
					inArray(
						tediCronExecutions.cronName,
						EXPECTED_COGNITIVE_CRONS.map((cron) => cron.name),
					),
				),
			db
				.select({
					tediId: sql<string>`${skillRuns.tediId}`.as("tediId"),
					orgId: sql<string>`${skillRuns.organizationId}`.as("orgId"),
					cronName:
						sql<string>`replace(replace(${skillRuns.skillSlug}, 'platform-', ''), '-dogfood', '')`.as(
							"cronName",
						),
					startedAt: sql<string>`${skillRuns.startedAt}`.as("startedAt"),
					status: sql<string>`CASE
						WHEN ${skillRuns.status} = 'completed' THEN 'success'
						WHEN ${skillRuns.status} IN ('failed', 'canceled') THEN 'failure'
						ELSE 'running'
					END`.as("status"),
					mechanism: sql<
						FleetCronExecutionRow["mechanism"]
					>`'scheduled_skill_workflow'`.as("mechanism"),
				})
				.from(skillRuns)
				.where(
					and(
						eq(skillRuns.createdBy, "schedule"),
						inArray(skillRuns.skillSlug, [...COGNITIVE_SKILL_SLUGS]),
					),
				),
		),
	);
	// firstStartedAt comes from its own grouped CTE, NOT a second MIN()
	// aggregate here: SQLite's bare-column guarantee (status rides the
	// MAX(started_at) row) only holds when the query has exactly one
	// min()/max() aggregate.
	const firstStamps = db.$with("first_stamps").as(
		db
			.select({
				tediId: executions.tediId,
				cronName: executions.cronName,
				firstStartedAt: sql<string>`MIN(${executions.startedAt})`.as(
					"firstStartedAt",
				),
			})
			.from(executions)
			.groupBy(executions.tediId, executions.cronName),
	);
	return db
		.with(executions, firstStamps)
		.select({
			tediId: executions.tediId,
			orgId: executions.orgId,
			tediSlug: sql<string | null>`${tedis.slug}`.as("tediSlug"),
			cronName: executions.cronName,
			startedAt: sql<string>`MAX(${executions.startedAt})`.as("startedAt"),
			firstStartedAt: firstStamps.firstStartedAt,
			status: executions.status,
			mechanism: executions.mechanism,
		})
		.from(executions)
		.innerJoin(tedis, eq(tedis.id, executions.tediId))
		.innerJoin(
			firstStamps,
			and(
				eq(firstStamps.tediId, executions.tediId),
				eq(firstStamps.cronName, executions.cronName),
			),
		)
		.where(
			and(
				eq(tedis.runtimeState, "active"),
				options.orgId ? eq(executions.orgId, options.orgId) : undefined,
			),
		)
		.groupBy(executions.tediId, executions.orgId, executions.cronName);
}

/**
 * Pure darkness projection over the fleet's latest stamps (the chaos-test
 * seam). A cron is dark when:
 *
 * - its latest stamp is older than 1.5× its expected interval, or
 * - it never stamped at all while the tedi has been PARTICIPATING in the
 *   cognitive tier for longer than that same grace window (a single cron
 *   silently dropped from the schedule). Participation is the tedi's oldest
 *   cognitive-cron stamp (MIN over `firstStartedAt`), NOT its latest sibling
 *   stamps: on a healthy tedi every latest stamp is fresher than a daily
 *   cron's 36h grace, so a latest-stamp reference clock could never flag a
 *   permanently unscheduled 24h cron. A tedi with zero cognitive stamps
 *   produces no findings — the ledger cannot distinguish "unscheduled" from
 *   "not a cognitive tedi", and fresh tedis must not page before their first
 *   fire.
 */
export function findDarkCognitiveCronsFromLedger(
	rows: FleetCronExecutionRow[],
	nowMs: number,
	enabledCronNamesByTedi?: ReadonlyMap<string, ReadonlySet<string>>,
): DarkCognitiveCron[] {
	const expectedNames = new Set<string>(
		EXPECTED_COGNITIVE_CRONS.map((cron) => cron.name),
	);
	const byTedi = new Map<string, FleetCronExecutionRow[]>();
	for (const row of rows) {
		if (!expectedNames.has(row.cronName)) continue;
		const list = byTedi.get(row.tediId) ?? [];
		list.push(row);
		byTedi.set(row.tediId, list);
	}

	const dark: DarkCognitiveCron[] = [];
	for (const tediRows of byTedi.values()) {
		const first = tediRows[0]!;
		const enabledCronNames =
			enabledCronNamesByTedi?.get(first.tediId) ?? expectedNames;
		if (enabledCronNames.size === 0) continue;
		// Participation clock: how long this tedi has been stamping ANY
		// cognitive cron — the reference for never-stamped inference.
		const participationMs = Math.min(
			...tediRows.map((row) => new Date(row.firstStartedAt).getTime()),
		);
		for (const cron of EXPECTED_COGNITIVE_CRONS) {
			if (!enabledCronNames.has(cron.name)) continue;
			const graceMs =
				cron.intervalHours * CRON_DARKNESS_GRACE_FACTOR * 60 * 60 * 1000;
			const row = tediRows.find((item) => item.cronName === cron.name);
			const referenceMs = row
				? new Date(row.startedAt).getTime()
				: participationMs;
			const elapsedMs = nowMs - referenceMs;
			if (elapsedMs <= graceMs) continue;
			dark.push({
				tediId: first.tediId,
				orgId: first.orgId,
				tediSlug: first.tediSlug,
				cronName: cron.name,
				expectedIntervalHours: cron.intervalHours,
				expectedCronCount: enabledCronNames.size,
				lastStartedAt: row?.startedAt ?? null,
				lastStatus: row?.status ?? null,
				hoursSinceLastExecution:
					Math.round((elapsedMs / (60 * 60 * 1000)) * 10) / 10,
			});
		}
	}
	return dark;
}

/**
 * Cognitive crons overdue past 1.5× their expected interval, per active tedi,
 * based on the WS0 execution ledger. Optional org scoping; fleet-wide default.
 */
export async function findDarkCognitiveCrons(
	db: DbClient,
	options: { orgId?: string; now?: number } = {},
): Promise<DarkCognitiveCron[]> {
	const rows = await getFleetLatestCronExecutions(db, options);
	const enabledCronNamesByTedi =
		await getEnabledGovernedLearningCronNamesByTedi(db, rows);
	return findDarkCognitiveCronsFromLedger(
		rows,
		options.now ?? Date.now(),
		enabledCronNamesByTedi,
	);
}

interface FleetCronGovernanceRow {
	tediId: string;
	policyPackDefinition: unknown;
	runtimeOverrides: unknown;
	skillSlug: string | null;
}

/** Batch-resolve policy and enabled skill schedules for participating tedis. */
export async function getEnabledGovernedLearningCronNamesByTedi(
	db: DbClient,
	rows: FleetCronExecutionRow[],
): Promise<Map<string, ReadonlySet<string>>> {
	const tediIds = [...new Set(rows.map((row) => row.tediId))];
	if (tediIds.length === 0) return new Map();
	// JSON columns stay raw TEXT for the governed-learning resolver.
	const governanceRows: FleetCronGovernanceRow[] = await db
		.select({
			tediId: sql<string>`${tedis.id}`.as("tediId"),
			runtimeOverrides: sql<unknown>`${tedis.runtimeOverrides}`.as(
				"runtimeOverrides",
			),
			policyPackDefinition: sql<unknown>`${policyPacks.definition}`.as(
				"policyPackDefinition",
			),
			skillSlug: sql<string | null>`${skillEntries.slug}`.as("skillSlug"),
		})
		.from(tedis)
		.leftJoin(policyPacks, eq(policyPacks.id, tedis.policyPackId))
		.leftJoin(
			skillSchedules,
			and(
				eq(skillSchedules.tediId, tedis.id),
				sql`${skillSchedules.enabled} = 1`,
			),
		)
		.leftJoin(
			skillEntries,
			and(
				eq(skillEntries.id, skillSchedules.skillId),
				inArray(skillEntries.slug, [...COGNITIVE_SKILL_SLUGS]),
			),
		)
		.where(inArray(tedis.id, tediIds));
	const byTedi = new Map<string, FleetCronGovernanceRow[]>();
	for (const row of governanceRows) {
		const list = byTedi.get(row.tediId) ?? [];
		list.push(row);
		byTedi.set(row.tediId, list);
	}
	return new Map(
		[...byTedi].map(([tediId, tediRows]) => {
			const first = tediRows[0]!;
			return [
				tediId,
				resolveEnabledGovernedLearningCronNames({
					policyPackDefinition: first.policyPackDefinition,
					runtimeOverrides: first.runtimeOverrides,
					scheduledCronNames: tediRows.flatMap((row) => {
						if (!row.skillSlug) return [];
						return [
							row.skillSlug.replace(/^platform-/, "").replace(/-dogfood$/, ""),
						];
					}),
				}),
			] as const;
		}),
	);
}

/**
 * Mint/refresh ONE org-visible alert work item per dark tedi.
 *
 * Why a work item and not a new notification path: system-detected unattended
 * findings already surface as work items (`createSkillRunFailedWorkItem`) —
 * human-visible in Tedix OS's Home Work panel with zero new UI, actionable, and
 * attributable. Deduped on the deterministic
 * {@link cronDarknessSourceIntentId}: unlike the one-shot skill-run alert this
 * deliberately has NO existence pre-check, because darkness is an ongoing
 * condition — each dark day refreshes the same item's description/metadata
 * (createWorkItem's conflict-set never touches `status`, so an item an
 * operator resolved is not reopened).
 */
export async function upsertCronDarknessWorkItems(
	db: DbClient,
	darkCrons: DarkCognitiveCron[],
	nowIso: string,
): Promise<{ sourceIntentIds: string[] }> {
	const byTedi = new Map<string, DarkCognitiveCron[]>();
	for (const cron of darkCrons) {
		const list = byTedi.get(cron.tediId) ?? [];
		list.push(cron);
		byTedi.set(cron.tediId, list);
	}

	const sourceIntentIds: string[] = [];
	for (const [tediId, tediDark] of byTedi) {
		const first = tediDark[0]!;
		const label = first.tediSlug ?? tediId;
		const lines = tediDark.map(
			(cron) =>
				`- ${cron.cronName} (every ${cron.expectedIntervalHours}h): last stamp ${cron.lastStartedAt ?? "never"} — dark for ${cron.hoursSinceLastExecution}h`,
		);
		const sourceIntentId = cronDarknessSourceIntentId(tediId);
		const values = {
			id: crypto.randomUUID(),
			orgId: first.orgId,
			title: `Cognitive crons dark: ${label} — ${tediDark.length}/${first.expectedCronCount} overdue`,
			description: [
				`The cognitive consolidation tier for ${label} stopped stamping executions (tedi_cron_executions). A loop execution that cannot show a durable stamp did not happen.`,
				...lines,
				`Observed by the daily cron-darkness check at ${nowIso}. Check the tedi's cron schedule and the Agent runtime's onCronFire dispatch.`,
			].join("\n"),
			workKind: "incident",
			priority: "high",
			accountableOwnerType: "system",
			accountableOwnerId: "flywheel",
			...workItemPurposeFor({
				workClass: "incident",
				now: new Date(nowIso),
			}),
			stewardType: "tedi",
			stewardId: tediId,
			sourceIntentId,
			provenance: { source: CRON_DARKNESS_ALERT_SOURCE, tediId },
			metadata: {
				source: CRON_DARKNESS_ALERT_SOURCE,
				tediId,
				observedAt: nowIso,
				darkCrons: tediDark.map((cron) => ({
					cronName: cron.cronName,
					expectedIntervalHours: cron.expectedIntervalHours,
					lastStartedAt: cron.lastStartedAt,
					lastStatus: cron.lastStatus,
					hoursSinceLastExecution: cron.hoursSinceLastExecution,
				})),
			},
			createdAt: nowIso,
		} satisfies CreateWorkItemParams;
		const [existing] = await db
			.select({ id: workItems.id, disposition: workItems.disposition })
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, first.orgId),
					eq(workItems.sourceIntentId, sourceIntentId),
				),
			)
			.limit(1);
		if (!existing) {
			await createWorkItem(db, values);
		} else if (["proposed", "accepted"].includes(existing.disposition)) {
			await db
				.update(workItems)
				.set({
					title: values.title,
					description: values.description,
					metadata: values.metadata,
					updatedAt: nowIso,
				})
				.where(
					and(
						eq(workItems.orgId, first.orgId),
						eq(workItems.id, existing.id),
						inArray(workItems.disposition, ["proposed", "accepted"]),
					),
				);
		}
		sourceIntentIds.push(sourceIntentId);
	}
	return { sourceIntentIds };
}
