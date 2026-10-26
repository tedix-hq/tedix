/**
 * Factory binding and health reads.
 *
 * A factory is a scheduled org skill (its lane). When it was built with
 * `create_factory`, a Work project's `metadata.factory` binds the lane to its
 * objective, its standing health Work Item and an optional Workspace. A
 * hand-built loop (a schedule without a bound project) is still a factory;
 * its runs are credited only with the Output revisions they wrote.
 *
 * A run is credited with the Work Items created in the bound project and the
 * comments written there while it ran, plus the Output revisions stamped with
 * its run id. The scorecard comment on the health item is reported but does
 * not count as delivery: a run that only reports on itself delivered nothing.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { summarizeRunError } from "@tedix/api-contract/utils/run-error";
import { nextSkillScheduleFireAt } from "@tedix/api-contract/utils/skill-schedule";
import {
	and,
	desc,
	eq,
	inArray,
	isNotNull,
	ne,
	or,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { skillEntries, skillRuns, skillSchedules } from "../schema/cognitive";
import { osOutputRevisions, osWorkspaces } from "../schema/os-workspaces";
import { projects } from "../schema/projects";
import { tedis } from "../schema/tedis";
import { workItemComments, workItems } from "../schema/work-items";

/** Project metadata key that binds a project to its factory lane. */
export const FACTORY_METADATA_KEY = "factory";
/** How far back verdicts look for activity and delivered results. */
export const FACTORY_HEALTH_LOOKBACK_DAYS = 14;
/** Silence limit when the schedule's cron cannot be read. */
export const FACTORY_MAX_SILENCE_MS = 26 * 60 * 60 * 1000;
/** A schedule this far past its due time did not fire. */
export const FACTORY_OVERDUE_GRACE_MS = 60 * 60 * 1000;
/** Row caps for the windowed Work and comment reads. */
const FACTORY_DELIVERY_ROW_CAP = 2000;

export interface FactoryBinding {
	slug: string;
	name: string;
	skillId: string | null;
	objectiveId: string | null;
	healthWorkItemId: string | null;
	workspaceId: string | null;
	template: string;
	cadence: string;
	/** Hour step of an hourly cadence; null for daily and twice-daily. */
	everyHours: number | null;
	maxProposals: number;
	/** The Output each run writes into; the id stays null until a run creates it. */
	output: { id: string | null; title: string | null; kind: string } | null;
}

const text = (value: unknown): string | null =>
	typeof value === "string" && value.length > 0 ? value : null;

/** Read a project's factory binding; null when the project is not a factory. */
export function readFactoryBinding(
	metadata: Record<string, JsonValue> | null | undefined,
): FactoryBinding | null {
	const raw = metadata?.[FACTORY_METADATA_KEY];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const record = raw as Record<string, JsonValue>;
	const slug = text(record.slug);
	if (!slug) return null;
	return {
		slug,
		name: text(record.name) ?? slug,
		skillId: text(record.skillId),
		objectiveId: text(record.objectiveId),
		healthWorkItemId: text(record.healthWorkItemId),
		workspaceId: text(record.workspaceId),
		template: text(record.template) ?? "report",
		cadence: text(record.cadence) ?? "daily",
		everyHours:
			typeof record.everyHours === "number" ? record.everyHours : null,
		maxProposals:
			typeof record.maxProposals === "number" ? record.maxProposals : 0,
		output: readOutputBinding(record.output),
	};
}

function readOutputBinding(
	raw: JsonValue | undefined,
): FactoryBinding["output"] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const id = text(raw.id);
	const title = text(raw.title);
	if (!id && !title) return null;
	return { id, title, kind: text(raw.kind) ?? "document" };
}

/** Persistable form of a binding, for `projects.metadata.factory`. */
export function factoryBindingMetadata(
	binding: FactoryBinding,
): Record<string, JsonValue> {
	return { ...binding };
}

/** Idempotency key of a factory's standing health Work Item. */
export function factoryHealthIntentId(slug: string): string {
	return `factory:${slug}:health`;
}

const bindingSlug = sql<
	string | null
>`json_extract(${projects.metadata}, '$.factory.slug')`;
const bindingSkillId = sql<
	string | null
>`json_extract(${projects.metadata}, '$.factory.skillId')`;

