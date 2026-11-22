import type { OsDerivedAccessEnvelope } from "@tedix/api-contract/schemas/os-workspaces";
/**
 * Skill Runs Query Helpers
 * Lifecycle operations for skill workflow execution records.
 */

import type { SkillRunCostSummary } from "@tedix/api-contract/contracts/cognitive";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	getColumns,
	inArray,
	isNull,
	like,
	lt,
	ne,
	notExists,
	notInArray,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import * as z from "zod";
import type { DbClient } from "../client";
import {
	type NewSkillRun,
	SKILL_RUN_STATUSES,
	type SkillRun,
	type SkillRunStatus,
	skillEntries,
	skillRunAwaitingReconcile,
	skillRunReconcileOrder,
	skillRuns,
	skillWorkflowSources,
} from "../schema/cognitive";
import { chunkForBoundParams } from "../utils/batch";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { toJsonValue } from "../utils/json";

export type { NewSkillRun, SkillRun, SkillRunStatus };

export const SkillRunStatusSchema = z.enum(SKILL_RUN_STATUSES);

export type SkillRunRuntimeEnvironment =
	| "development"
	| "staging"
	| "production";

function skillRunEnvironmentCondition(
	runtimeEnvironment: SkillRunRuntimeEnvironment,
) {
	return eq(skillRuns.runtimeEnvironment, runtimeEnvironment);
}

function boundedRunLimit(limit: number | undefined, fallback: number): number {
	return Math.min(Math.max(limit ?? fallback, 1), 200);
}

// Explicit qualifiers survive Drizzle's single-table projection normalization.
const pinnedWorkflowSource = sql<
	string | null
>`coalesce("skill_runs"."workflow_source", (
	select "source"."workflow_source" from "skill_workflow_sources" as "source"
	where "source"."skill_id" = "skill_runs"."skill_id"
	and "source"."sha256" = "skill_runs"."workflow_source_hash"
))`;

export async function getPinnedSkillWorkflowSource(
	db: DbClient,
	runId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ source: pinnedWorkflowSource })
		.from(skillRuns)
		.where(eq(skillRuns.id, runId))
		.limit(1);
	return row?.source ?? null;
}

export interface CreatePinnedSkillRunParams {
	runId: string;
	skillId: string;
	tediId: string;
	orgId: string;
	workflowInstanceId: string;
	params: unknown;
	workflowSource?: string | null;
	skillDoc?: string | null;
	skillRevision?: number | null;
	skillSlug?: string | null;
	capabilityManifest?: unknown;
	resourceAccessEnvelope?: OsDerivedAccessEnvelope;
	certification?: boolean;
	createdBy?: string | null;
	workItemId?: string | null;
	originTediRunId?: string | null;
	runtimeEnvironment: SkillRunRuntimeEnvironment;
}

/** Source and run reference commit together; retries cannot overwrite a revision. */
export async function createPinnedSkillRun(
	db: DbClient,
	input: CreatePinnedSkillRunParams,
): Promise<void> {
	const hash = input.workflowSource
		? await sha256Hex(input.workflowSource)
		: null;
	const run = db.insert(skillRuns).values({
		id: input.runId,
		skillId: input.skillId,
		tediId: input.tediId,
		organizationId: input.orgId,
		workflowInstanceId: input.workflowInstanceId,
		params: toJsonValue(input.params ?? {}) as Record<string, JsonValue>,
		status: "failed",
		error: "WORKFLOW_ADMISSION_PENDING: workflow create not yet observed",
		startedAt: new Date().toISOString(),
		workflowSource: null,
		workflowSourceHash: hash,
		skillDoc: input.skillDoc ?? null,
		skillRevision: input.skillRevision ?? null,
		skillSlug: input.skillSlug ?? null,
		capabilityManifest:
			input.capabilityManifest == null
				? null
				: (toJsonValue(input.capabilityManifest) as Record<string, JsonValue>),
		runtimeEnvironment: input.runtimeEnvironment,
		certification: input.certification ?? false,
		createdBy: input.createdBy ?? null,
		workItemId: input.workItemId ?? null,
		originTediRunId: input.originTediRunId ?? null,
		resourceAccessEnvelope: input.resourceAccessEnvelope ?? null,
	});
	if (hash && input.workflowSource) {
		await db.batch([
			db
				.insert(skillWorkflowSources)
				.values({
					skillId: input.skillId,
					sha256: hash,
					workflowSource: input.workflowSource,
				})
				.onConflictDoNothing(),
			run,
		]);
	} else await run;
}

/**
 * Open runs hold a slot under a per-skill cap: live statuses plus a pending or
 * ambiguous engine admission. `since` bounds the scan so a row stuck in
 * admission cannot hold a slot forever.
 */
