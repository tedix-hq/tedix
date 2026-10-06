import type { OsDerivedAccessEnvelope } from "@tedix/api-contract/schemas/os-workspaces";
/**
 * Skill Runs Query Helpers
 * Lifecycle operations for skill workflow execution records.
 */

import type { SkillRunCostSummary } from "@tedix/api-contract/contracts/cognitive";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	and,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	ne,
	notExists,
	notInArray,
	or,
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
	skillRuns,
} from "../schema/cognitive";
import { chunkForBoundParams } from "../utils/batch";
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
		.select()
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

export interface ListSkillRunsForTediOptions {
	limit?: number;
	offset?: number;
	/** Omit private run inputs from a read-only capture inventory. */
	metadataOnly?: boolean;
	status?: SkillRunStatus;
	skillId?: string;
	/** Filter runs to skills carrying this exact JSON-array tag. */
	skillTag?: string;
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
}

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
	if (options?.status) conditions.push(eq(skillRuns.status, options.status));
	if (options?.skillId) conditions.push(eq(skillRuns.skillId, options.skillId));
	if (options?.skillTag) conditions.push(skillTagCondition(options.skillTag));

	return db
		.select(skillRunSummaryProjection(options?.metadataOnly))
		.from(skillRuns)
		.where(and(...conditions))
		.orderBy(desc(skillRuns.startedAt), desc(skillRuns.id))
		.limit(boundedRunLimit(options?.limit, 50))
		.offset(Math.max(options?.offset ?? 0, 0));
}

export interface ListSkillRunsForSkillOptions {
	limit?: number;
	offset?: number;
	metadataOnly?: boolean;
	status?: SkillRunStatus;
	/** Filter runs to skills carrying this exact JSON-array tag. */
	skillTag?: string;
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
	if (options?.status) conditions.push(eq(skillRuns.status, options.status));
	if (options?.skillTag) conditions.push(skillTagCondition(options.skillTag));

	return db
		.select(skillRunSummaryProjection(options?.metadataOnly))
		.from(skillRuns)
		.where(and(...conditions))
		.orderBy(desc(skillRuns.startedAt), desc(skillRuns.id))
		.limit(boundedRunLimit(options?.limit, 50))
		.offset(Math.max(options?.offset ?? 0, 0));
}

export interface ListSkillRunsForOrgOptions {
	limit?: number;
	offset?: number;
	metadataOnly?: boolean;
	status?: SkillRunStatus;
	/** Filter runs to skills carrying this exact JSON-array tag. */
	skillTag?: string;
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
	if (options?.status) conditions.push(eq(skillRuns.status, options.status));
	if (options?.skillTag) conditions.push(skillTagCondition(options.skillTag));

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
		.select()
		.from(skillRuns)
		.where(and(...conditions))
		.orderBy(desc(skillRuns.startedAt))
		.limit(boundedRunLimit(options?.limit, 100));
}