/** Non-secret inputs resolved from the owning project, skill and Workspace. */
export interface FactoryRunContext {
	workspaceId: string | null;
	projectId: string;
	objectiveId: string | null;
	blueprintRevisionId: string | null;
	ownerTediId: string | null;
	healthWorkItemId: string | null;
	output: FactoryBinding["output"];
}

export async function resolveFactoryRunContext(
	db: DbQueryClient,
	params: { orgId: string; skillId: string },
): Promise<FactoryRunContext | null> {
	const rows = await db
		.select({
			projectId: projects.id,
			objectiveId: projects.objectiveId,
			metadata: projects.metadata,
			ownerTediId: skillEntries.tediId,
		})
		.from(projects)
		.innerJoin(
			skillEntries,
			and(
				eq(skillEntries.id, params.skillId),
				eq(skillEntries.organizationId, params.orgId),
			),
		)
		.where(
			and(
				eq(projects.orgId, params.orgId),
				eq(projects.status, "active"),
				eq(bindingSkillId, params.skillId),
			),
		)
		.limit(2);
	if (rows.length > 1)
		throw new Error(
			"FACTORY_BINDING_AMBIGUOUS: skill belongs to multiple active factory projects",
		);
	const row = rows[0];
	if (!row) return null;
	const binding = readFactoryBinding(row.metadata);
	if (!binding)
		throw new Error(
			"FACTORY_BINDING_INVALID: bound project requires a factory slug",
		);
	let blueprintRevisionId: string | null = null;
	if (binding.workspaceId) {
		const [workspace] = await db
			.select({ revisionId: osWorkspaces.sourceBlueprintRevisionId })
			.from(osWorkspaces)
			.where(
				and(
					eq(osWorkspaces.organizationId, params.orgId),
					eq(osWorkspaces.id, binding.workspaceId),
					eq(osWorkspaces.status, "active"),
				),
			)
			.limit(1);
		if (!workspace)
			throw new Error(
				"FACTORY_WORKSPACE_UNAVAILABLE: bound Workspace is not active in this organization",
			);
		blueprintRevisionId = workspace.revisionId;
	}
	return {
		workspaceId: binding.workspaceId,
		projectId: row.projectId,
		objectiveId: row.objectiveId ?? binding.objectiveId,
		blueprintRevisionId,
		ownerTediId: row.ownerTediId,
		healthWorkItemId: binding.healthWorkItemId,
		output: binding.output,
	};
}

export interface FactoryBuildState {
	skill: {
		id: string;
		slug: string | null;
		title: string;
		tediId: string | null;
		lifecycleState: string | null;
		revision: number;
		content: string;
	} | null;
	schedule: { cron: string; enabled: boolean; nextFireAt: string } | null;
	/** The project already bound to this slug, else the project with the key. */
	project: typeof projects.$inferSelect | null;
	healthWorkItemId: string | null;
}

