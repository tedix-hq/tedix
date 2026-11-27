import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { coreStore, likeText } from "../core-store/dialect";
import { and, asc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import {
	skillRuns,
	skillRunArtifacts,
	skillRunAdmissionDedup,
} from "../schema/cognitive";
import { apps } from "../schema/apps";
import { tedis } from "../schema/tedis";

export async function reserveSkillRunExecutionEpoch(
	db: DbClient,
	runId: string,
	expectedExecutionEpoch: number,
	restartCommandId: string,
): Promise<number | null> {
	const t = coreTable(db, skillRuns);
	const [row] = await db
		.update(t)
		.set({
			executionEpoch: sql`execution_epoch + 1`,
			restartRequestedAt: new Date().toISOString(),
			restartCommandId,
		})
		.where(sql`id = ${runId}
			   AND execution_epoch = ${expectedExecutionEpoch}
			   AND restart_requested_at IS NULL
			   AND workflow_retired_at IS NULL
			   AND COALESCE(error, '') <> 'REVOKED'
			   AND substr(COALESCE(error, ''), 1, 8) <> 'REVOKED:'`)
		.returning({ execution_epoch: t.executionEpoch });
	return row?.execution_epoch ?? null;
}

export async function updateSkillRunAfterControl(
	db: DbClient,
	runId: string,
	status: string,
	options: {
		restart?: boolean;
		clearRestartIntent?: boolean;
		expectedExecutionEpoch?: number;
		requireAdmissionMarker?: boolean;
		requireRestartIntent?: boolean;
	} = {},
): Promise<boolean> {
	const t = coreTable(db, skillRuns);
	const now = new Date().toISOString();
	const terminal = ["completed", "failed", "canceled"].includes(status);
	const rows = await db
		.update(t)
		.set({
			status: status as typeof t.$inferSelect.status,
			startedAt:
				options.restart && options.requireRestartIntent
					? sql`coalesce(restart_requested_at, started_at)`
					: t.startedAt,
			result: options.restart ? null : t.result,
			error: options.restart ? null : t.error,
			costSummary: options.restart ? null : t.costSummary,
			completedAt: options.restart
				? null
				: terminal
					? sql`coalesce(completed_at, ${now})`
					: t.completedAt,
			pausedAt: status === "paused" ? sql`coalesce(paused_at, ${now})` : null,
			restartRequestedAt: options.clearRestartIntent
				? null
				: t.restartRequestedAt,
			restartCommandId: options.clearRestartIntent ? null : t.restartCommandId,
		})
		.where(sql`id = ${runId}
			    AND (CAST(${options.expectedExecutionEpoch ?? null} AS double precision) IS NULL OR execution_epoch = ${options.expectedExecutionEpoch ?? null})
			    AND (${options.requireRestartIntent ? 1 : 0} = 0 OR restart_requested_at IS NOT NULL)
			    AND (
			      ${options.requireAdmissionMarker ? 1 : 0} = 0 OR (
			        status = 'failed' AND (
			          ${likeText(db, sql`error`, "WORKFLOW_ADMISSION_PENDING:%")}
			          OR ${likeText(db, sql`error`, "WORKFLOW_ADMISSION_CREATE_FAILED:%")}
			        )
			      )
			    )
			    AND (
			      status NOT IN ('completed','failed','canceled')
			      OR (${options.restart ? 1 : 0} = 1 AND ${options.requireRestartIntent ? 1 : 0} = 1 AND restart_requested_at IS NOT NULL)
			      OR (${options.restart ? 1 : 0} = 1 AND ${options.requireAdmissionMarker ? 1 : 0} = 1 AND status = 'failed' AND (
			        ${likeText(db, sql`error`, "WORKFLOW_ADMISSION_PENDING:%")}
			        OR ${likeText(db, sql`error`, "WORKFLOW_ADMISSION_CREATE_FAILED:%")}
			      ))
			    )`)
		.returning({ id: t.id });
	return rows.length === 1;
}

export async function clearSkillRunRestartIntent(
	db: DbClient,
	runId: string,
	executionEpoch: number,
): Promise<boolean> {
	const t = coreTable(db, skillRuns);
	const rows = await db
		.update(t)
		.set({ restartRequestedAt: null, restartCommandId: null })
		.where(sql`id = ${runId}
			    AND execution_epoch = ${executionEpoch}
			    AND restart_requested_at IS NOT NULL`)
		.returning({ id: t.id });
	return rows.length === 1;
}

export async function finalizeAbortedSkillRunRestart(
	db: DbClient,
	runId: string,
	executionEpoch: number,
	restartCommandId: string,
): Promise<boolean> {
	const t = coreTable(db, skillRuns);
	const now = new Date().toISOString();
	const rows = await db
		.update(t)
		.set({
			status: "canceled",
			result: null,
			error: null,
			costSummary: null,
			startedAt: t.restartRequestedAt,
			completedAt: now,
			pausedAt: null,
			workflowRetiredAt: sql`coalesce(workflow_retired_at, ${now})`,
			restartRequestedAt: null,
			restartCommandId: null,
		})
		.where(sql`id = ${runId}
			    AND execution_epoch = ${executionEpoch}
			    AND restart_requested_at IS NOT NULL
			    AND restart_command_id = ${restartCommandId}`)
		.returning({ id: t.id });
	return rows.length === 1;
}

export async function touchSkillRunReconciled(
	db: DbClient,
	runId: string,
): Promise<void> {
	const t = coreTable(db, skillRuns);
	await db
		.update(t)
		.set({ lastReconciledAt: new Date().toISOString() })
		.where(eq(t.id, runId));
}

export async function getSkillRunArtifactStorageRow(
	db: DbClient,
	runId: string,
	path: string,
) {
	const t = coreTable(db, skillRunArtifacts);
	const [row] = await db
		.select({
			id: t.id,
			size_bytes: t.sizeBytes,
			content_r2_key: t.contentR2Key,
			sha256: t.sha256,
		})
		.from(t)
		.where(and(eq(t.runId, runId), eq(t.path, path)))
		.limit(1);
	return row ?? null;
}

export async function insertSkillRunArtifactOnce(
	db: DbClient,
	input: {
		id: string;
		runId: string;
		path: string;
		mimeType: string;
		sizeBytes: number;
		contentInline: string | null;
		contentR2Key: string | null;
		sha256: string | null;
		attempt: number;
		outcome: string;
	},
): Promise<boolean> {
	const t = coreTable(db, skillRunArtifacts);
	const rows = await db
		.insert(t)
		.values({
			...input,
			outcome: input.outcome as typeof t.$inferSelect.outcome,
		})
		.onConflictDoNothing()
		.returning({ id: t.id });
	return rows.length > 0;
}

export async function claimSkillWorkflowAdmissionFence(
	db: DbClient,
	input: {
		fingerprint: string;
		candidateRunId: string;
		expiresAt: string;
		now: string;
	},
): Promise<{ run_id: string; expires_at: string } | null> {
	const t = coreTable(db, skillRunAdmissionDedup);
	const values = {
		fingerprint: input.fingerprint,
		runId: input.candidateRunId,
		expiresAt: input.expiresAt,
		createdAt: input.now,
	};
	const [row] = await db
		.insert(t)
		.values(values)
		.onConflictDoUpdate({
			target: t.fingerprint,
			set: {
				runId: values.runId,
				expiresAt: values.expiresAt,
				createdAt: values.createdAt,
			},
			setWhere: lte(t.expiresAt, input.now),
		})
		.returning({ run_id: t.runId, expires_at: t.expiresAt });
	return row ?? null;
}

export async function getSkillWorkflowAdmissionFence(
	db: DbClient,
	fingerprint: string,
): Promise<{ run_id: string; expires_at: string } | null> {
	const t = coreTable(db, skillRunAdmissionDedup);
	const [row] = await db
		.select({ run_id: t.runId, expires_at: t.expiresAt })
		.from(t)
		.where(eq(t.fingerprint, fingerprint))
		.limit(1);
	return row ?? null;
}

export async function pruneSkillWorkflowAdmissionFences(
	db: DbClient,
	retentionCutoff: string,
): Promise<void> {
	const t = coreTable(db, skillRunAdmissionDedup);
	await db.delete(t).where(lt(t.expiresAt, retentionCutoff));
}

export async function releaseSkillWorkflowAdmissionFence(
	db: DbClient,
	input: { fingerprint: string; runId: string },
): Promise<void> {
	const t = coreTable(db, skillRunAdmissionDedup);
	await db
		.delete(t)
		.where(and(eq(t.fingerprint, input.fingerprint), eq(t.runId, input.runId)));
}

export async function listWorkflowCallReceiptStorage(
	db: DbClient,
	organizationId: string,
	runId: string,
	executionEpoch: number,
	after: string,
): Promise<
	Array<{
		path: string;
		content_inline: string | null;
		content_r2_key: string | null;
	}>
> {
	const a = coreTable(db, skillRunArtifacts);
	const r = coreTable(db, skillRuns);
	const pathPattern =
		coreStore(db) === "postgres"
			? sql`${a.path} LIKE ${`epochs/${executionEpoch}/steps/%/calls/%.json`}`
			: sql`${a.path} GLOB ${`epochs/${executionEpoch}/steps/*/calls/*.json`}`;
	return db
		.select({
			path: a.path,
			content_inline: a.contentInline,
			content_r2_key: a.contentR2Key,
		})
		.from(a)
		.innerJoin(r, eq(r.id, a.runId))
		.where(
			and(
				eq(a.runId, runId),
				pathPattern,
				gt(a.path, after),
				eq(r.organizationId, organizationId),
			),
		)
		.orderBy(asc(a.path))
		.limit(200);
}

export async function loadSkillRunSnapshotRow(db: DbClient, runId: string) {
	const t = coreTable(db, skillRuns);
	const [row] = await db
		.select({
			skill_id: t.skillId,
			tedi_id: t.tediId,
			organization_id: t.organizationId,
			params: sql<string | null>`cast(${t.params} as text)`,
			execution_epoch: t.executionEpoch,
			runtime_environment: t.runtimeEnvironment,
			workflow_retired_at: t.workflowRetiredAt,
			error: t.error,
			started_at: t.startedAt,
			skill_slug: t.skillSlug,
			skill_revision: t.skillRevision,
			workflow_source: t.workflowSource,
			skill_doc: t.skillDoc,
			capability_manifest: sql<
				string | null
			>`cast(${t.capabilityManifest} as text)`,
			resource_access_envelope: sql<
				string | null
			>`cast(${t.resourceAccessEnvelope} as text)`,
			certification: t.certification,
			created_by: t.createdBy,
			work_item_id: t.workItemId,
			origin_tedi_run_id: t.originTediRunId,
		})
		.from(t)
		.where(eq(t.id, runId))
		.limit(1);
	return row ?? null;
}

export async function getSkillRunRow(db: DbClient, runId: string) {
	const t = coreTable(db, skillRuns);
	const [row] = await db
		.select({
			id: t.id,
			skill_id: t.skillId,
			tedi_id: t.tediId,
			organization_id: t.organizationId,
			workflow_instance_id: t.workflowInstanceId,
			execution_epoch: t.executionEpoch,
			restart_requested_at: t.restartRequestedAt,
			restart_command_id: t.restartCommandId,
			workflow_retired_at: t.workflowRetiredAt,
			runtime_environment: t.runtimeEnvironment,
			status: t.status,
			error: t.error,
			started_at: t.startedAt,
			completed_at: t.completedAt,
			paused_at: t.pausedAt,
		})
		.from(t)
		.where(eq(t.id, runId))
		.limit(1);
	return row ?? null;
}

export async function reconcileSkillRunRow(
	db: DbClient,
	runId: string,
	patch: {
		status: string;
		result?: unknown;
		error?: string | null;
		expectedExecutionEpoch?: number;
	},
	now: string,
) {
	const t = coreTable(db, skillRuns);
	const isTerminal = ["completed", "failed", "canceled"].includes(patch.status);
	const isPaused = patch.status === "paused";
	const [row] = await db
		.update(t)
		.set({
			status: patch.status as typeof t.$inferSelect.status,
			result: sql`coalesce(${patch.result === undefined ? null : JSON.stringify(patch.result)}, result)`,
			error: sql`coalesce(${patch.error ?? null}, error)`,
			completedAt: isTerminal
				? sql`coalesce(completed_at, ${now})`
				: t.completedAt,
			pausedAt: isPaused ? sql`coalesce(paused_at, ${now})` : t.pausedAt,
		})
		.where(sql`id = ${runId}
			   AND (CAST(${patch.expectedExecutionEpoch ?? null} AS double precision) IS NULL OR execution_epoch = ${patch.expectedExecutionEpoch ?? null})
			   AND (
			     status NOT IN ('completed','failed','canceled')
			     OR (
			       status = 'failed'
			       AND ${patch.status} = 'failed'
			       AND (${likeText(db, sql`error`, "WORKFLOW_ADMISSION_PENDING:%")}
			            OR ${likeText(db, sql`error`, "WORKFLOW_ADMISSION_CREATE_FAILED:%")})
			     )
			   )`)
		.returning({
			execution_epoch: t.executionEpoch,
			restart_requested_at: t.restartRequestedAt,
		});
	return row ?? null;
}

export async function listRuntimeAppSlugs(db: DbClient, slugs: string[]) {
	const t = coreTable(db, apps);
	return db.select({ slug: t.slug }).from(t).where(inArray(t.slug, slugs));
}

export async function getRuntimeTediSlug(
	db: DbClient,
	organizationId: string,
	tediId: string,
) {
	const t = coreTable(db, tedis);
	const [row] = await db
		.select({ slug: t.slug })
		.from(t)
		.where(and(eq(t.id, tediId), eq(t.organizationId, organizationId)))
		.limit(1);
	return row ?? null;
}

export async function listRuntimeGatewayApps(
	db: DbClient,
	organizationId: string,
) {
	const t = coreTable(db, apps);
	return db
		.select({
			organization_id: t.organizationId,
			slug: t.slug,
			metadata: t.metadata,
		})
		.from(t)
		.where(eq(t.organizationId, organizationId));
}

export async function getRuntimeArtifactInlineContent(
	db: DbClient,
	runId: string,
	path: string,
) {
	const t = coreTable(db, skillRunArtifacts);
	const [row] = await db
		.select({ content_inline: t.contentInline })
		.from(t)
		.where(and(eq(t.runId, runId), eq(t.path, path)))
		.limit(1);
	return row ?? null;
}
