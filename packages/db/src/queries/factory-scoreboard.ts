/**
 * Factory scoreboard: what each factory produced in the last week.
 *
 * A factory is a scheduled skill loop or a published Blueprint. Every factory
 * works through skill runs: a loop's runs are its skill's runs, and a
 * Blueprint's runs are the gadget runs dispatched in Workspaces instantiated
 * from it. Outputs and Work are credited to a factory through those runs
 * (`os_output_revisions.skill_run_id`, `skill_runs.work_item_id`), so a skill
 * shared by a loop and a Blueprint gadget is never counted twice.
 */

import { and, eq, isNotNull, type SQLWrapper, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { skillEntries, skillRuns, skillSchedules } from "../schema/cognitive";
import {
	osBlueprints,
	osGadgetExecutions,
	osOutputRevisions,
	osOutputs,
	osWorkspaces,
} from "../schema/os-workspaces";
import { tedis } from "../schema/tedis";
import { workItems } from "../schema/work-items";

export const FACTORY_WINDOW_DAYS = 7;
/** How far back "last real result" looks; it also bounds the run scan. */
export const FACTORY_LAST_RESULT_DAYS = 30;

export interface FactoryScoreboardEntry {
	kind: "skill_loop" | "blueprint";
	/** Skill id for a loop, Blueprint id for a Blueprint. */
	id: string;
	name: string;
	tediId: string | null;
	tediName: string | null;
	/** The loop's cron; null for a Blueprint. */
	cron: string | null;
	runs: number;
	succeeded: number;
	lastRunAt: string | null;
	/** Outputs created or revised by this factory's runs. */
	outputs: number;
	workClosed: number;
	lastResult: {
		kind: "output" | "work_item";
		id: string;
		title: string;
		at: string;
	} | null;
	/** Successful runs but no Output or closed Work in the window. */
	idle: boolean;
}

export interface ListFactoryScoreboardParams {
	orgId: string;
	now: Date;
}

const daysBefore = (now: Date, days: number) =>
	new Date(now.getTime() - days * 86_400_000).toISOString();

/** Timestamps mix SQLite `YYYY-MM-DD HH:MM:SS` and ISO; compare normalized. */
const onOrAfter = (column: SQLWrapper, at: string) =>
	sql`datetime(${column}) >= datetime(${at})`;

/** The whole scoreboard in one D1 round trip. */
export async function listFactoryScoreboard(
	db: DbQueryClient,
	params: ListFactoryScoreboardParams,
): Promise<{ data: FactoryScoreboardEntry[]; since: string }> {
	const { orgId } = params;
	const since = daysBefore(params.now, FACTORY_WINDOW_DAYS);
	const lookback = daysBefore(params.now, FACTORY_LAST_RESULT_DAYS);

	const blueprintRuns = db
		.select({
			runId: sql<string>`${osGadgetExecutions.runId}`.as("bp_run_id"),
			blueprintId: sql<string>`${osWorkspaces.sourceBlueprintId}`.as(
				"bp_blueprint_id",
			),
		})
		.from(osGadgetExecutions)
		.innerJoin(
			osWorkspaces,
			and(
				eq(osWorkspaces.organizationId, osGadgetExecutions.organizationId),
				eq(osWorkspaces.id, osGadgetExecutions.workspaceId),
			),
		)
		.where(
			and(
				eq(osGadgetExecutions.organizationId, orgId),
				isNotNull(osGadgetExecutions.runId),
				isNotNull(osWorkspaces.sourceBlueprintId),
				onOrAfter(osGadgetExecutions.createdAt, lookback),
			),
		)
		.as("factory_blueprint_runs");
	const factoryRuns = db
		.select({
			runId: sql<string>`${skillRuns.id}`.as("factory_run_id"),
			key: sql<string>`coalesce('blueprint:' || ${blueprintRuns.blueprintId}, 'skill:' || ${skillRuns.skillId})`.as(
				"factory_key",
			),
			tediId: sql<string>`${skillRuns.tediId}`.as("factory_tedi_id"),
			status: sql<string>`${skillRuns.status}`.as("factory_run_status"),
			startedAt: sql<string | null>`${skillRuns.startedAt}`.as(
				"factory_run_started_at",
			),
			workItemId: sql<string | null>`${skillRuns.workItemId}`.as(
				"factory_run_work_item_id",
			),
		})
		.from(skillRuns)
		.leftJoin(blueprintRuns, eq(blueprintRuns.runId, skillRuns.id))
		.where(
			and(
				eq(skillRuns.organizationId, orgId),
				onOrAfter(skillRuns.startedAt, lookback),
			),
		)
		.as("factory_runs");

	const outputRanked = db
		.select({
			key: sql<string>`${factoryRuns.key}`.as("last_output_key"),
			id: sql<string>`${osOutputs.id}`.as("last_output_id"),
			title: sql<string>`${osOutputs.title}`.as("last_output_title"),
			at: sql<string>`datetime(${osOutputRevisions.createdAt})`.as(
				"last_output_at",
			),
			rank: sql<number>`row_number() OVER (PARTITION BY ${factoryRuns.key} ORDER BY datetime(${osOutputRevisions.createdAt}) DESC, ${osOutputRevisions.id} DESC)`.as(
				"last_output_rank",
			),
		})
		.from(osOutputRevisions)
		.innerJoin(factoryRuns, eq(factoryRuns.runId, osOutputRevisions.skillRunId))
		.innerJoin(
			osOutputs,
			and(
				eq(osOutputs.organizationId, osOutputRevisions.organizationId),
				eq(osOutputs.id, osOutputRevisions.outputId),
			),
		)
		.where(
			and(
				eq(osOutputRevisions.organizationId, orgId),
				onOrAfter(osOutputRevisions.createdAt, lookback),
			),
		)
		.as("factory_last_output");
	const workRanked = db
		.select({
			key: sql<string>`${factoryRuns.key}`.as("last_work_key"),
			id: sql<string>`${workItems.id}`.as("last_work_id"),
			title: sql<string>`${workItems.title}`.as("last_work_title"),
			at: sql<string>`datetime(${workItems.completedAt})`.as("last_work_at"),
			rank: sql<number>`row_number() OVER (PARTITION BY ${factoryRuns.key} ORDER BY datetime(${workItems.completedAt}) DESC, ${workItems.id} DESC)`.as(
				"last_work_rank",
			),
		})
		.from(workItems)
		.innerJoin(factoryRuns, eq(factoryRuns.workItemId, workItems.id))
		.where(
			and(
				eq(workItems.orgId, orgId),
				eq(workItems.disposition, "completed"),
				onOrAfter(workItems.completedAt, lookback),
			),
		)
		.as("factory_last_work");

	const [
		tediRows,
		scheduleRows,
		blueprintRows,
		runRows,
		outputRows,
		workRows,
		lastOutputRows,
		lastWorkRows,
	] = await db.batch([
		db
			.select({
				id: tedis.id,
				name: sql<string>`coalesce(nullif(${tedis.displayName}, ''), ${tedis.name})`.as(
					"tedi_label",
				),
			})
			.from(tedis)
			.where(eq(tedis.organizationId, orgId)),
		db
			.select({
				skillId: skillSchedules.skillId,
				tediId: skillSchedules.tediId,
				cron: skillSchedules.cron,
				enabled: skillSchedules.enabled,
				title: skillEntries.title,
			})
			.from(skillSchedules)
			.innerJoin(skillEntries, eq(skillEntries.id, skillSchedules.skillId))
			.where(eq(skillSchedules.organizationId, orgId)),
		db
			.select({ id: osBlueprints.id, name: osBlueprints.name })
			.from(osBlueprints)
			.where(
				and(
					eq(osBlueprints.organizationId, orgId),
					eq(osBlueprints.status, "published"),
				),
			),
		db
			.select({
				key: factoryRuns.key,
				runs: sql<number>`count(*)`.as("run_count"),
				succeeded: sql<number>`sum(${factoryRuns.status} = 'completed')`.as(
					"run_succeeded",
				),
				tediId: sql<string | null>`max(${factoryRuns.tediId})`.as(
					"run_tedi_id",
				),
				lastRunAt: sql<
					string | null
				>`max(datetime(${factoryRuns.startedAt}))`.as("run_last_at"),
			})
			.from(factoryRuns)
			.where(onOrAfter(factoryRuns.startedAt, since))
			.groupBy(factoryRuns.key),
		db
			.select({
				key: sql<string>`${factoryRuns.key}`.as("output_key"),
				count: sql<number>`count(DISTINCT ${osOutputRevisions.outputId})`.as(
					"output_count",
				),
			})
			.from(osOutputRevisions)
			.innerJoin(
				factoryRuns,
				eq(factoryRuns.runId, osOutputRevisions.skillRunId),
			)
			.where(
				and(
					eq(osOutputRevisions.organizationId, orgId),
					onOrAfter(osOutputRevisions.createdAt, since),
				),
			)
			.groupBy(factoryRuns.key),
		db
			.select({
				key: sql<string>`${factoryRuns.key}`.as("work_key"),
				count: sql<number>`count(DISTINCT ${workItems.id})`.as("work_count"),
			})
			.from(workItems)
			.innerJoin(factoryRuns, eq(factoryRuns.workItemId, workItems.id))
			.where(
				and(
					eq(workItems.orgId, orgId),
					eq(workItems.disposition, "completed"),
					onOrAfter(workItems.completedAt, since),
				),
			)
			.groupBy(factoryRuns.key),
		db
			.select({
				key: outputRanked.key,
				id: outputRanked.id,
				title: outputRanked.title,
				at: outputRanked.at,
			})
			.from(outputRanked)
			.where(eq(outputRanked.rank, 1)),
		db
			.select({
				key: workRanked.key,
				id: workRanked.id,
				title: workRanked.title,
				at: workRanked.at,
			})
			.from(workRanked)
			.where(eq(workRanked.rank, 1)),
	]);

	const tediNames = new Map(tediRows.map((row) => [row.id, row.name]));
	const runs = new Map(runRows.map((row) => [row.key, row]));
	const outputs = new Map(
		outputRows.map((row) => [row.key, Number(row.count)]),
	);
	const work = new Map(workRows.map((row) => [row.key, Number(row.count)]));
	const lastOutput = new Map(lastOutputRows.map((row) => [row.key, row]));
	const lastWork = new Map(lastWorkRows.map((row) => [row.key, row]));

	const entry = (
		key: string,
		base: Pick<FactoryScoreboardEntry, "kind" | "id" | "name" | "cron"> & {
			tediId: string | null;
		},
	): FactoryScoreboardEntry => {
		const run = runs.get(key);
		const tediId = base.tediId ?? run?.tediId ?? null;
		const output = lastOutput.get(key);
		const closed = lastWork.get(key);
		// Both timestamps come back from SQLite `datetime()`, so they compare as text.
		const newest =
			output && closed
				? output.at >= closed.at
					? output
					: closed
				: (output ?? closed);
		const succeeded = Number(run?.succeeded ?? 0);
		const outputCount = outputs.get(key) ?? 0;
		const workClosed = work.get(key) ?? 0;
		return {
			...base,
			tediId,
			tediName: tediId ? (tediNames.get(tediId) ?? null) : null,
			runs: Number(run?.runs ?? 0),
			succeeded,
			lastRunAt: run?.lastRunAt ?? null,
			outputs: outputCount,
			workClosed,
			lastResult: newest
				? {
						kind: newest === output ? "output" : "work_item",
						id: newest.id,
						title: newest.title,
						at: newest.at,
					}
				: null,
			idle: succeeded > 0 && outputCount === 0 && workClosed === 0,
		};
	};

	const data = [
		...scheduleRows
			.filter((row) => row.enabled || runs.has(`skill:${row.skillId}`))
			.map((row) =>
				entry(`skill:${row.skillId}`, {
					kind: "skill_loop",
					id: row.skillId,
					name: row.title,
					cron: row.cron,
					tediId: row.tediId,
				}),
			),
		...blueprintRows.map((row) =>
			entry(`blueprint:${row.id}`, {
				kind: "blueprint",
				id: row.id,
				name: row.name,
				cron: null,
				tediId: null,
			}),
		),
	].sort(
		(a, b) =>
			(a.tediName ?? "￿").localeCompare(b.tediName ?? "￿") ||
			a.name.localeCompare(b.name),
	);
	return { data, since };
}