function openSkillRunCondition(input: {
	organizationId: string;
	skillId: string;
	runtimeEnvironment: SkillRunRuntimeEnvironment;
	since: string;
}): SQL {
	return and(
		eq(skillRuns.organizationId, input.organizationId),
		eq(skillRuns.skillId, input.skillId),
		skillRunEnvironmentCondition(input.runtimeEnvironment),
		gt(skillRuns.startedAt, input.since),
		isNull(skillRuns.workflowRetiredAt),
		or(
			inArray(skillRuns.status, ["queued", "running", "paused"]),
			and(
				eq(skillRuns.status, "failed"),
				or(
					like(skillRuns.error, "WORKFLOW_ADMISSION_PENDING:%"),
					like(skillRuns.error, "WORKFLOW_ADMISSION_CREATE_FAILED:%"),
				),
			),
		),
	)!;
}

/**
 * Insert a pinned run only while fewer than `cap.max` runs of the same skill
 * are open in the organization. The count and the insert are one SQL
 * statement, so concurrent admissions cannot both take the last slot.
 * Returns false when the cap refused the run.
 */
export async function createPinnedSkillRunWithinCap(
	db: DbClient,
	input: CreatePinnedSkillRunParams,
	cap: { max: number; since: string },
): Promise<boolean> {
	const hash = input.workflowSource
		? await sha256Hex(input.workflowSource)
		: null;
	if (hash && input.workflowSource)
		await db
			.insert(skillWorkflowSources)
			.values({
				skillId: input.skillId,
				sha256: hash,
				workflowSource: input.workflowSource,
			})
			.onConflictDoNothing();
	const json = (value: unknown) =>
		value == null ? null : JSON.stringify(toJsonValue(value));
	const bound = (value: unknown, column: string) => sql`${value}`.as(column);
	// insert ... select from the run's own skill row: the open-run count and
	// the insert are one statement.
	await db.insert(skillRuns).select(
		db
			.select({
				id: bound(input.runId, "id"),
				skillId: bound(input.skillId, "skill_id"),
				tediId: bound(input.tediId, "tedi_id"),
				organizationId: bound(input.orgId, "organization_id"),
				workflowInstanceId: bound(
					input.workflowInstanceId,
					"workflow_instance_id",
				),
				params: bound(json(input.params ?? {}), "params"),
				status: bound("failed", "status"),
				error: bound(
					"WORKFLOW_ADMISSION_PENDING: workflow create not yet observed",
					"error",
				),
				startedAt: bound(new Date().toISOString(), "started_at"),
				workflowSourceHash: bound(hash, "workflow_source_hash"),
				skillDoc: bound(input.skillDoc ?? null, "skill_doc"),
				skillRevision: bound(input.skillRevision ?? null, "skill_revision"),
				skillSlug: bound(input.skillSlug ?? null, "skill_slug"),
				capabilityManifest: bound(
					json(input.capabilityManifest),
					"capability_manifest",
				),
				runtimeEnvironment: bound(
					input.runtimeEnvironment,
					"runtime_environment",
				),
				certification: bound(input.certification ? 1 : 0, "certification"),
				createdBy: bound(input.createdBy ?? null, "created_by"),
				workItemId: bound(input.workItemId ?? null, "work_item_id"),
				originTediRunId: bound(
					input.originTediRunId ?? null,
					"origin_tedi_run_id",
				),
				resourceAccessEnvelope: bound(
					json(input.resourceAccessEnvelope),
					"resource_access_envelope",
				),
			})
			.from(skillEntries)
			.where(
				and(
					eq(skillEntries.id, input.skillId),
					eq(skillEntries.organizationId, input.orgId),
					lt(
						db.$count(
							skillRuns,
							openSkillRunCondition({
								organizationId: input.orgId,
								skillId: input.skillId,
								runtimeEnvironment: input.runtimeEnvironment,
								since: cap.since,
							}),
						),
						cap.max,
					),
				),
			),
	);
	const [row] = await db
		.select({ id: skillRuns.id })
		.from(skillRuns)
		.where(eq(skillRuns.id, input.runId))
		.limit(1);
	return row !== undefined;
}

/** Open runs of one skill, newest first, for a cap refusal. */
export async function listOpenSkillRunsForSkill(
	db: DbClient,
	input: {
		organizationId: string;
		skillId: string;
		runtimeEnvironment: SkillRunRuntimeEnvironment;
		since: string;
		limit: number;
	},
): Promise<
	Array<{
		openRunId: string;
		openRunTediId: string;
		openRunStartedAt: string | null;
	}>
> {
	return db
		.select({
			openRunId: skillRuns.id,
			openRunTediId: skillRuns.tediId,
			openRunStartedAt: skillRuns.startedAt,
		})
		.from(skillRuns)
		.where(openSkillRunCondition(input))
		.orderBy(desc(skillRuns.startedAt))
		.limit(boundedRunLimit(input.limit, 20));
}

export interface CreateSkillRunArgs {
	id?: string;
	organizationId: string;
	skillId: string;
	tediId: string;
	workflowInstanceId: string;
	executionEpoch?: number;
	runtimeEnvironment: "development" | "staging" | "production";
	status?: SkillRunStatus;
	params?: Record<string, JsonValue> | null;
	capabilityManifest?: Record<string, JsonValue> | null;
	resourceAccessEnvelope?: OsDerivedAccessEnvelope | null;
	createdBy?: string | null;
	workItemId?: string | null;
}

