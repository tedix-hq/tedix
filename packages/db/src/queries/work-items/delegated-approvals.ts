import { organizationMembers } from "../../schema/organization-members";
import {
	tediApprovalRequests,
	approvalRequestStoredColumns,
} from "../../schema/approvals";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
	DelegatedApprovalsPolicySchema,
	DelegatedApprovalReceiptSchema,
} from "@tedix/api-contract/schemas/delegated-approvals";
import { delegatedCardAllowed } from "@tedix/api-contract/utils/delegated-approvals";
import type { DbQueryClient } from "../../query-client";
import { organizations } from "../../schema/organizations";
import { externalAgentPrincipals } from "../../schema/external-agent-identity";
import { tedis } from "../../schema/tedis";
import {
	workInteractions,
	workInteractionResponses,
	type WorkInteraction,
} from "../../schema/work-factory";
import type { InteractionActor } from "./interactions";

/** Identity and policy are read from canonical rows, never a card's actor claims. */
export async function delegatedApprover(
	db: DbQueryClient,
	p: { orgId: string; ownerId: string; actor: InteractionActor },
) {
	const [organization] = await db
		.select({ metadata: organizations.metadata })
		.from(organizations)
		.where(eq(organizations.id, p.orgId))
		.limit(1);
	const policy = DelegatedApprovalsPolicySchema.safeParse(
		organization?.metadata?.delegatedApprovals,
	).data;
	if (!policy?.enabled) return null;
	const [owner] = await db
		.select({ id: organizationMembers.id })
		.from(organizationMembers)
		.where(
			and(
				eq(organizationMembers.organizationId, p.orgId),
				eq(organizationMembers.userId, p.ownerId),
				eq(organizationMembers.status, "active"),
			),
		)
		.limit(1);
	if (!owner) return null;
	if (p.actor.type === "tedi") {
		const [tedi] = await db
			.select({
				id: tedis.id,
				name: tedis.name,
				displayName: tedis.displayName,
			})
			.from(tedis)
			.where(
				and(
					eq(tedis.organizationId, p.orgId),
					eq(tedis.id, p.actor.id),
					eq(tedis.ownerUserId, p.ownerId),
					eq(tedis.status, "active"),
					isNull(tedis.retiredAt),
				),
			)
			.limit(1);
		return tedi
			? {
					ownerId: p.ownerId,
					actorType: "tedi" as const,
					actorId: tedi.id,
					actorName: tedi.displayName ?? tedi.name,
					reason:
						"Organization policy delegates reversible internal approvals to the owner's own tedi.",
				}
			: null;
	}
	if (
		p.actor.type !== "external_agent" ||
		policy.leadAgents[p.ownerId] !== p.actor.id
	)
		return null;
	const [agent] = await db
		.select({
			id: externalAgentPrincipals.id,
			name: externalAgentPrincipals.displayName,
		})
		.from(externalAgentPrincipals)
		.where(
			and(
				eq(externalAgentPrincipals.organizationId, p.orgId),
				eq(externalAgentPrincipals.id, p.actor.id),
				eq(externalAgentPrincipals.status, "active"),
			),
		)
		.limit(1);
	return agent
		? {
				ownerId: p.ownerId,
				actorType: "external_agent" as const,
				actorId: agent.id,
				actorName: agent.name,
				reason:
					"Organization policy delegates reversible internal approvals to the owner's designated lead agent.",
			}
		: null;
}

/** A configured lead gets first look; the owner's own active tedi is the fallback. */
export async function preferredApprovalDelegate(
	db: DbQueryClient,
	orgId: string,
	ownerId: string,
) {
	const [organization] = await db
		.select({ metadata: organizations.metadata })
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.limit(1);
	const policy = DelegatedApprovalsPolicySchema.safeParse(
		organization?.metadata?.delegatedApprovals,
	).data;
	if (!policy?.enabled) return null;
	const lead = policy.leadAgents[ownerId];
	if (lead) {
		const receipt = await delegatedApprover(db, {
			orgId,
			ownerId,
			actor: { type: "external_agent", id: lead },
		});
		if (receipt) return receipt;
	}
	const [tedi] = await db
		.select({ id: tedis.id })
		.from(tedis)
		.where(
			and(
				eq(tedis.organizationId, orgId),
				eq(tedis.ownerUserId, ownerId),
				eq(tedis.status, "active"),
				isNull(tedis.retiredAt),
			),
		)
		.orderBy(tedis.id)
		.limit(1);
	return tedi
		? delegatedApprover(db, {
				orgId,
				ownerId,
				actor: { type: "tedi", id: tedi.id },
			})
		: null;
}