/** Everything an idempotent factory build needs to know, in one D1 batch. */
export async function loadFactoryBuildState(
	db: DbQueryClient,
	params: { orgId: string; slug: string; projectKey: string },
): Promise<FactoryBuildState> {
	const { orgId, slug } = params;
	// The bound skill id wins over the slug: a lane created while an archived
	// skill held the slug got a suffixed slug, and must still be found.
	const boundSkill = db
		.select({ skillId: sql<string>`${bindingSkillId}`.as("bound_skill_id") })
		.from(projects)
		.where(and(eq(projects.orgId, orgId), eq(bindingSlug, slug)));
	const [skillRows, scheduleRows, boundRows, keyedRows, healthRows] =
		await db.batch([
			db
				.select({
					id: skillEntries.id,
					slug: skillEntries.slug,
					title: skillEntries.title,
					tediId: skillEntries.tediId,
					lifecycleState: skillEntries.lifecycleState,
					revision: skillEntries.revision,
					content: skillEntries.content,
				})
				.from(skillEntries)
				.where(
					and(
						eq(skillEntries.organizationId, orgId),
						ne(skillEntries.lifecycleState, "archived"),
						or(
							// bound-params: a SQL subquery, not a bound list.
							inArray(skillEntries.id, boundSkill),
							eq(skillEntries.slug, slug),
						),
					),
				)
				.orderBy(desc(skillEntries.revision), desc(skillEntries.createdAt))
				.limit(1),
			db
				.select({
					cron: skillSchedules.cron,
					enabled: skillSchedules.enabled,
					nextFireAt: skillSchedules.nextFireAt,
				})
				.from(skillSchedules)
				.innerJoin(skillEntries, eq(skillEntries.id, skillSchedules.skillId))
				.where(
					and(
						eq(skillSchedules.organizationId, orgId),
						or(
							// bound-params: a SQL subquery, not a bound list.
							inArray(skillEntries.id, boundSkill),
							eq(skillEntries.slug, slug),
						),
					),
				)
				.limit(1),
			db
				.select()
				.from(projects)
				.where(and(eq(projects.orgId, orgId), eq(bindingSlug, slug)))
				.limit(1),
			db
				.select()
				.from(projects)
				.where(
					and(eq(projects.orgId, orgId), eq(projects.key, params.projectKey)),
				)
				.limit(1),
			db
				.select({ id: workItems.id })
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, orgId),
						eq(workItems.sourceIntentId, factoryHealthIntentId(slug)),
					),
				)
				.limit(1),
		]);
	const schedule = scheduleRows[0];
	return {
		skill: skillRows[0] ?? null,
		schedule: schedule
			? {
					cron: schedule.cron,
					enabled: Boolean(schedule.enabled),
					nextFireAt: schedule.nextFireAt,
				}
			: null,
		project: boundRows[0] ?? keyedRows[0] ?? null,
		healthWorkItemId: healthRows[0]?.id ?? null,
	};
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type FactoryVerdict =
	| "healthy"
	| "idle"
	| "failing"
	| "not_firing"
	| "paused"
	| "pending";

/** Proof runs are manual runs; `lastProofRun` also identifies the latest proof. */
export type FactoryRunTrigger = "schedule" | "manual";

export interface FactoryRunOutputs {
	workItemsCreated: number;
	/** Comments outside the health item: discussion the run added to Work. */
	comments: number;
	/** Scorecard comments the run wrote on its own health item. */
	scorecards: number;
	outputRevisions: number;
}

export interface FactoryHealthRun {
	runId: string;
	status: string;
	trigger: FactoryRunTrigger;
	firedAt: string | null;
	finishedAt: string | null;
	error: string | null;
	outputs: FactoryRunOutputs;
	/** Work, comments and Output revisions; scorecards excluded. */
	delivered: number;
}

export interface FactoryHealthEntry {
	slug: string;
	name: string;
	skillId: string;
	lifecycleState: string | null;
	ownerTediId: string | null;
	ownerTediName: string | null;
	projectId: string | null;
	projectKey: string | null;
	objectiveId: string | null;
	healthWorkItemId: string | null;
	workspaceId: string | null;
	cron: string | null;
	scheduleEnabled: boolean;
	nextFireAt: string | null;
	lastFiredAt: string | null;
	scheduleError: string | null;
	ranToday: boolean;
	lastProofRun: {
		runId: string;
		status: string;
		firedAt: string | null;
		finishedAt: string | null;
	} | null;
	runs: FactoryHealthRun[];
	verdict: FactoryVerdict;
	reason: string;
}

/** SQLite `YYYY-MM-DD HH:MM:SS` is UTC; ISO strings parse as-is. */
export function factoryTimestampMs(value: string | null | undefined): number {
	if (!value) return Number.NaN;
	const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
		? `${value.replace(" ", "T")}Z`
		: value;
	return Date.parse(iso);
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "canceled"]);

export interface FactoryVerdictInput {
	now: Date;
	lifecycleState: string | null;
	schedule: {
		enabled: boolean;
		cron: string;
		nextFireAt: string;
		lastError: string | null;
		createdAt: string | null;
	} | null;
	/** Non-probe runs, newest first. */
	runs: Array<
		Pick<
			FactoryHealthRun,
			"runId" | "status" | "firedAt" | "error" | "delivered"
		> & { resultSummary?: string | null }
	>;
}

/** The cron's next fire after `afterMs`, or null when the cron is unreadable. */
function expectedFireAfter(cron: string, afterMs: number): string | null {
	try {
		return nextSkillScheduleFireAt(cron, afterMs);
	} catch {
		return null;
	}
}

/**
 * One verdict per factory. Order matters: a factory that is not firing is not
 * judged on a stale last run, and a failed last run outranks an earlier
 * success.
 */
