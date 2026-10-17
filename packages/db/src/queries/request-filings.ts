import { and, desc, eq, exists, isNull, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import {
	agentSessionRequests,
	type AgentSessionRequestRow,
} from "../schema/agent-session-requests";
import { learningInteractionEvents } from "../schema/learning-feedback";
import { tediObjectives } from "../schema/tedi-objectives";
import { projects } from "../schema/projects";
import { osWorkspaces, osWorkspaceProjects } from "../schema/os-workspaces";
import { workEvents, workItems } from "../schema/work-items";
import type { AgentSessionRequestOwner } from "./agent-session-requests";

export const FILING_SURFACE = "request_filing";

/** Private examples never cross either the organization or the ledger owner. */
export async function listRequestFilings(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner & { learningOwnerId?: string },
) {
	return db
		.select()
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, owner.organizationId),
				sql`json_extract(${learningInteractionEvents.metadata}, '$.ledgerOwnerId') = ${owner.userId}`,
				eq(learningInteractionEvents.surface, FILING_SURFACE),
			),
		)
		.orderBy(
			desc(learningInteractionEvents.occurredAt),
			desc(learningInteractionEvents.id),
		)
		.limit(201);
}

export async function filingWorkspaceBriefs(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner & { learningOwnerId?: string },
) {
	return db
		.select({
			id: osWorkspaces.id,
			name: osWorkspaces.name,
			description: osWorkspaces.description,
			projectId: osWorkspaceProjects.projectId,
		})
		.from(osWorkspaces)
		.leftJoin(
			osWorkspaceProjects,
			and(
				eq(osWorkspaceProjects.organizationId, owner.organizationId),
				eq(osWorkspaceProjects.workspaceId, osWorkspaces.id),
				eq(osWorkspaceProjects.status, "active"),
			),
		)
		.where(
			and(
				eq(osWorkspaces.organizationId, owner.organizationId),
				eq(osWorkspaces.status, "active"),
				sql`(${osWorkspaces.visibility} = 'org' or ${osWorkspaces.ownerUserId} = ${owner.userId} or ${osWorkspaces.ownerUserId} = ${owner.learningOwnerId ?? owner.userId})`,
			),
		)
		.limit(200);
}

export async function filingRecentWork(db: DbQueryClient, orgId: string) {
	return db
		.select({
			id: workItems.id,
			title: workItems.title,
			projectId: workItems.projectId,
			objectiveId: workItems.objectiveId,
		})
		.from(workItems)
		.where(eq(workItems.orgId, orgId))
		.orderBy(desc(workItems.createdAt))
		.limit(100);
}