/** Retargeting preserves the ordinary response trigger and the actual decider. */
export async function claimDelegatedApproval(
	db: DbQueryClient,
	p: {
		request: WorkInteraction;
		actor: InteractionActor;
		expectedVersion: number;
		now: string;
		cardAction?: string;
	},
) {
	const request = p.request;
	if (
		request.version !== p.expectedVersion ||
		request.status !== "open" ||
		(request.expiresAt && request.expiresAt <= p.now)
	)
		return null;
	const prior = DelegatedApprovalReceiptSchema.safeParse(
		request.metadata.delegatedApproval,
	).data;
	const ownerId =
		request.targetType === "user" ? request.targetId : prior?.ownerId;
	if (!ownerId || !delegatedCardAllowed(request, p.cardAction)) return null;
	const receipt = await delegatedApprover(db, {
		orgId: request.orgId,
		ownerId,
		actor: p.actor,
	});
	if (!receipt) return null;
	if (request.targetType === p.actor.type && request.targetId === p.actor.id)
		return prior?.actorId === p.actor.id ? { request, receipt } : null;
	if (request.targetType !== "user") return null;
	const [row] = await db
		.update(workInteractions)
		.set({
			targetType: receipt.actorType,
			targetId: receipt.actorId,
			metadata: { ...request.metadata, delegatedApproval: receipt },
			version: sql`${workInteractions.version}+1`,
		})
		.where(
			and(
				eq(workInteractions.orgId, request.orgId),
				eq(workInteractions.id, request.id),
				eq(workInteractions.version, p.expectedVersion),
				eq(workInteractions.targetType, "user"),
				eq(workInteractions.targetId, ownerId),
				eq(workInteractions.status, "open"),
				sql`(${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${p.now})`,
			),
		)
		.returning();
	return row ? { request: row, receipt } : null;
}

/** The owner's one list, including decisions made by either kind of delegate. */
export async function listDecidedForYou(
	db: DbQueryClient,
	p: { orgId: string; ownerId: string; limit: number; before?: string },
) {
	const rows = await db
		.select({
			source: sql<"interaction">`'interaction'`.as("decision_source"),
			id: workInteractionResponses.id,
			requestId: sql<string>`${workInteractions.id}`.as("request_id"),
			subject: workInteractions.subject,
			body: workInteractionResponses.body,
			decision:
				sql<string>`coalesce(json_extract(${workInteractionResponses.metadata},'$.cardAction'),'Answered')`.as(
					"decision_choice",
				),
			decidedAt: workInteractionResponses.respondedAt,
			workItemId: workInteractions.workItemId,
			metadata: workInteractions.metadata,
		})
		.from(workInteractions)
		.innerJoin(
			workInteractionResponses,
			and(
				eq(workInteractionResponses.orgId, workInteractions.orgId),
				eq(workInteractionResponses.interactionId, workInteractions.id),
				eq(workInteractionResponses.resolvesRequest, true),
				eq(workInteractionResponses.responderType, workInteractions.targetType),
				eq(workInteractionResponses.responderId, workInteractions.targetId),
			),
		)
		.where(
			and(
				eq(workInteractions.orgId, p.orgId),
				sql`json_extract(${workInteractions.metadata},'$.delegatedApproval.ownerId')=${p.ownerId}`,
				p.before
					? sql`${workInteractionResponses.respondedAt} || ':' || ${workInteractionResponses.id} < ${p.before}`
					: undefined,
			),
		)
		.orderBy(
			desc(workInteractionResponses.respondedAt),
			desc(workInteractionResponses.id),
		)
		.limit(p.limit + 1);
	const runtime = await db
		.select({
			source: sql<"runtime">`'runtime'`.as("decision_source"),
			id: sql<string>`'runtime:' || ${tediApprovalRequests.id}`.as(
				"decision_id",
			),
			requestId: tediApprovalRequests.id,
			subject: tediApprovalRequests.description,
			body: sql<string>`coalesce(${tediApprovalRequests.resolution},'No reason recorded')`.as(
				"decision_reason",
			),
			decision: tediApprovalRequests.status,
			decidedAt: sql<string>`${tediApprovalRequests.resolvedAt}`.as(
				"decided_at",
			),
			workItemId: sql<
				string | null
			>`json_extract(${tediApprovalRequests.payload},'$.workItemId')`.as(
				"work_item_id",
			),
			metadata: tediApprovalRequests.payload,
		})
		.from(tediApprovalRequests)
		.where(
			and(
				eq(tediApprovalRequests.orgId, p.orgId),
				sql`${tediApprovalRequests.status} IN ('approved','rejected')`,
				sql`json_extract(${tediApprovalRequests.payload},'$.delegatedApproval.ownerId')=${p.ownerId}`,
				p.before
					? sql`${tediApprovalRequests.resolvedAt} || ':runtime:' || ${tediApprovalRequests.id} < ${p.before}`
					: undefined,
			),
		)
		.orderBy(
			desc(tediApprovalRequests.resolvedAt),
			desc(tediApprovalRequests.id),
		)
		.limit(p.limit + 1);
	const combined = [...rows, ...runtime].sort((a, b) =>
		`${b.decidedAt}:${b.id}`.localeCompare(`${a.decidedAt}:${a.id}`),
	);
	const page = combined.slice(0, p.limit);
	return {
		data: page.flatMap(({ metadata, body, ...row }) => {
			const receipt = DelegatedApprovalReceiptSchema.safeParse(
				metadata.delegatedApproval,
			).data;
			return receipt ? [{ ...row, receipt: { ...receipt, reason: body } }] : [];
		}),
		nextBefore:
			combined.length > p.limit && page.length
				? `${page.at(-1)!.decidedAt}:${page.at(-1)!.id}`
				: null,
	};
}

export async function getDelegatedRuntimeApproval(
	db: DbQueryClient,
	orgId: string,
	id: string,
) {
	const [row] = await db
		.select(approvalRequestStoredColumns)
		.from(tediApprovalRequests)
		.where(
			and(
				eq(tediApprovalRequests.orgId, orgId),
				eq(tediApprovalRequests.id, id),
			),
		)
		.limit(1);
	return row ?? null;
}
