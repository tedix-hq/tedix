import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { projects } from "../schema/projects";
import { workItems, workAttempts } from "../schema/work-items";
import { skillRuns } from "../schema/cognitive";
import { kernelRuntimeRuns } from "../schema/cognitive-runtime";
import { tedis } from "../schema/tedis";
import { tediObjectives } from "../schema/tedi-objectives";

export async function attentionProjectBriefs(db: DbQueryClient, orgId: string) {
	return db
		.select({
			id: projects.id,
			name: projects.name,
			description: projects.description,
			objectiveId: projects.objectiveId,
			objective: sql<string | null>`${tediObjectives.description}`.as(
				"objective_brief",
			),
		})
		.from(projects)
		.leftJoin(
			tediObjectives,
			and(
				eq(tediObjectives.orgId, orgId),
				eq(tediObjectives.id, projects.objectiveId),
			),
		)
		.where(and(eq(projects.orgId, orgId), eq(projects.status, "active")))
		.limit(201);
}

export async function attentionProjectExists(
	db: DbQueryClient,
	orgId: string,
	id: string,
) {
	const [row] = await db
		.select({ id: projects.id })
		.from(projects)
		.where(and(eq(projects.orgId, orgId), eq(projects.id, id)))
		.limit(1);
	return !!row;
}