export async function createSkillRun(
	db: DbClient,
	args: CreateSkillRunArgs,
): Promise<SkillRun> {
	const id = args.id ?? crypto.randomUUID();
	const [created] = await db
		.insert(skillRuns)
		.values({
			id,
			organizationId: args.organizationId,
			skillId: args.skillId,
			tediId: args.tediId,
			workflowInstanceId: args.workflowInstanceId,
			executionEpoch: args.executionEpoch ?? 0,
			runtimeEnvironment: args.runtimeEnvironment,
			status: args.status ?? "queued",
			params: args.params ?? null,
			capabilityManifest: args.capabilityManifest ?? null,
			resourceAccessEnvelope: args.resourceAccessEnvelope ?? null,
			createdBy: args.createdBy ?? null,
			workItemId: args.workItemId ?? null,
		})
		.returning();
	if (!created) throw new Error(`Failed to create skill run: ${id}`);
	return created;
}

export async function getSkillRun(
	db: DbClient,
	runId: string,
	orgId: string,
	runtimeEnvironment: SkillRunRuntimeEnvironment,
): Promise<SkillRun | undefined> {
	const rows = await db
		.select({ ...getColumns(skillRuns), workflowSource: pinnedWorkflowSource })
		.from(skillRuns)
		.where(
			and(
				eq(skillRuns.id, runId),
				eq(skillRuns.organizationId, orgId),
				skillRunEnvironmentCondition(runtimeEnvironment),
			),
		)
		.limit(1);
	return rows[0];
}

export type SkillRunAwaitingReconcileResult = Pick<
	SkillRun,
	| "id"
	| "skillId"
	| "tediId"
	| "workflowInstanceId"
	| "organizationId"
	| "params"
	| "status"
	| "error"
	| "executionEpoch"
	| "restartRequestedAt"
	| "restartCommandId"
	| "startedAt"
>;

/**
 * The runs of one environment the reconciler has to look at, longest
 * unvisited first: unfinished runs, runs waiting for a restart, and runs that
 * failed before their workflow was created. Reads across organizations on
 * purpose; only the runtime's scheduled reconciler calls it.
 *
 * The condition and the order are the ones `idx_skill_runs_reconcile_pending`
 * is built on, so the read touches at most `limit` runs plus the few revoked
 * ones it skips, instead of every run the environment ever had.
 */
export async function listSkillRunsAwaitingReconcile(
	db: DbClient,
	runtimeEnvironment: SkillRunRuntimeEnvironment,
	limit: number,
): Promise<SkillRunAwaitingReconcileResult[]> {
	return db
		.select({
			id: skillRuns.id,
			skillId: skillRuns.skillId,
			tediId: skillRuns.tediId,
			workflowInstanceId: skillRuns.workflowInstanceId,
			organizationId: skillRuns.organizationId,
			params: skillRuns.params,
			status: skillRuns.status,
			error: skillRuns.error,
			executionEpoch: skillRuns.executionEpoch,
			restartRequestedAt: skillRuns.restartRequestedAt,
			restartCommandId: skillRuns.restartCommandId,
			startedAt: skillRuns.startedAt,
		})
		.from(skillRuns)
		.where(
			and(
				skillRunEnvironmentCondition(runtimeEnvironment),
				skillRunAwaitingReconcile,
				sql`coalesce(${skillRuns.error}, '') <> 'REVOKED'`,
				sql`coalesce(${skillRuns.error}, '') NOT GLOB 'REVOKED:*'`,
			),
		)
		.orderBy(asc(skillRunReconcileOrder), asc(skillRuns.startedAt))
		.limit(limit);
}

export interface UpdateSkillRunFields {
	result?: unknown;
	error?: string | null;
	completedAt?: string | null;
	pausedAt?: string | null;
	workflowInstanceId?: string;
}

export async function updateSkillRunStatus(
	db: DbClient,
	runId: string,
	status: SkillRunStatus,
	fields?: UpdateSkillRunFields,
): Promise<void> {
	const patch: Partial<NewSkillRun> = { status };

	if (fields?.result !== undefined) patch.result = toJsonValue(fields.result);
	if (fields?.error !== undefined) patch.error = fields.error;
	if (fields?.workflowInstanceId !== undefined) {
		patch.workflowInstanceId = fields.workflowInstanceId;
	}
	if (fields?.pausedAt !== undefined) patch.pausedAt = fields.pausedAt;

	if (fields?.completedAt !== undefined) {
		patch.completedAt = fields.completedAt;
	} else if (
		status === "completed" ||
		status === "failed" ||
		status === "canceled"
	) {
		patch.completedAt = new Date().toISOString();
	}

	if (status === "paused" && fields?.pausedAt === undefined) {
		patch.pausedAt = new Date().toISOString();
	}

	await db.update(skillRuns).set(patch).where(eq(skillRuns.id, runId));
}