export function factoryVerdict(input: FactoryVerdictInput): {
	verdict: FactoryVerdict;
	reason: string;
} {
	const now = input.now.getTime();
	const { schedule } = input;
	if (!schedule) {
		return {
			verdict: "not_firing",
			reason:
				input.lifecycleState === "draft"
					? "The lane skill is a draft, so it has no schedule. Run it once with {probe:true}, then activate it."
					: "The lane skill has no schedule.",
		};
	}
	if (!schedule.enabled) {
		return { verdict: "paused", reason: "The schedule is turned off." };
	}
	const due = factoryTimestampMs(schedule.nextFireAt);
	if (Number.isFinite(due) && due < now - FACTORY_OVERDUE_GRACE_MS) {
		return {
			verdict: "not_firing",
			reason: `The schedule was due at ${schedule.nextFireAt} and did not fire${schedule.lastError ? `: ${schedule.lastError}` : "."}`,
		};
	}
	const latest = input.runs[0];
	if (!latest) {
		const created = factoryTimestampMs(schedule.createdAt);
		return Number.isFinite(created) && now - created < FACTORY_MAX_SILENCE_MS
			? {
					verdict: "pending",
					reason: `No run yet; the first is due at ${schedule.nextFireAt}.`,
				}
			: {
					verdict: "not_firing",
					reason: "No run in the last 14 days.",
				};
	}
	const lastFired = factoryTimestampMs(latest.firedAt);
	const expected = Number.isFinite(lastFired)
		? expectedFireAfter(schedule.cron, lastFired)
		: null;
	if (expected && Date.parse(expected) < now - FACTORY_OVERDUE_GRACE_MS) {
		return {
			verdict: "not_firing",
			reason: `The last run fired at ${latest.firedAt}; the next was due at ${expected} and did not fire.`,
		};
	}
	if (!expected && now - lastFired > FACTORY_MAX_SILENCE_MS) {
		return {
			verdict: "not_firing",
			reason: `The last run fired at ${latest.firedAt}, more than a day ago.`,
		};
	}
	const terminal = input.runs.find((run) =>
		TERMINAL_RUN_STATUSES.has(run.status),
	);
	if (!terminal) {
		return {
			verdict: "pending",
			reason: `Run ${latest.runId} is ${latest.status}; no run has finished yet.`,
		};
	}
	if (terminal.status !== "completed") {
		return {
			verdict: "failing",
			reason: `Run ${terminal.runId} ${terminal.status}${terminal.error ? `: ${terminal.error}` : "."}`,
		};
	}
	if (terminal.delivered === 0) {
		return {
			verdict: "idle",
			reason: terminal.resultSummary
				? `Run ${terminal.runId} completed with no attributed delivery: ${terminal.resultSummary}`
				: `Run ${terminal.runId} completed with no attributed Work, comments or Output revisions.`,
		};
	}
	return {
		verdict: "healthy",
		reason: `Run ${terminal.runId} succeeded and delivered ${terminal.delivered} result${terminal.delivered === 1 ? "" : "s"}.`,
	};
}

const onOrAfter = (column: SQLWrapper, at: string) =>
	sql`datetime(${column}) >= datetime(${at})`;

export interface ListFactoryHealthParams {
	orgId: string;
	now: Date;
	/** Runs returned per factory (newest first). */
	runLimit: number;
}