/** Audit and compare-and-swap move commit together; a stale classifier cannot undo a correction. */
export async function recordRequestFiling(
	db: DbQueryClient,
	input: AgentSessionRequestOwner & {
		row: AgentSessionRequestRow;
		projectId: string | null;
		by: "auto" | "correction";
		confidence: number;
		reason: string;
		now: string;
		actionable?: boolean;
		factoryProposal?: boolean;
		workItemId?: string | null;
		learningOwnerId?: string;
		shareCorrection?: boolean;
	},
) {
	const eventId = crypto.randomUUID();
	const shared =
		input.by === "correction" &&
		input.shareCorrection &&
		input.projectId !== null;
	const filingAt = new Date(
		Math.max(Date.parse(input.now), Date.parse(input.row.updatedAt) + 1),
	).toISOString();
	const match = and(
		eq(agentSessionRequests.organizationId, input.organizationId),
		eq(agentSessionRequests.userId, input.userId),
		eq(agentSessionRequests.id, input.row.id),
		eq(agentSessionRequests.updatedAt, input.row.updatedAt),
		input.row.projectId
			? eq(agentSessionRequests.projectId, input.row.projectId)
			: isNull(agentSessionRequests.projectId),
		input.projectId
			? exists(
					db
						.select({ id: projects.id })
						.from(projects)
						.where(
							and(
								eq(projects.orgId, input.organizationId),
								eq(projects.id, input.projectId),
							),
						),
				)
			: undefined,
	);
	const metadata = {
		ledgerOwnerId: input.userId,
		previousProjectId: input.row.projectId,
		projectId: input.projectId,
		text: input.row.text,
		by: input.by,
		confidence: input.confidence,
		reason: input.reason,
		actionable: input.actionable ?? false,
		factoryProposal: input.factoryProposal ?? false,
		workItemId: input.workItemId ?? null,
	};
	const moveProposal = [
		db
			.update(workItems)
			.set({
				projectId: input.projectId,
				objectiveId: input.projectId
					? sql<
							string | null
						>`(select p.objective_id from projects p where p.org_id = ${input.organizationId} and p.id = ${input.projectId})`
					: null,
				updatedAt: filingAt,
				version: sql`${workItems.version} + 1`,
				admissionSpecRevision: sql`lower(hex(randomblob(16)))`,
			})
			.where(
				and(
					eq(workItems.orgId, input.organizationId),
					eq(workItems.sourceIntentId, `request-filing:${input.row.id}`),
					eq(workItems.disposition, "proposed"),
					sql`json_extract(${workItems.provenance}, '$.source') = 'request-ledger'`,
					sql`changes() = 1`,
				),
			),
		db.insert(workEvents).select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as("id"),
					orgId: workItems.orgId,
					workItemId: workItems.id,
					eventType: sql<string>`'work.specification_updated'`.as("event_type"),
					actorType: sql<"user">`'user'`.as("actor_type"),
					actorId: sql<string>`${input.userId}`.as("actor_id"),
					payload: sql<
						Record<string, string | null>
					>`${JSON.stringify({ requestId: input.row.id, previousProjectId: input.row.projectId, projectId: input.projectId, by: input.by })}`.as(
						"payload",
					),
					occurredAt: sql<string>`${filingAt}`.as("occurred_at"),
				})
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, input.organizationId),
						eq(workItems.sourceIntentId, `request-filing:${input.row.id}`),
						sql`changes() = 1`,
					),
				),
		),
	];
	const [events, rows] = await db.batch([
		db
			.insert(learningInteractionEvents)
			.select(
				db
					.select({
						id: sql<string>`${eventId}`.as("id"),
						organizationId: agentSessionRequests.organizationId,
						actorType: sql<"service">`'service'`.as("actor_type"),
						actorId:
							sql<string>`${input.by === "auto" ? "request-auto-filer" : input.userId}`.as(
								"actor_id",
							),
						clientEventId: sql<string>`${eventId}`.as("client_event_id"),
						signalClass: sql<"quality">`'quality'`.as("signal_class"),
						eventKind: sql<
							"accepted" | "edited"
						>`${input.by === "auto" ? "accepted" : "edited"}`.as("event_kind"),
						scopeKind: sql<
							"personal" | "project"
						>`${shared ? "project" : "personal"}`.as("scope_kind"),
						scopeId:
							sql<string>`${shared ? input.projectId! : (input.learningOwnerId ?? input.userId)}`.as(
								"scope_id",
							),
						issueKey: sql<string>`${`request-filing:${input.row.id}`}`.as(
							"issue_key",
						),
						surface: sql<string>`${FILING_SURFACE}`.as("surface"),
						targetType: sql<string>`'request'`.as("target_type"),
						targetId: agentSessionRequests.id,
						metadata: sql<typeof metadata>`${JSON.stringify(metadata)}`.as(
							"metadata",
						),
						occurredAt: sql<string>`${filingAt}`.as("occurred_at"),
						createdAt: sql<string>`${filingAt}`.as("created_at"),
					})
					.from(agentSessionRequests)
					.where(match),
			)
			.returning(),
		db
			.update(agentSessionRequests)
			.set({ projectId: input.projectId, updatedAt: filingAt })
			.where(and(match, sql`changes() = 1`))
			.returning(),
		...moveProposal,
	]);
	return rows[0] ? { row: rows[0], event: events[0]! } : null;
}

/** Stable per-organization key makes concurrent proposals and retries reuse one container. */
export async function ensureFilingProject(
	db: DbQueryClient,
	input: {
		orgId: string;
		key: string;
		name: string;
		brief: string;
		objectiveId?: string;
		now: string;
	},
) {
	await db
		.insert(projects)
		.values({
			id: crypto.randomUUID(),
			orgId: input.orgId,
			key: input.key,
			name: input.name,
			description: input.brief,
			objectiveId: input.objectiveId,
			metadata: { autoCreated: true, source: FILING_SURFACE },
			createdAt: input.now,
		})
		.onConflictDoNothing({ target: [projects.orgId, projects.key] });
	const [project] = await db
		.select()
		.from(projects)
		.where(and(eq(projects.orgId, input.orgId), eq(projects.key, input.key)))
		.limit(1);
	if (!project) throw new Error("Auto-created project unavailable");
	return project;
}

export async function emptyAutoCreatedProjects(
	db: DbQueryClient,
	orgId: string,
	now: string,
) {
	const cutoff = new Date(Date.parse(now) - 14 * 86400000).toISOString();
	return db
		.select({ id: projects.id, name: projects.name })
		.from(projects)
		.where(
			and(
				eq(projects.orgId, orgId),
				eq(projects.status, "active"),
				sql`json_extract(${projects.metadata}, '$.autoCreated') = 1`,
				sql`${projects.createdAt} <= ${cutoff}`,
				sql`not exists (select 1 from agent_session_requests r where r.organization_id = ${orgId} and r.project_id = ${projects.id} and r.status not in ('done', 'cancelled'))`,
				sql`not exists (select 1 from work_items w where w.org_id = ${orgId} and w.project_id = ${projects.id} and w.disposition not in ('completed', 'cancelled'))`,
				sql`not exists (select 1 from os_workspace_projects p where p.organization_id = ${orgId} and p.project_id = ${projects.id} and p.status = 'active')`,
			),
		)
		.limit(100);
}