/**
 * Permanently retire a terminal Workflow instance before source-keyed revoke
 * cleanup starts. This CAS is the ordering boundary shared with native
 * restart reservation: whichever mutation wins prevents the other from
 * crossing into the engine/artifact side effect.
 *
 * A run may already be retired by operator-abort recovery; revocation still
 * claims it by preserving the earlier tombstone with COALESCE. Legacy rows
 * already carrying a REVOKED marker are intentionally not claimed again.
 */
export async function retireSkillRunForRevocation(
	db: DbClient,
	args: {
		runId: string;
		organizationId: string;
		runtimeEnvironment: SkillRunRuntimeEnvironment;
		expectedExecutionEpoch: number;
		reason?: string | null;
	},
): Promise<boolean> {
	const now = new Date().toISOString();
	const reason = args.reason?.trim() ?? "";
	const error = reason ? `REVOKED: ${reason}` : "REVOKED";
	const updated = await db
		.update(skillRuns)
		.set({
			workflowRetiredAt: sql`coalesce(${skillRuns.workflowRetiredAt}, ${now})`,
			error,
			result: null,
			costSummary: null,
		})
		.where(
			and(
				eq(skillRuns.id, args.runId),
				eq(skillRuns.organizationId, args.organizationId),
				skillRunEnvironmentCondition(args.runtimeEnvironment),
				eq(skillRuns.executionEpoch, args.expectedExecutionEpoch),
				inArray(skillRuns.status, ["completed", "failed", "canceled"]),
				isNull(skillRuns.restartRequestedAt),
				or(
					isNull(skillRuns.error),
					and(
						sql`${skillRuns.error} <> 'REVOKED'`,
						sql`${skillRuns.error} NOT GLOB 'REVOKED:*'`,
						sql`${skillRuns.error} NOT LIKE 'WORKFLOW_ADMISSION_PENDING:%'`,
						sql`${skillRuns.error} NOT LIKE 'WORKFLOW_ADMISSION_CREATE_FAILED:%'`,
					),
				),
			),
		)
		.returning({ id: skillRuns.id });
	return updated.length > 0;
}

/**
 * Persist the first terminal cost/effort rollup for a run. Guarded on
 * `cost_summary IS NULL` so the first terminal observation wins and
 * concurrent reconcilers stay idempotent. Returns true when this call
 * persisted the summary.
 */
export async function setSkillRunCostSummary(
	db: DbClient,
	runId: string,
	orgId: string,
	runtimeEnvironment: SkillRunRuntimeEnvironment,
	expectedExecutionEpoch: number,
	costSummary: SkillRunCostSummary,
): Promise<boolean> {
	const updated = await db
		.update(skillRuns)
		.set({ costSummary })
		.where(
			and(
				eq(skillRuns.id, runId),
				eq(skillRuns.organizationId, orgId),
				skillRunEnvironmentCondition(runtimeEnvironment),
				eq(skillRuns.executionEpoch, expectedExecutionEpoch),
				inArray(skillRuns.status, ["completed", "failed"]),
				isNull(skillRuns.restartRequestedAt),
				isNull(skillRuns.workflowRetiredAt),
				or(
					isNull(skillRuns.error),
					and(
						sql`${skillRuns.error} <> 'REVOKED'`,
						sql`${skillRuns.error} NOT GLOB 'REVOKED:*'`,
					),
				),
				isNull(skillRuns.costSummary),
			),
		)
		.returning({ id: skillRuns.id });
	return updated.length > 0;
}

export interface ListSkillRunsForTediOptions extends SkillRunListFilters {
	limit?: number;
	offset?: number;
	/** Omit private run inputs from a read-only capture inventory. */
	metadataOnly?: boolean;
	skillId?: string;
}

export interface SkillRunSummaryRow {
	id: string;
	organizationId: string;
	skillId: string;
	tediId: string;
	workflowInstanceId: string;
	runtimeEnvironment: SkillRunRuntimeEnvironment;
	lastReconciledAt: string | null;
	executionEpoch: number;
	restartRequestedAt: string | null;
	workflowRetiredAt: string | null;
	status: SkillRunStatus;
	params: Record<string, JsonValue> | null;
	capabilityManifest: Record<string, JsonValue> | null;
	skillSlug: string | null;
	skillRevision: number | null;
	startedAt: string | null;
	completedAt: string | null;
	pausedAt: string | null;
	createdBy: string | null;
	hasResult: boolean | number;
	hasError: boolean | number;
	outcome: "delivered" | "progressed" | "blocked" | "no_action" | null;
	workItemId: string | null;
	/** What started the run, read from `certification` and `createdBy`. */
	trigger: SkillRunTrigger | null;
	/** The start of the stored error, at most 400 characters. */
	errorPreview: string | null;
	/** The result's own summary text, at most 300 characters. */
	resultSummary: string | null;
}

export type SkillRunTrigger = "scheduled" | "manual" | "agent" | "test";

/**
 * What started a run. A test is an owner's or admin's certification run;
 * the scheduler writes `schedule`; a person's run carries `user:<id>`; any
 * other recorded starter is an agent or an app.
 */
