import type {
	PersonalAgentContribution,
	PersonalAgentEnrollment,
	PersonalAgentFinding,
} from "@tedix/api-contract/schemas/personal-agent-inbound";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../query-client";
import { projects } from "../schema/projects";
import { userConfigs } from "../schema/user-configs";
import { workEvents, workItems } from "../schema/work-items";
import { getWorkItemBySourceIntentId } from "./work-items/crud";

export const PERSONAL_AGENT_NAMESPACE = "personal-agent-inbound.v1";
export function personalAgentConfigKey(orgId: string, id: string) {
	return `${orgId}:${id}`;
}

/** The config revision fences revocation and the unique Work source intent fences retries. */
export async function capturePersonalAgentFinding(
	db: DbQueryClient,
	input: {
		enrollment: PersonalAgentEnrollment;
		revision: number;
		finding: PersonalAgentFinding;
		contribution: PersonalAgentContribution;
		sourceIntentId: string;
	},
) {
	const { enrollment: e, finding: f, contribution: c } = input;
	const id = crypto.randomUUID();
	const provenance = JSON.stringify({ personalAgentContribution: c });
	const cfg = alias(userConfigs, "cfg");
	const p = alias(projects, "p");
	await db.batch([
		db
			.insert(workItems)
			.select(
				db
					.select({
						id: sql<string>`${id}`.as("id"),
						orgId: sql<string>`${e.orgId}`.as("org_id"),
						title: sql<string>`${f.title}`.as("title"),
						description: sql<string>`${f.body}`.as("description"),
						workKind: sql<"research">`'research'`.as("work_kind"),
						disposition: sql<"proposed">`'proposed'`.as("disposition"),
						riskLevel: sql<"low">`'low'`.as("risk_level"),
						accountableOwnerType: sql<"user">`'user'`.as(
							"accountable_owner_type",
						),
						accountableOwnerId: sql<string>`${e.representedUserId}`.as(
							"accountable_owner_id",
						),
						projectId: p.id,
						objectiveId: p.objectiveId,
						workClass: sql<"objective">`'objective'`.as("work_class"),
						sourceIntentId: sql<string>`${input.sourceIntentId}`.as(
							"source_intent_id",
						),
						provenance: sql<Record<string, JsonValue>>`${provenance}`.as(
							"provenance",
						),
						metadata: sql<Record<string, JsonValue>>`'{}'`.as("metadata"),
						createdAt: sql<string>`${c.capturedAt}`.as("created_at"),
					})
					.from(cfg)
					.innerJoin(p, and(eq(p.id, e.projectId), eq(p.orgId, e.orgId)))
					.where(
						and(
							eq(cfg.userId, e.representedUserId),
							eq(cfg.namespace, PERSONAL_AGENT_NAMESPACE),
							eq(cfg.key, personalAgentConfigKey(e.orgId, e.id)),
							eq(cfg.revision, input.revision),
							sql`json_extract(${cfg.value}, '$.active') = 1`,
							eq(p.status, "active"),
							isNotNull(p.objectiveId),
						),
					),
			)
			.onConflictDoNothing({
				target: [workItems.orgId, workItems.sourceIntentId],
			}),
		db.insert(workEvents).select(
			db
				.select({
					id: sql<string>`${crypto.randomUUID()}`.as("id"),
					orgId: sql<string>`${e.orgId}`.as("org_id"),
					workItemId: workItems.id,
					eventType: sql<string>`'personal_agent.finding_received'`.as(
						"event_type",
					),
					actorType: sql<"system">`'system'`.as("actor_type"),
					actorId: sql<string>`${`personal-agent:${e.id}`}`.as("actor_id"),
					payload: sql<
						Record<string, JsonValue>
					>`${JSON.stringify({ summary: f.title, personalAgentContribution: c })}`.as(
						"payload",
					),
					occurredAt: sql<string>`${c.capturedAt}`.as("occurred_at"),
				})
				.from(workItems)
				.where(and(eq(workItems.id, id), eq(workItems.orgId, e.orgId))),
		),
	]);
	const work = await getWorkItemBySourceIntentId(db, {
		orgId: e.orgId,
		sourceIntentId: input.sourceIntentId,
	});
	if (!work) return null;
	return { work, duplicate: work.id !== id };
}