export async function listUnfiledRequests(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner & { learningOwnerId?: string },
) {
	return db
		.select()
		.from(agentSessionRequests)
		.where(
			and(
				eq(agentSessionRequests.organizationId, owner.organizationId),
				eq(agentSessionRequests.userId, owner.userId),
				isNull(agentSessionRequests.projectId),
				sql`${agentSessionRequests.status} not in ('done', 'cancelled')`,
			),
		)
		.orderBy(desc(agentSessionRequests.sourceAt))
		.limit(200);
}

/** Cohort rate: this week's auto-filings that were subsequently corrected. */
export async function weeklyFilingDigest(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner & { learningOwnerId?: string },
	now: string,
) {
	const since = new Date(Date.parse(now) - 7 * 86400000).toISOString();
	const [counts] = await db
		.select({
			total: sql<number>`count(*)`.mapWith(Number),
			corrected:
				sql<number>`coalesce(sum(case when exists (select 1 from learning_interaction_events c where c.organization_id = ${owner.organizationId} and json_extract(c.metadata, '$.ledgerOwnerId') = ${owner.userId} and c.surface = ${FILING_SURFACE} and c.event_kind = 'edited' and c.target_id = "learning_interaction_events"."target_id" and c.occurred_at >= "learning_interaction_events"."occurred_at" and c.occurred_at <= ${now}) then 1 else 0 end), 0)`.mapWith(
					Number,
				),
		})
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, owner.organizationId),
				sql`json_extract(${learningInteractionEvents.metadata}, '$.ledgerOwnerId') = ${owner.userId}`,
				eq(learningInteractionEvents.surface, FILING_SURFACE),
				eq(learningInteractionEvents.eventKind, "accepted"),
				sql`${learningInteractionEvents.occurredAt} >= ${since}`,
				sql`${learningInteractionEvents.occurredAt} <= ${now}`,
			),
		);
	const total = counts?.total ?? 0;
	const corrected = counts?.corrected ?? 0;
	return {
		since,
		total,
		corrected,
		correctionRate: total ? corrected / total : null,
	};
}

export async function ensureFilingWorkspace(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner & { learningOwnerId?: string },
	project: { id: string; name: string; description: string | null },
	now: string,
) {
	const id = crypto.randomUUID();
	await db
		.insert(osWorkspaces)
		.values({
			id,
			organizationId: owner.organizationId,
			name: project.name,
			description: project.description,
			visibility: "private",
			ownerUserId: owner.learningOwnerId ?? owner.userId,
			createdByKind: "service",
			createdById: "request-auto-filer",
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing({
			target: [osWorkspaces.organizationId, osWorkspaces.name],
		});
	const [workspace] = await db
		.select({ id: osWorkspaces.id })
		.from(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.organizationId, owner.organizationId),
				eq(osWorkspaces.name, project.name),
				eq(osWorkspaces.ownerUserId, owner.learningOwnerId ?? owner.userId),
			),
		)
		.limit(1);
	if (!workspace)
		throw new Error("Auto-filing workspace name belongs to another owner");
	await db
		.insert(osWorkspaceProjects)
		.values({
			id: crypto.randomUUID(),
			organizationId: owner.organizationId,
			workspaceId: workspace.id,
			projectId: project.id,
			createdByKind: "service",
			createdById: "request-auto-filer",
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing({
			target: [osWorkspaceProjects.workspaceId, osWorkspaceProjects.projectId],
		});
	return workspace.id;
}

/** Durable repair after a filing committed but proposed Work creation was interrupted. */
export async function pendingFilingWork(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner & { learningOwnerId?: string },
) {
	return db
		.select({
			request: agentSessionRequests,
			metadata: learningInteractionEvents.metadata,
		})
		.from(agentSessionRequests)
		.innerJoin(
			learningInteractionEvents,
			and(
				eq(learningInteractionEvents.organizationId, owner.organizationId),
				sql`json_extract(${learningInteractionEvents.metadata}, '$.ledgerOwnerId') = ${owner.userId}`,
				eq(learningInteractionEvents.targetId, agentSessionRequests.id),
				eq(learningInteractionEvents.surface, FILING_SURFACE),
				eq(learningInteractionEvents.eventKind, "accepted"),
			),
		)
		.where(
			and(
				eq(agentSessionRequests.organizationId, owner.organizationId),
				eq(agentSessionRequests.userId, owner.userId),
				sql`${agentSessionRequests.projectId} is not null`,
				sql`${agentSessionRequests.status} not in ('done', 'cancelled')`,
				sql`json_extract(${learningInteractionEvents.metadata}, '$.actionable') = 1`,
				sql`json_extract(${learningInteractionEvents.metadata}, '$.workItemId') is null`,
				sql`not exists (select 1 from work_items w where w.org_id = ${owner.organizationId} and w.source_intent_id = 'request-filing:' || ${agentSessionRequests.id})`,
			),
		)
		.limit(200);
}

export async function pendingFilingLessons(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner & { learningOwnerId?: string },
) {
	return db
		.select()
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, owner.organizationId),
				sql`json_extract(${learningInteractionEvents.metadata}, '$.ledgerOwnerId') = ${owner.userId}`,
				eq(learningInteractionEvents.surface, FILING_SURFACE),
				eq(learningInteractionEvents.eventKind, "edited"),
				sql`not exists (select 1 from learning_improvement_proposals p where p.organization_id = ${owner.organizationId} and p.client_proposal_id = 'filing:' || ${learningInteractionEvents.id})`,
			),
		)
		.limit(50);
}