const skillRunTriggerSql = sql<SkillRunTrigger | null>`case
	when ${skillRuns.certification} = 1 then 'test'
	when ${skillRuns.createdBy} = 'schedule' then 'scheduled'
	when ${skillRuns.createdBy} like 'user:%' then 'manual'
	when ${skillRuns.createdBy} is null or ${skillRuns.createdBy} = 'unknown' then null
	else 'agent'
end`;

const skillRunSummarySelect = {
	id: skillRuns.id,
	organizationId: skillRuns.organizationId,
	skillId: skillRuns.skillId,
	tediId: skillRuns.tediId,
	workflowInstanceId: skillRuns.workflowInstanceId,
	runtimeEnvironment: skillRuns.runtimeEnvironment,
	lastReconciledAt: skillRuns.lastReconciledAt,
	executionEpoch: skillRuns.executionEpoch,
	restartRequestedAt: skillRuns.restartRequestedAt,
	workflowRetiredAt: skillRuns.workflowRetiredAt,
	status: skillRuns.status,
	params: skillRuns.params,
	capabilityManifest: skillRuns.capabilityManifest,
	skillSlug: skillRuns.skillSlug,
	skillRevision: skillRuns.skillRevision,
	startedAt: skillRuns.startedAt,
	completedAt: skillRuns.completedAt,
	pausedAt: skillRuns.pausedAt,
	createdBy: skillRuns.createdBy,
	hasResult: sql<number>`case when ${skillRuns.result} is not null then 1 else 0 end`,
	hasError: sql<number>`case when ${skillRuns.error} is not null then 1 else 0 end`,
	outcome: sql<SkillRunSummaryRow["outcome"]>`case
		when json_type(${skillRuns.result}, '$.status') = 'text'
			and json_extract(${skillRuns.result}, '$.status') in (
				'delivered', 'progressed', 'blocked', 'no_action'
			)
		then json_extract(${skillRuns.result}, '$.status')
		else null
	end`.as("outcome"),
	workItemId: sql<string | null>`case
		when json_type(${skillRuns.result}, '$.workItemId') = 'text'
		then json_extract(${skillRuns.result}, '$.workItemId')
		else null
	end`.as("work_item_id"),
	trigger: skillRunTriggerSql.as("run_trigger"),
	errorPreview: sql<string | null>`substr(${skillRuns.error}, 1, 400)`.as(
		"error_preview",
	),
	resultSummary: sql<string | null>`substr(case
		when json_type(${skillRuns.result}, '$.summary') = 'text'
		then json_extract(${skillRuns.result}, '$.summary')
		when json_type(${skillRuns.result}, '$.message') = 'text'
		then json_extract(${skillRuns.result}, '$.message')
		when json_type(${skillRuns.result}, '$.backgroundOutcome.summary') = 'text'
		then json_extract(${skillRuns.result}, '$.backgroundOutcome.summary')
		else null
	end, 1, 300)`.as("result_summary"),
};

function skillRunSummaryProjection(metadataOnly?: boolean) {
	return metadataOnly
		? {
				...skillRunSummarySelect,
				params: sql<SkillRunSummaryRow["params"]>`null`.as("params"),
				capabilityManifest: sql<
					SkillRunSummaryRow["capabilityManifest"]
				>`null`.as("capability_manifest"),
			}
		: skillRunSummarySelect;
}

/** Filters every run list shares: status, tag, starter, revision, age. */
interface SkillRunListFilters {
	status?: SkillRunStatus;
	/** Filter runs to skills carrying this exact JSON-array tag. */
	skillTag?: string;
	trigger?: SkillRunTrigger;
	skillRevision?: number;
	/** ISO time; only runs started at or after it. */
	startedAfter?: string;
}

function skillRunFilterConditions(options?: SkillRunListFilters): SQL[] {
	const conditions: SQL[] = [];
	if (options?.status) conditions.push(eq(skillRuns.status, options.status));
	if (options?.skillTag) conditions.push(skillTagCondition(options.skillTag));
	if (options?.trigger)
		conditions.push(sql`${skillRunTriggerSql} = ${options.trigger}`);
	if (options?.skillRevision != null)
		conditions.push(eq(skillRuns.skillRevision, options.skillRevision));
	// started_at holds both `YYYY-MM-DD HH:MM:SS` and ISO text; datetime()
	// reads both as UTC.
	if (options?.startedAfter)
		conditions.push(
			sql`datetime(${skillRuns.startedAt}) >= datetime(${options.startedAfter})`,
		);
	return conditions;
}

function skillTagCondition(skillTag: string) {
	return sql`exists (
		select 1
		from ${skillEntries}, json_each(coalesce(${skillEntries.tags}, '[]'))
		where ${skillEntries.id} = ${skillRuns.skillId}
			and ${skillEntries.organizationId} = ${skillRuns.organizationId}
			and value = ${skillTag}
	)`;
}

