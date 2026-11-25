import { coreTable } from "../core-store/client";
import { booleanValue, coreStore, jsonRead } from "../core-store/dialect";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { projects as d1Projects } from "../schema/projects";
import {
	workItems as d1WorkItems,
	workAttempts as d1WorkAttempts,
} from "../schema/work-items";
import { skillRuns as d1SkillRuns } from "../schema/cognitive";
import { kernelRuntimeRuns as d1KernelRuntimeRuns } from "../schema/cognitive-runtime";
import { tedis as d1Tedis } from "../schema/tedis";
import {
	osGadgetExecutions as d1OsGadgetExecutions,
	osWorkspaces as d1OsWorkspaces,
} from "../schema/os-workspaces";
import { tediObjectives as d1TediObjectives } from "../schema/tedi-objectives";
import { workInteractions as d1WorkInteractions } from "../schema/work-factory";

export async function attentionProjectBriefs(db: DbQueryClient, orgId: string) {
	const projects = coreTable(db, d1Projects);
	const tediObjectives = coreTable(db, d1TediObjectives);
	return db
		.select({
			id: projects.id,
			name: projects.name,
			description: projects.description,
			factory: sql<
				string | null
			>`${jsonRead(db, projects.metadata, ["factory"])}`.as("factory_brief"),
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
	const projects = coreTable(db, d1Projects);
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
	const projects = coreTable(db, d1Projects);
	const workItems = coreTable(db, d1WorkItems);
	const workAttempts = coreTable(db, d1WorkAttempts);
	const skillRuns = coreTable(db, d1SkillRuns);
	const kernelRuntimeRuns = coreTable(db, d1KernelRuntimeRuns);
	const tedis = coreTable(db, d1Tedis);
	const workInteractions = coreTable(db, d1WorkInteractions);
	const now = new Date();
	// Project activity comes from one grouped read of the organization's
	// Attempts started in the last week, seeked on idx_work_attempt_org_started.
	// Per-project correlated subqueries walked every Work Item and Attempt of
	// large projects: 18M rows, then 7.4M rows and 8 s per call on 23 Nov 2026,
	// holding main D1 for every other request. Older activity is not attention.
	const activityFrom = new Date(
		Math.min(Date.parse(since), now.getTime() - 7 * 86_400_000),
	).toISOString();
	const [projectBase, projectActivity, attempts, backlog, skills, runs] =
		await Promise.all([
			db
				.select({
					id: projects.id,
					name: projects.name,
					status: projects.status,
					objectiveId: projects.objectiveId,
				})
				.from(projects)
				.where(eq(projects.orgId, orgId))
				.limit(201),
			db
				.select({
					projectId: workItems.projectId,
					lastAttentionAt: sql<string | null>`max(${workAttempts.heartbeatAt})`,
					active:
						sql<number>`sum(case when ${workAttempts.outcome} is null and ${workAttempts.expiresAt} > ${now.toISOString()} then 1 else 0 end)`.mapWith(
							Number,
						),
					recent:
						sql<number>`sum(case when ${workAttempts.heartbeatAt} >= ${since} then 1 else 0 end)`.mapWith(
							Number,
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
				.where(
					and(
						eq(workAttempts.orgId, orgId),
						gte(workAttempts.startedAt, activityFrom),
					),
				)
				.groupBy(workItems.projectId),
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
						sql<boolean>`${jsonRead(db, workAttempts.metadata, ["lane"], "boolean")} = ${booleanValue(db, true)}`.mapWith(
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
					observer: sql<number | null>`${workItems.repositoryObserver}`.as(
						"observer",
					),
					diagnosis: sql<
						string | null
					>`coalesce(${jsonRead(db, workItems.metadata, ["latestReport", "diagnosis"])}, ${jsonRead(db, workItems.metadata, ["report", "diagnosis"])})`.as(
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
					sql`CASE WHEN ${workItems.repositoryObserver} = 1 AND ${workItems.deadline} IS NOT NULL AND coalesce(${jsonRead(db, workItems.metadata, ["latestReport", "stillRed"], "boolean")}, ${jsonRead(db, workItems.metadata, ["report", "stillRed"], "boolean")}, ${booleanValue(db, true)}) = ${booleanValue(db, true)} THEN ${workItems.deadline} ELSE '9999' END`,
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
					and(
						eq(workItems.orgId, orgId),
						eq(workItems.id, skillRuns.workItemId),
					),
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
	const activityByProject = new Map(
		projectActivity.map((row) => [row.projectId, row]),
	);
	const projectRows = projectBase.map((project) => {
		const activity = activityByProject.get(project.id);
		return {
			...project,
			lastAttentionAt: activity?.lastAttentionAt ?? null,
			active: activity?.active ?? 0,
			recent: activity?.recent ?? 0,
		};
	});
	return {
		projects: projectRows.slice(0, 200),
		waiting: userId
			? await db
					.select({
						id: workInteractions.id,
						subject:
							sql<string>`coalesce((SELECT 'Outbound · ' || coalesce(${jsonRead(db, sql`w.metadata`, ["outbound", "draft", "subject"])}, w.title) FROM work_items w WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND ${jsonRead(db, sql`w.metadata`, ["outbound", "interactionId"])}=${workInteractions.id}), ${workInteractions.subject})`.as(
								"outbound_subject",
							),
						prompt:
							sql<string>`coalesce((SELECT coalesce(${jsonRead(db, sql`w.metadata`, ["outbound", "review", "notes"])}, ${jsonRead(db, sql`w.metadata`, ["outbound", "draft", "reasoning"])}) FROM work_items w WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND ${jsonRead(db, sql`w.metadata`, ["outbound", "interactionId"])}=${workInteractions.id}), ${workInteractions.prompt})`.as(
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
							sql`(${coreStore(db) === "postgres" ? sql`jsonb_typeof(${jsonRead(db, workInteractions.metadata, ["laneHandoff"], "json")})` : sql`json_type(${workInteractions.metadata},'$.laneHandoff')`}='object' OR ${coreStore(db) === "postgres" ? sql`jsonb_typeof(${jsonRead(db, workInteractions.metadata, ["followThrough", "laneHandoff"], "json")})` : sql`json_type(${workInteractions.metadata},'$.followThrough.laneHandoff')`}='object' OR EXISTS (SELECT 1 FROM work_items w WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND w.work_kind='outbound' AND ${jsonRead(db, sql`w.metadata`, ["outbound", "interactionId"])}=${workInteractions.id} AND ${jsonRead(db, sql`w.metadata`, ["outbound", "status"])} IN ('waiting_on_you','send_unknown')))`,
							sql`coalesce(${jsonRead(db, workInteractions.metadata, ["followThrough", "snoozedUntil"])},'')<=${new Date().toISOString()}`,
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
	const workItems = coreTable(db, d1WorkItems);
	const tediObjectives = coreTable(db, d1TediObjectives);
	// Seek one heartbeat per linked Work Item, regardless of its Attempt history.
	const lastAttentionAt = sql<
		string | null
	>`max((select a.heartbeat_at from work_attempts a where a.org_id = ${orgId} and a.work_item_id = ${workItems.id} order by a.heartbeat_at desc limit 1))`;
	return db
		.select({
			id: tediObjectives.id,
			title: tediObjectives.title,
			lastAttentionAt: lastAttentionAt.as("objective_last_attention_at"),
		})
		.from(tediObjectives)
		.leftJoin(
			workItems,
			and(
				eq(workItems.orgId, orgId),
				eq(workItems.objectiveId, tediObjectives.id),
			),
		)
		.where(
			and(eq(tediObjectives.orgId, orgId), eq(tediObjectives.status, "active")),
		)
		.groupBy(tediObjectives.id)
		.having(sql`${lastAttentionAt} is null or ${lastAttentionAt} < ${since}`)
		.orderBy(tediObjectives.priority)
		.limit(100);
}

export async function readAttentionFactoryLinks(
	db: DbQueryClient,
	organizationId: string,
	descopeUserId: string,
	since: string,
) {
	const osGadgetExecutions = coreTable(db, d1OsGadgetExecutions);
	const osWorkspaces = coreTable(db, d1OsWorkspaces);
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