/** Every factory with its verdict, in one D1 round trip. */
export async function listFactoryHealth(
	db: DbQueryClient,
	params: ListFactoryHealthParams,
): Promise<FactoryHealthEntry[]> {
	const { orgId, now } = params;
	const lookback = new Date(
		now.getTime() - FACTORY_HEALTH_LOOKBACK_DAYS * 86_400_000,
	).toISOString();
	const probeFlag = sql<number>`coalesce(json_extract(${skillRuns.params}, '$.probe'), 0)`;
	const boundSkillIds = db
		.select({ skillId: sql<string>`${bindingSkillId}`.as("bound_skill_id") })
		.from(projects)
		.where(and(eq(projects.orgId, orgId), isNotNull(bindingSkillId)));
	const boundProjectIds = db
		.select({ id: projects.id })
		.from(projects)
		.where(and(eq(projects.orgId, orgId), isNotNull(bindingSlug)));
	const rankedRuns = db
		.select({
			id: sql<string>`${skillRuns.id}`.as("ranked_run_id"),
			skillId: sql<string>`${skillRuns.skillId}`.as("ranked_skill_id"),
			status: sql<string>`${skillRuns.status}`.as("ranked_status"),
			startedAt: sql<string | null>`${skillRuns.startedAt}`.as(
				"ranked_started_at",
			),
			completedAt: sql<string | null>`${skillRuns.completedAt}`.as(
				"ranked_completed_at",
			),
			createdBy: sql<string | null>`${skillRuns.createdBy}`.as(
				"ranked_created_by",
			),
			probe: sql<number>`${probeFlag}`.as("ranked_probe"),
			error: sql<string | null>`substr(${skillRuns.error}, 1, 1200)`.as(
				"ranked_error",
			),
			resultSummary: sql<string | null>`substr(coalesce(
				json_extract(${skillRuns.result}, '$.noResultReason'),
				json_extract(${skillRuns.result}, '$.backgroundOutcome.summary'),
				CASE WHEN json_type(${skillRuns.result}, '$.summary') = 'text'
					THEN json_extract(${skillRuns.result}, '$.summary') END,
				json_extract(${skillRuns.result}, '$.report'),
				json_extract(${skillRuns.result}, '$.scorecard'),
				json_extract(${skillRuns.result}, '$.reason')
			), 1, 1500)`.as("ranked_result_summary"),
			rank: sql<number>`row_number() OVER (PARTITION BY ${skillRuns.skillId}, ${probeFlag} ORDER BY datetime(${skillRuns.startedAt}) DESC, ${skillRuns.id} DESC)`.as(
				"ranked_rank",
			),
		})
		.from(skillRuns)
		.where(eq(skillRuns.organizationId, orgId))
		.as("factory_ranked_runs");
	const rankedProbes = db
		.select({
			id: sql<string>`${skillRuns.id}`.as("probe_run_id"),
			skillId: sql<string>`${skillRuns.skillId}`.as("probe_skill_id"),
			status: sql<string>`${skillRuns.status}`.as("probe_status"),
			startedAt: sql<string | null>`${skillRuns.startedAt}`.as(
				"probe_started_at",
			),
			completedAt: sql<string | null>`${skillRuns.completedAt}`.as(
				"probe_completed_at",
			),
			rank: sql<number>`row_number() OVER (PARTITION BY ${skillRuns.skillId} ORDER BY datetime(${skillRuns.startedAt}) DESC, ${skillRuns.id} DESC)`.as(
				"probe_rank",
			),
		})
		.from(skillRuns)
		.where(and(eq(skillRuns.organizationId, orgId), eq(probeFlag, 1)))
		.as("factory_ranked_probes");

	const [
		laneRows,
		projectRows,
		tediRows,
		runRows,
		probeRows,
		workRows,
		commentRows,
		revisionRows,
	] = await db.batch([
		db
			.select({
				skillId: skillEntries.id,
				slug: skillEntries.slug,
				title: skillEntries.title,
				skillTediId: skillEntries.tediId,
				lifecycleState: skillEntries.lifecycleState,
				scheduleTediId: sql<string | null>`${skillSchedules.tediId}`.as(
					"schedule_tedi_id",
				),
				cron: skillSchedules.cron,
				enabled: skillSchedules.enabled,
				nextFireAt: skillSchedules.nextFireAt,
				lastFireAt: skillSchedules.lastFireAt,
				lastError: skillSchedules.lastError,
				scheduleCreatedAt: sql<string | null>`${skillSchedules.createdAt}`.as(
					"schedule_created_at",
				),
			})
			.from(skillEntries)
			.leftJoin(skillSchedules, eq(skillSchedules.skillId, skillEntries.id))
			.where(
				and(
					eq(skillEntries.organizationId, orgId),
					ne(skillEntries.lifecycleState, "archived"),
					or(
						isNotNull(skillSchedules.id),
						// bound-params: a SQL subquery, not a bound list.
						inArray(skillEntries.id, boundSkillIds),
					),
				),
			),
		db
			.select({
				id: projects.id,
				key: projects.key,
				objectiveId: projects.objectiveId,
				metadata: projects.metadata,
			})
			.from(projects)
			.where(and(eq(projects.orgId, orgId), isNotNull(bindingSlug))),
		db
			.select({
				id: tedis.id,
				label:
					sql<string>`coalesce(nullif(${tedis.displayName}, ''), ${tedis.name})`.as(
						"tedi_label",
					),
			})
			.from(tedis)
			.where(eq(tedis.organizationId, orgId)),
		db
			.select({
				id: rankedRuns.id,
				skillId: rankedRuns.skillId,
				status: rankedRuns.status,
				startedAt: rankedRuns.startedAt,
				completedAt: rankedRuns.completedAt,
				createdBy: rankedRuns.createdBy,
				probe: rankedRuns.probe,
				error: rankedRuns.error,
				resultSummary: rankedRuns.resultSummary,
			})
			.from(rankedRuns)
			.where(sql`${rankedRuns.rank} <= ${params.runLimit}`),
		db
			.select({
				id: rankedProbes.id,
				skillId: rankedProbes.skillId,
				status: rankedProbes.status,
				startedAt: rankedProbes.startedAt,
				completedAt: rankedProbes.completedAt,
			})
			.from(rankedProbes)
			.where(eq(rankedProbes.rank, 1)),
		db
			.select({
				id: workItems.id,
				projectId: workItems.projectId,
				createdAt: workItems.createdAt,
			})
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, orgId),
					// bound-params: a SQL subquery, not a bound list.
					inArray(workItems.projectId, boundProjectIds),
					onOrAfter(workItems.createdAt, lookback),
				),
			)
			.orderBy(desc(workItems.createdAt))
			.limit(FACTORY_DELIVERY_ROW_CAP),
		db
			.select({
				id: workItemComments.id,
				workItemId: workItemComments.workItemId,
				projectId: sql<string | null>`${workItems.projectId}`.as(
					"comment_project_id",
				),
				createdAt: workItemComments.createdAt,
			})
			.from(workItemComments)
			.innerJoin(
				workItems,
				and(
					eq(workItems.orgId, workItemComments.orgId),
					eq(workItems.id, workItemComments.workItemId),
				),
			)
			.where(
				and(
					eq(workItemComments.orgId, orgId),
					// bound-params: a SQL subquery, not a bound list.
					inArray(workItems.projectId, boundProjectIds),
					onOrAfter(workItemComments.createdAt, lookback),
				),
			)
			.orderBy(desc(workItemComments.createdAt))
			.limit(FACTORY_DELIVERY_ROW_CAP),
		db
			.select({
				runId: sql<string>`${osOutputRevisions.skillRunId}`.as(
					"revision_run_id",
				),
				count: sql<number>`count(*)`.as("revision_count"),
			})
			.from(osOutputRevisions)
			.where(
				and(
					eq(osOutputRevisions.organizationId, orgId),
					isNotNull(osOutputRevisions.skillRunId),
					onOrAfter(osOutputRevisions.createdAt, lookback),
				),
			)
			.groupBy(osOutputRevisions.skillRunId),
	]);

	const tediNames = new Map(tediRows.map((row) => [row.id, row.label]));
	const bindings = new Map<
		string,
		{
			projectId: string;
			projectKey: string;
			projectObjectiveId: string | null;
			binding: FactoryBinding;
		}
	>();
	for (const row of projectRows) {
		const binding = readFactoryBinding(row.metadata);
		if (binding?.skillId) {
			bindings.set(binding.skillId, {
				projectId: row.id,
				projectKey: row.key,
				projectObjectiveId: row.objectiveId,
				binding,
			});
		}
	}
	const revisions = new Map(
		revisionRows.map((row) => [row.runId, Number(row.count)]),
	);
	const probes = new Map(probeRows.map((row) => [row.skillId, row]));
	const runsBySkill = new Map<string, typeof runRows>();
	for (const run of runRows) {
		const list = runsBySkill.get(run.skillId) ?? [];
		list.push(run);
		runsBySkill.set(run.skillId, list);
	}
	const todayUtc = now.toISOString().slice(0, 10);

	return laneRows
		.map((lane): FactoryHealthEntry => {
			const bound = bindings.get(lane.skillId) ?? null;
			const healthId = bound?.binding.healthWorkItemId ?? null;
			const inWindow = (at: string, start: number, end: number) => {
				const ms = factoryTimestampMs(at);
				return ms >= start && ms <= end;
			};
			const runs = (runsBySkill.get(lane.skillId) ?? [])
				.sort(
					(a, b) =>
						factoryTimestampMs(b.startedAt) - factoryTimestampMs(a.startedAt),
				)
				.map((run): FactoryHealthRun => {
					const start = factoryTimestampMs(run.startedAt);
					const end = run.completedAt
						? factoryTimestampMs(run.completedAt)
						: TERMINAL_RUN_STATUSES.has(run.status)
							? start
							: now.getTime();
					const workItemsCreated = bound
						? workRows.filter(
								(item) =>
									item.projectId === bound.projectId &&
									item.id !== healthId &&
									inWindow(item.createdAt, start, end),
							).length
						: 0;
					const projectComments = bound
						? commentRows.filter(
								(comment) =>
									comment.projectId === bound.projectId &&
									inWindow(comment.createdAt, start, end),
							)
						: [];
					const scorecards = projectComments.filter(
						(comment) => comment.workItemId === healthId,
					).length;
					const outputs: FactoryRunOutputs = {
						workItemsCreated,
						comments: projectComments.length - scorecards,
						scorecards,
						outputRevisions: revisions.get(run.id) ?? 0,
					};
					return {
						runId: run.id,
						status: run.status,
						trigger: run.createdBy === "schedule" ? "schedule" : "manual",
						firedAt: run.startedAt,
						finishedAt: run.completedAt,
						error: summarizeRunError(run.error),
						outputs,
						delivered:
							outputs.workItemsCreated +
							outputs.comments +
							outputs.outputRevisions,
					};
				});
			const schedule =
				lane.cron !== null && lane.nextFireAt !== null
					? {
							enabled: Boolean(lane.enabled),
							cron: lane.cron,
							nextFireAt: lane.nextFireAt,
							lastError: lane.lastError,
							createdAt: lane.scheduleCreatedAt,
						}
					: null;
			// Proof runs are visible history, but do not prove the schedule is firing.
			const proofIds = new Set(
				(runsBySkill.get(lane.skillId) ?? [])
					.filter((run) => Number(run.probe))
					.map((run) => run.id),
			);
			const regularRuns = runs.filter(
				(run) =>
					!proofIds.has(run.runId) &&
					factoryTimestampMs(run.firedAt) >= factoryTimestampMs(lookback),
			);
			const { verdict, reason } = factoryVerdict({
				now,
				lifecycleState: lane.lifecycleState,
				schedule,
				runs: regularRuns.map((run) => ({
					...run,
					resultSummary: (runsBySkill.get(lane.skillId) ?? []).find(
						(row) => row.id === run.runId,
					)?.resultSummary,
				})),
			});
			const ownerTediId = lane.scheduleTediId ?? lane.skillTediId ?? null;
			const probe = probes.get(lane.skillId);
			const lastFiredAt = regularRuns[0]?.firedAt ?? lane.lastFireAt ?? null;
			return {
				slug: bound?.binding.slug ?? lane.slug ?? lane.skillId,
				name: bound?.binding.name ?? lane.title,
				skillId: lane.skillId,
				lifecycleState: lane.lifecycleState,
				ownerTediId,
				ownerTediName: ownerTediId
					? (tediNames.get(ownerTediId) ?? null)
					: null,
				projectId: bound?.projectId ?? null,
				projectKey: bound?.projectKey ?? null,
				objectiveId:
					bound?.binding.objectiveId ?? bound?.projectObjectiveId ?? null,
				healthWorkItemId: healthId,
				workspaceId: bound?.binding.workspaceId ?? null,
				cron: lane.cron,
				scheduleEnabled: Boolean(lane.enabled),
				nextFireAt: lane.nextFireAt,
				lastFiredAt,
				scheduleError: lane.lastError,
				ranToday: regularRuns.some((run) =>
					(Number.isFinite(factoryTimestampMs(run.firedAt))
						? new Date(factoryTimestampMs(run.firedAt)).toISOString()
						: ""
					).startsWith(todayUtc),
				),
				lastProofRun: probe
					? {
							runId: probe.id,
							status: probe.status,
							firedAt: probe.startedAt,
							finishedAt: probe.completedAt,
						}
					: null,
				runs: runs.slice(0, params.runLimit),
				verdict,
				reason,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}