export async function listSkillRunsForTedi(
	db: DbClient,
	organizationId: string,
	tediId: string,
	runtimeEnvironment: SkillRunRuntimeEnvironment,
	options?: ListSkillRunsForTediOptions,
): Promise<SkillRunSummaryRow[]> {
	const conditions = [
		eq(skillRuns.organizationId, organizationId),
		eq(skillRuns.tediId, tediId),
		skillRunEnvironmentCondition(runtimeEnvironment),
	];
	if (options?.skillId) conditions.push(eq(skillRuns.skillId, options.skillId));
	conditions.push(...skillRunFilterConditions(options));

	return db
		.select(skillRunSummaryProjection(options?.metadataOnly))
		.from(skillRuns)
		.where(and(...conditions))
		.orderBy(desc(skillRuns.startedAt), desc(skillRuns.id))
		.limit(boundedRunLimit(options?.limit, 50))
		.offset(Math.max(options?.offset ?? 0, 0));
}

export interface ListSkillRunsForSkillOptions extends SkillRunListFilters {
	limit?: number;
	offset?: number;
	metadataOnly?: boolean;
}

export async function listSkillRunsForSkill(
	db: DbClient,
	organizationId: string,
	skillId: string,
	runtimeEnvironment: SkillRunRuntimeEnvironment,
	options?: ListSkillRunsForSkillOptions,
): Promise<SkillRunSummaryRow[]> {
	const conditions = [
		eq(skillRuns.organizationId, organizationId),
		eq(skillRuns.skillId, skillId),
		skillRunEnvironmentCondition(runtimeEnvironment),
	];
	conditions.push(...skillRunFilterConditions(options));

	return db
		.select(skillRunSummaryProjection(options?.metadataOnly))
		.from(skillRuns)
		.where(and(...conditions))
		.orderBy(desc(skillRuns.startedAt), desc(skillRuns.id))
		.limit(boundedRunLimit(options?.limit, 50))
		.offset(Math.max(options?.offset ?? 0, 0));
}

export interface ListSkillRunsForOrgOptions extends SkillRunListFilters {
	limit?: number;
	offset?: number;
	metadataOnly?: boolean;
}

/**
 * Org-wide fleet view: recent runs across every tedi and skill in the
 * organization. Summary rows carry skillSlug/skillRevision so the list is
 * self-describing without per-skill lookups.
 */
export async function listSkillRunsForOrg(
	db: DbClient,
	organizationId: string,
	runtimeEnvironment: SkillRunRuntimeEnvironment,
	options?: ListSkillRunsForOrgOptions,
): Promise<SkillRunSummaryRow[]> {
	const conditions = [
		eq(skillRuns.organizationId, organizationId),
		skillRunEnvironmentCondition(runtimeEnvironment),
	];
	conditions.push(...skillRunFilterConditions(options));

	return db
		.select(skillRunSummaryProjection(options?.metadataOnly))
		.from(skillRuns)
		.where(and(...conditions))
		.orderBy(desc(skillRuns.startedAt), desc(skillRuns.id))
		.limit(boundedRunLimit(options?.limit, 50))
		.offset(Math.max(options?.offset ?? 0, 0));
}

/**
 * Failed workflow runs that still represent actionable retry work.
 *
 * Archived skill revisions and failures followed by a successful run of the
 * same or a newer revision for the same skill slug + tedi are historical
 * evidence, not queue entries. Filter them before LIMIT so stale history
 * cannot crowd current failures out of the bounded operator inbox.
 */
export async function listSkillWorkflowRetryCandidateRuns(
	db: DbClient,
	organizationId: string,
	runtimeEnvironment: SkillRunRuntimeEnvironment,
	limit?: number,
): Promise<SkillRunSummaryRow[]> {
	const successfulRun = alias(skillRuns, "successful_skill_run");

	return db
		.select(skillRunSummarySelect)
		.from(skillRuns)
		.innerJoin(
			skillEntries,
			and(
				eq(skillEntries.id, skillRuns.skillId),
				eq(skillEntries.organizationId, skillRuns.organizationId),
			),
		)
		.where(
			and(
				eq(skillRuns.organizationId, organizationId),
				skillRunEnvironmentCondition(runtimeEnvironment),
				eq(skillRuns.status, "failed"),
				isNull(skillRuns.workflowRetiredAt),
				isNull(skillRuns.restartRequestedAt),
				ne(skillEntries.lifecycleState, "archived"),
				notExists(
					db
						.select({ id: successfulRun.id })
						.from(successfulRun)
						.where(
							and(
								eq(successfulRun.organizationId, skillRuns.organizationId),
								eq(
									successfulRun.runtimeEnvironment,
									skillRuns.runtimeEnvironment,
								),
								eq(successfulRun.tediId, skillRuns.tediId),
								eq(successfulRun.skillSlug, skillRuns.skillSlug),
								eq(successfulRun.status, "completed"),
								or(
									gt(successfulRun.skillRevision, skillRuns.skillRevision),
									and(
										eq(successfulRun.skillRevision, skillRuns.skillRevision),
										gt(successfulRun.startedAt, skillRuns.startedAt),
									),
								),
							),
						),
				),
			),
		)
		.orderBy(desc(skillRuns.startedAt))
		.limit(boundedRunLimit(limit, 50));
}