/** Bounded canonical sources; no inferred Work admission or invented Attempts. */
export async function readAttentionSources(
	db: DbQueryClient,
	orgId: string,
	since: string,
	descopeUserId?: string,
) {
	const [projectRows, attempts, backlog, skills, runs] = await Promise.all([
		db
			.select({
				id: projects.id,
				name: projects.name,
				status: projects.status,
				active:
					sql<number>`(select count(*) from work_attempts a join work_items w on w.id = a.work_item_id and w.org_id = a.org_id where a.org_id = ${orgId} and w.project_id = projects.id and a.outcome is null and a.expires_at > ${new Date().toISOString()})`.mapWith(
						Number,
					),
				recent:
					sql<number>`(select count(*) from work_attempts a join work_items w on w.id = a.work_item_id and w.org_id = a.org_id where a.org_id = ${orgId} and w.project_id = projects.id and a.heartbeat_at >= ${since})`.mapWith(
						Number,
					),
			})
			.from(projects)
			.where(eq(projects.orgId, orgId))
			.limit(201),
		db
			.select({
				id: workAttempts.id,
				workItemId: sql<string>`${workItems.id}`.as("attention_work_item_id"),
				title: workItems.title,
				projectId: workItems.projectId,
				session: workAttempts.externalSessionKey,
				who: workAttempts.executorType,
				name: tedis.name,
				state: workAttempts.runtimeState,
				outcome: workAttempts.outcome,
				startedAt: workAttempts.startedAt,
				heartbeatAt: workAttempts.heartbeatAt,
				expiresAt: workAttempts.expiresAt,
				finishedAt: workAttempts.finishedAt,
				note: workAttempts.summary,
				runId: workAttempts.runId,
			})
			.from(workAttempts)
			.innerJoin(
				workItems,
				and(
					eq(workItems.orgId, orgId),
					eq(workItems.id, workAttempts.workItemId),
				),
			)
			.leftJoin(
				tedis,
				and(
					eq(tedis.organizationId, orgId),
					eq(tedis.id, workAttempts.executorId),
				),
			)
			.where(
				and(
					eq(workAttempts.orgId, orgId),
					or(
						gte(workAttempts.heartbeatAt, since),
						inArray(workAttempts.runtimeState, [
							"running",
							"waiting",
							"queued",
							"retrying",
						]),
					),
				),
			)
			.orderBy(desc(workAttempts.startedAt))
			.limit(201),
		db
			.select({
				id: workItems.id,
				title: workItems.title,
				projectId: workItems.projectId,
				createdAt: workItems.createdAt,
			})
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, orgId),
					inArray(workItems.disposition, ["proposed", "accepted"]),
					sql`not exists (select 1 from work_attempts a where a.org_id = ${orgId} and a.work_item_id = work_items.id and a.outcome is null and a.expires_at > ${new Date().toISOString()})`,
				),
			)
			.orderBy(desc(workItems.createdAt))
			.limit(101),
		db
			.select({
				id: skillRuns.id,
				title: skillRuns.skillSlug,
				who: tedis.name,
				workItemId: skillRuns.workItemId,
				projectId: workItems.projectId,
				status: skillRuns.status,
				startedAt: skillRuns.startedAt,
				finishedAt: skillRuns.completedAt,
				heartbeatAt: skillRuns.lastReconciledAt,
				note: skillRuns.error,
			})
			.from(skillRuns)
			.leftJoin(
				tedis,
				and(eq(tedis.organizationId, orgId), eq(tedis.id, skillRuns.tediId)),
			)
			.leftJoin(
				workItems,
				and(eq(workItems.orgId, orgId), eq(workItems.id, skillRuns.workItemId)),
			)
			.where(
				and(
					eq(skillRuns.organizationId, orgId),
					or(
						gte(skillRuns.startedAt, since),
						inArray(skillRuns.status, ["running", "queued", "paused"]),
					),
				),
			)
			.orderBy(desc(skillRuns.startedAt))
			.limit(101),
		db
			.select({
				id: kernelRuntimeRuns.id,
				who: tedis.name,
				status: kernelRuntimeRuns.status,
				startedAt: kernelRuntimeRuns.createdAt,
				updatedAt: kernelRuntimeRuns.updatedAt,
				heartbeatAt: kernelRuntimeRuns.latestEventAt,
				note: kernelRuntimeRuns.progressDetail,
				title: kernelRuntimeRuns.progressLabel,
			})
			.from(kernelRuntimeRuns)
			.leftJoin(
				tedis,
				and(
					eq(tedis.organizationId, orgId),
					eq(tedis.id, kernelRuntimeRuns.delegatedTediId),
				),
			)
			.where(
				and(
					eq(kernelRuntimeRuns.organizationId, orgId),
					sql`(not exists (select 1 from kernel_conversation_grants g where g.organization_id = ${orgId} and g.conversation_id = kernel_runtime_runs.conversation_id) or exists (select 1 from kernel_conversation_grants g where g.organization_id = ${orgId} and g.conversation_id = kernel_runtime_runs.conversation_id and g.grantee_descope_user_id = ${descopeUserId ?? ""}))`,
					or(
						gte(kernelRuntimeRuns.updatedAt, since),
						inArray(kernelRuntimeRuns.status, [
							"queued",
							"running",
							"requires_approval",
						]),
					),
				),
			)
			.orderBy(desc(kernelRuntimeRuns.createdAt))
			.limit(101),
	]);
	return {
		projects: projectRows.slice(0, 200),
		attempts: attempts.slice(0, 200),
		backlog: backlog.slice(0, 100),
		skills: skills.slice(0, 100),
		runs: runs.slice(0, 100),
		truncated:
			projectRows.length > 200 ||
			attempts.length > 200 ||
			backlog.length > 100 ||
			skills.length > 100 ||
			runs.length > 100,
	};
}

export async function listUnattendedObjectives(
	db: DbQueryClient,
	orgId: string,
	since: string,
) {
	return db
		.select({ id: tediObjectives.id, title: tediObjectives.title })
		.from(tediObjectives)
		.where(
			and(
				eq(tediObjectives.orgId, orgId),
				eq(tediObjectives.status, "active"),
				sql`not exists (select 1 from work_attempts a join work_items w on w.id = a.work_item_id and w.org_id = a.org_id where a.org_id = ${orgId} and w.objective_id = tedi_objectives.id and a.heartbeat_at >= ${since})`,
			),
		)
		.orderBy(tediObjectives.priority)
		.limit(100);
}