export async function emptyAutoCreatedWorkspaces(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner & { learningOwnerId?: string },
	now: string,
) {
	const cutoff = new Date(Date.parse(now) - 14 * 86400000).toISOString();
	return db
		.select({ id: osWorkspaces.id, name: osWorkspaces.name })
		.from(osWorkspaces)
		.where(
			and(
				eq(osWorkspaces.organizationId, owner.organizationId),
				eq(osWorkspaces.status, "active"),
				eq(osWorkspaces.createdByKind, "service"),
				eq(osWorkspaces.createdById, "request-auto-filer"),
				eq(osWorkspaces.ownerUserId, owner.learningOwnerId ?? owner.userId),
				sql`${osWorkspaces.createdAt} <= ${cutoff}`,
				sql`not exists (select 1 from os_outputs o where o.organization_id = ${owner.organizationId} and o.workspace_id = ${osWorkspaces.id})`,
				sql`not exists (select 1 from os_gadgets g where g.organization_id = ${owner.organizationId} and g.workspace_id = ${osWorkspaces.id})`,
				sql`not exists (select 1 from os_workspace_resources r where r.organization_id = ${owner.organizationId} and r.workspace_id = ${osWorkspaces.id} and r.status = 'active')`,
				sql`not exists (select 1 from os_workspace_projects p join work_items w on w.org_id = p.organization_id and w.project_id = p.project_id where p.organization_id = ${owner.organizationId} and p.workspace_id = ${osWorkspaces.id} and p.status = 'active' and w.disposition not in ('completed', 'cancelled'))`,
				sql`not exists (select 1 from os_workspace_projects p join agent_session_requests r on r.organization_id = p.organization_id and r.project_id = p.project_id where p.organization_id = ${owner.organizationId} and p.workspace_id = ${osWorkspaces.id} and p.status = 'active' and r.status not in ('done', 'cancelled'))`,
			),
		)
		.limit(100);
}

export async function filingObjectiveBriefs(db: DbQueryClient, orgId: string) {
	return db
		.select({
			id: tediObjectives.id,
			title: tediObjectives.title,
			description: tediObjectives.description,
		})
		.from(tediObjectives)
		.where(
			and(eq(tediObjectives.orgId, orgId), eq(tediObjectives.status, "active")),
		)
		.limit(200);
}

/** Only examples explicitly shared by an opted-in owner teach other members. */
export async function listSharedFilingExamples(
	db: DbQueryClient,
	orgId: string,
) {
	return db
		.select()
		.from(learningInteractionEvents)
		.where(
			and(
				eq(learningInteractionEvents.organizationId, orgId),
				eq(learningInteractionEvents.surface, FILING_SURFACE),
				eq(learningInteractionEvents.eventKind, "edited"),
				eq(learningInteractionEvents.scopeKind, "project"),
			),
		)
		.orderBy(desc(learningInteractionEvents.occurredAt))
		.limit(40);
}

export async function countUnfiledRequests(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner,
) {
	const [row] = await db
		.select({ total: sql<number>`count(*)`.mapWith(Number) })
		.from(agentSessionRequests)
		.where(
			and(
				eq(agentSessionRequests.organizationId, owner.organizationId),
				eq(agentSessionRequests.userId, owner.userId),
				isNull(agentSessionRequests.projectId),
				sql`${agentSessionRequests.status} not in ('done', 'cancelled')`,
			),
		);
	return row?.total ?? 0;
}