/**
 * Return the latest run snapshot for each requested skill in one bounded
 * tenant/environment-scoped read. A global "recent runs" sample is not enough:
 * a busy skill could otherwise hide the only evidence for a quieter one.
 */
export async function listLatestSkillRunsForSkills(
	db: DbClient,
	organizationId: string,
	skillIds: string[],
	runtimeEnvironment: SkillRunRuntimeEnvironment,
): Promise<SkillRunSummaryRow[]> {
	const ids = [...new Set(skillIds)];
	if (ids.length === 0) return [];

	// D1 caps bound parameters at 100 per statement. The follow-up query binds
	// each chunked skill id once in the IN() list plus a (skillId, startedAt)
	// pair per observed skill, so 30 ids per chunk (≤ 30 + 60 + scope params)
	// stays under the cap.
	const merged: SkillRunSummaryRow[] = [];
	for (const idChunk of chunkForBoundParams(ids, 30)) {
		const baseConditions = [
			eq(skillRuns.organizationId, organizationId),
			inArray(skillRuns.skillId, idChunk),
			skillRunEnvironmentCondition(runtimeEnvironment),
		];
		const maxima = await db
			.select({
				skillId: skillRuns.skillId,
				startedAt: sql<string | null>`max(${skillRuns.startedAt})`,
			})
			.from(skillRuns)
			.where(and(...baseConditions))
			.groupBy(skillRuns.skillId);
		const observed = maxima.filter(
			(row): row is { skillId: string; startedAt: string } =>
				row.startedAt != null,
		);
		if (observed.length === 0) continue;

		merged.push(
			...(await db
				.select(skillRunSummarySelect)
				.from(skillRuns)
				.where(
					and(
						...baseConditions,
						or(
							...observed.map((row) =>
								and(
									eq(skillRuns.skillId, row.skillId),
									eq(skillRuns.startedAt, row.startedAt),
								),
							),
						),
					),
				)
				.orderBy(desc(skillRuns.startedAt), desc(skillRuns.id))),
		);
	}

	// Re-establish the single-statement ordering across chunks before the
	// first-row-per-skill dedupe.
	merged.sort(
		(a, b) =>
			(b.startedAt ?? "").localeCompare(a.startedAt ?? "") ||
			b.id.localeCompare(a.id),
	);
	const seen = new Set<string>();
	return merged.filter((row) => {
		if (seen.has(row.skillId)) return false;
		seen.add(row.skillId);
		return true;
	});
}

export interface ReportedSkillRunRow {
	id: string;
	executionEpoch: number;
	status: SkillRunStatus;
	startedAt: string | null;
	completedAt: string | null;
	cards: number | null;
	summary: string | null;
	error: string | null;
}

/**
 * The latest finished run of a skill that did work, for a one-line "last run"
 * report. Runs whose result status is one of `skippedResultStatuses` (a
 * scheduled workflow that stopped because the fire was not one of its local
 * times) are left out. Only the bounded `cards`, `summary` and error head are
 * read, never the whole result.
 */
export async function getLatestReportedSkillRun(
	db: DbClient,
	params: {
		organizationId: string;
		skillId: string;
		runtimeEnvironment: SkillRunRuntimeEnvironment;
		skippedResultStatuses: readonly string[];
	},
): Promise<ReportedSkillRunRow | undefined> {
	const resultStatus = sql`coalesce(json_extract(${skillRuns.result}, '$.status'), '')`;
	const [row] = await db
		.select({
			id: skillRuns.id,
			executionEpoch: skillRuns.executionEpoch,
			status: skillRuns.status,
			startedAt: skillRuns.startedAt,
			completedAt: skillRuns.completedAt,
			cards: sql<number | null>`case
				when json_type(${skillRuns.result}, '$.cards') = 'integer'
				then json_extract(${skillRuns.result}, '$.cards')
				else null
			end`.as("reported_cards"),
			summary: sql<string | null>`case
				when json_type(${skillRuns.result}, '$.summary') = 'text'
				then substr(json_extract(${skillRuns.result}, '$.summary'), 1, 600)
				else null
			end`.as("reported_summary"),
			error: sql<string | null>`substr(${skillRuns.error}, 1, 600)`.as(
				"reported_error",
			),
		})
		.from(skillRuns)
		.where(
			and(
				eq(skillRuns.organizationId, params.organizationId),
				eq(skillRuns.skillId, params.skillId),
				skillRunEnvironmentCondition(params.runtimeEnvironment),
				inArray(skillRuns.status, ["completed", "failed"]),
				...(params.skippedResultStatuses.length > 0
					? [
							sql`${resultStatus} not in (${sql.join(
								params.skippedResultStatuses.map((status) => sql`${status}`),
								sql`, `,
							)})`,
						]
					: []),
			),
		)
		.orderBy(
			desc(sql`coalesce(${skillRuns.completedAt}, ${skillRuns.startedAt})`),
			desc(skillRuns.id),
		)
		.limit(1);
	return row;
}

