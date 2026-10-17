import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { projects } from "../schema/projects";
import { workItems, workAttempts } from "../schema/work-items";
import { skillRuns } from "../schema/cognitive";
import { kernelRuntimeRuns } from "../schema/cognitive-runtime";
import { tedis } from "../schema/tedis";
import { osGadgetExecutions, osWorkspaces } from "../schema/os-workspaces";
import { tediObjectives } from "../schema/tedi-objectives";
import { workInteractions } from "../schema/work-factory";

export async function attentionProjectBriefs(db: DbQueryClient, orgId: string) {
	return db
		.select({
			id: projects.id,
			name: projects.name,
			description: projects.description,
			factory: sql<
				string | null
			>`json_extract(${projects.metadata}, '$.factory')`.as("factory_brief"),
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
	userId?: string,
) {
	const [projectRows, attempts, backlog, skills, runs] = await Promise.all([
		db
			.select({
				id: projects.id,
				name: projects.name,
				status: projects.status,
				objectiveId: projects.objectiveId,
				lastAttentionAt: sql<
					string | null
				>`(select max(a.heartbeat_at) from work_attempts a join work_items w on w.id = a.work_item_id and w.org_id = a.org_id where a.org_id = ${orgId} and w.project_id = projects.id)`.as(
					"project_last_attention_at",
				),
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
				registeredLane:
					sql<boolean>`json_extract(${workAttempts.metadata}, '$.lane') = 1`.mapWith(
						Boolean,
					),
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
				deadline: workItems.deadline,
				observer: sql<
					number | null
				>`json_extract(${workItems.metadata}, '$.repositoryObserver')`.as(
					"observer",
				),
				diagnosis: sql<
					string | null
				>`coalesce(json_extract(${workItems.metadata}, '$.latestReport.diagnosis'), json_extract(${workItems.metadata}, '$.report.diagnosis'))`.as(
					"diagnosis",
				),
			})
			.from(workItems)
			.where(
				and(
					eq(workItems.orgId, orgId),
					inArray(workItems.disposition, ["proposed", "accepted"]),
					sql`not exists (select 1 from work_attempts a where a.org_id = ${orgId} and a.work_item_id = work_items.id and a.outcome is null and a.expires_at > ${new Date().toISOString()})`,
				),
			)
			.orderBy(
				sql`CASE WHEN json_extract(${workItems.metadata}, '$.repositoryObserver') = 1 AND ${workItems.deadline} IS NOT NULL AND coalesce(json_extract(${workItems.metadata}, '$.latestReport.stillRed'), json_extract(${workItems.metadata}, '$.report.stillRed'), 1) = 1 THEN ${workItems.deadline} ELSE '9999' END`,
				desc(workItems.createdAt),
			)
			.limit(101),
		db
			.select({
				id: skillRuns.id,
				title: skillRuns.skillSlug,
				createdBy: skillRuns.createdBy,
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
				workspaceId: sql<
					string | null
				>`(select c.workspace_id from kernel_conversations c where c.organization_id = ${orgId} and c.id = kernel_runtime_runs.conversation_id)`.as(
					"attention_workspace_id",
				),
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
		waiting: userId
			? await db
					.select({
						id: workInteractions.id,
						subject:
							sql<string>`coalesce((SELECT 'Outbound · ' || coalesce(json_extract(w.metadata,'$.outbound.draft.subject'), w.title) FROM work_items w WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND json_extract(w.metadata,'$.outbound.interactionId')=${workInteractions.id}), ${workInteractions.subject})`.as(
								"outbound_subject",
							),
						prompt:
							sql<string>`coalesce((SELECT coalesce(json_extract(w.metadata,'$.outbound.review.notes'), json_extract(w.metadata,'$.outbound.draft.reasoning')) FROM work_items w WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND json_extract(w.metadata,'$.outbound.interactionId')=${workInteractions.id}), ${workInteractions.prompt})`.as(
								"outbound_note",
							),
						createdAt: workInteractions.createdAt,
						workItemId: workInteractions.workItemId,
						creatorSession: workInteractions.creatorExternalSessionKey,
						projectId: sql<
							string | null
						>`(SELECT w.project_id FROM work_items w WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId})`.as(
							"handoff_project_id",
						),
					})
					.from(workInteractions)
					.where(
						and(
							eq(workInteractions.orgId, orgId),
							eq(workInteractions.targetType, "user"),
							eq(workInteractions.targetId, userId),
							eq(workInteractions.status, "open"),
							sql`(json_type(${workInteractions.metadata},'$.laneHandoff')='object' OR json_type(${workInteractions.metadata},'$.followThrough.laneHandoff')='object' OR EXISTS (SELECT 1 FROM work_items w WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND w.work_kind='outbound' AND json_extract(w.metadata,'$.outbound.interactionId')=${workInteractions.id} AND json_extract(w.metadata,'$.outbound.status') IN ('waiting_on_you','send_unknown')))`,
							sql`coalesce(json_extract(${workInteractions.metadata},'$.followThrough.snoozedUntil'),'')<=${new Date().toISOString()}`,
							sql`(${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${new Date().toISOString()})`,
							sql`NOT EXISTS (SELECT 1 FROM work_items w WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND w.disposition IN ('completed','cancelled'))`,
						),
					)
					.limit(100)
			: [],
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
		.select({
			id: tediObjectives.id,
			title: tediObjectives.title,
			lastAttentionAt: sql<
				string | null
			>`(select max(a.heartbeat_at) from work_attempts a join work_items w on w.id = a.work_item_id and w.org_id = a.org_id where a.org_id = ${orgId} and w.objective_id = tedi_objectives.id)`.as(
				"objective_last_attention_at",
			),
		})
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

export async function readAttentionFactoryLinks(
	db: DbQueryClient,
	organizationId: string,
	descopeUserId: string,
	since: string,
) {
	return db
		.select({
			runId: osGadgetExecutions.runId,
			workspaceId: osGadgetExecutions.workspaceId,
			factoryName: osWorkspaces.name,
		})
		.from(osGadgetExecutions)
		.innerJoin(
			osWorkspaces,
			and(
				eq(osWorkspaces.organizationId, organizationId),
				eq(osWorkspaces.id, osGadgetExecutions.workspaceId),
			),
		)
		.where(
			and(
				eq(osGadgetExecutions.organizationId, organizationId),
				or(
					gte(osGadgetExecutions.createdAt, since),
					inArray(osGadgetExecutions.status, [
						"running",
						"queued",
						"awaiting_approval",
						"paused",
					]),
				),
				or(
					eq(osWorkspaces.visibility, "org"),
					eq(osWorkspaces.ownerUserId, descopeUserId),
				),
			),
		)
		.orderBy(desc(osGadgetExecutions.createdAt))
		.limit(500);
}