/**
 * Mark a run as canceled in the DB. Does NOT call the workflow engine —
 * the handler is responsible for engine cancellation before invoking this.
 */
export async function cancelSkillRun(
	db: DbClient,
	runId: string,
	orgId: string,
	runtimeEnvironment: SkillRunRuntimeEnvironment,
): Promise<boolean> {
	const canceled = await db
		.update(skillRuns)
		.set({
			status: "canceled",
			completedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(skillRuns.id, runId),
				eq(skillRuns.organizationId, orgId),
				skillRunEnvironmentCondition(runtimeEnvironment),
				notInArray(skillRuns.status, ["completed", "failed", "canceled"]),
			),
		)
		.returning({ id: skillRuns.id });
	return canceled.length > 0;
}

export interface ListSkillRunSnapshotsOptions {
	limit?: number;
	tediId?: string;
	status?: SkillRunStatus;
}

/**
 * Read run-pinned workflow snapshots for revision inspection.
 *
 * These are observed/executed revisions, not a general skill edit history:
 * a row exists only after a workflow was dispatched. Organization scope is
 * mandatory because the pinned source and SKILL.md may contain tenant data.
 */
export async function listSkillRunSnapshotsForSkill(
	db: DbClient,
	organizationId: string,
	skillId: string,
	runtimeEnvironment: SkillRunRuntimeEnvironment,
	options?: ListSkillRunSnapshotsOptions,
): Promise<SkillRun[]> {
	const conditions = [
		eq(skillRuns.organizationId, organizationId),
		eq(skillRuns.skillId, skillId),
		skillRunEnvironmentCondition(runtimeEnvironment),
	];
	if (options?.tediId) conditions.push(eq(skillRuns.tediId, options.tediId));
	if (options?.status) conditions.push(eq(skillRuns.status, options.status));

	return db
		.select({ ...getColumns(skillRuns), workflowSource: pinnedWorkflowSource })
		.from(skillRuns)
		.where(and(...conditions))
		.orderBy(desc(skillRuns.startedAt))
		.limit(boundedRunLimit(options?.limit, 100));
}

export type FailedSkillRunEventRow = Pick<
	SkillRun,
	"id" | "skillId" | "tediId" | "workItemId" | "executionEpoch"
> & {
	completedAt: string;
	errorClass: "admission" | "execution";
};

/**
 * Org-scoped ascending keyset read of failed runs, projected as the
 * `skill.run.failed` MCP event. Only a coarse error class leaves this query;
 * the stored error message and stack never do.
 */
export async function listFailedSkillRunEvents(
	db: DbClient,
	p: {
		organizationId: string;
		after: { at: string; id: string } | null;
		tediId?: string;
		skillId?: string;
		limit: number;
	},
): Promise<FailedSkillRunEventRow[]> {
	const rows = await db
		.select({
			id: skillRuns.id,
			skillId: skillRuns.skillId,
			tediId: skillRuns.tediId,
			workItemId: skillRuns.workItemId,
			executionEpoch: skillRuns.executionEpoch,
			completedAt: skillRuns.completedAt,
			errorClass: sql<
				"admission" | "execution"
			>`CASE WHEN instr(coalesce(${skillRuns.error}, ''), 'WORKFLOW_ADMISSION_') = 1 THEN 'admission' ELSE 'execution' END`.as(
				"error_class",
			),
		})
		.from(skillRuns)
		.where(
			and(
				eq(skillRuns.organizationId, p.organizationId),
				eq(skillRuns.status, "failed"),
				sql`${skillRuns.completedAt} IS NOT NULL`,
				p.tediId ? eq(skillRuns.tediId, p.tediId) : undefined,
				p.skillId ? eq(skillRuns.skillId, p.skillId) : undefined,
				p.after
					? sql`(${skillRuns.completedAt}>${p.after.at} OR (${skillRuns.completedAt}=${p.after.at} AND ${skillRuns.id}>${p.after.id}))`
					: undefined,
			),
		)
		.orderBy(asc(skillRuns.completedAt), asc(skillRuns.id))
		.limit(p.limit);
	return rows.map((row) => ({ ...row, completedAt: row.completedAt ?? "" }));
}

/** Newest failed-run position in the org, used to poll "from now". */
export async function getLatestFailedSkillRunPosition(
	db: DbClient,
	organizationId: string,
): Promise<{ at: string; id: string } | null> {
	const [row] = await db
		.select({ at: skillRuns.completedAt, id: skillRuns.id })
		.from(skillRuns)
		.where(
			and(
				eq(skillRuns.organizationId, organizationId),
				eq(skillRuns.status, "failed"),
				sql`${skillRuns.completedAt} IS NOT NULL`,
			),
		)
		.orderBy(desc(skillRuns.completedAt), desc(skillRuns.id))
		.limit(1);
	return row?.at ? { at: row.at, id: row.id } : null;
}
