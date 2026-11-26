import { auditWriteTable, readAuditEventById } from "../audit-delivery";

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { organizationMembers as d1OrganizationMembers } from "../../schema/organization-members";
import { tediApprovalRequests as d1TediApprovalRequests } from "../../schema/approvals";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
	DelegatedApprovalsPolicySchema,
	DelegatedApprovalReceiptSchema,
} from "@tedix/api-contract/schemas/delegated-approvals";
import { delegatedCardAllowed } from "@tedix/api-contract/utils/delegated-approvals";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { prefixedColumns } from "../../utils/select";
import { coreStore, jsonParameter, jsonRead } from "../../core-store/dialect";
import { organizations as d1Organizations } from "../../schema/organizations";
import { externalAgentPrincipals as d1ExternalAgentPrincipals } from "../../schema/external-agent-identity";
import { tedis as d1Tedis } from "../../schema/tedis";
import {
	workInteractions as d1WorkInteractions,
	workInteractionResponses as d1WorkInteractionResponses,
	type WorkInteraction,
} from "../../schema/work-factory";
import {
	interactionAuditTime,
	interactionColumns,
	interactionJsonType,
} from "./interaction-store";
import type { InteractionActor } from "./interactions";

/** Sessions on the same credential are one requester, regardless of session id. */
export async function independentApprovalActor(
	db: DbQueryClient,
	orgId: string,
	requester: Pick<InteractionActor, "type" | "id">,
	decider: Pick<InteractionActor, "type" | "id">,
): Promise<boolean> {
	if (requester.type === decider.type && requester.id === decider.id)
		return false;
	const externalAgentPrincipals = coreTable(db, d1ExternalAgentPrincipals);
	const organizationMembers = coreTable(db, d1OrganizationMembers);
	const credential = async (actor: Pick<InteractionActor, "type" | "id">) => {
		if (actor.type === "external_agent") {
			const [principal] = await db
				.select({
					type: externalAgentPrincipals.credentialBindingType,
					id: externalAgentPrincipals.credentialBindingId,
				})
				.from(externalAgentPrincipals)
				.where(
					and(
						eq(externalAgentPrincipals.organizationId, orgId),
						eq(externalAgentPrincipals.id, actor.id),
					),
				)
				.limit(1);
			return principal ?? null;
		}
		if (actor.type === "user") {
			const [member] = await db
				.select({ id: organizationMembers.userId })
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.organizationId, orgId),
						sql`(${organizationMembers.userId}=${actor.id} OR ${organizationMembers.descopeUserId}=${actor.id})`,
					),
				)
				.limit(1);
			return member?.id ? { type: "owner_user", id: member.id } : null;
		}
		return actor.type === "tedi" ? { type: "tedi", id: actor.id } : null;
	};
	const [from, to] = await Promise.all([
		credential(requester),
		credential(decider),
	]);
	return Boolean(from && to && (from.type !== to.type || from.id !== to.id));
}

/** Identity and policy are read from canonical rows, never a card's actor claims. */
export async function delegatedApprover(
	db: DbQueryClient,
	p: {
		orgId: string;
		ownerId: string;
		actor: InteractionActor;
		requester?: Pick<InteractionActor, "type" | "id">;
	},
) {
	if (
		p.requester &&
		!(await independentApprovalActor(db, p.orgId, p.requester, p.actor))
	)
		return null;
	const organizations = coreTable(db, d1Organizations);
	const organizationMembers = coreTable(db, d1OrganizationMembers);
	const tedis = coreTable(db, d1Tedis);
	const externalAgentPrincipals = coreTable(db, d1ExternalAgentPrincipals);
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
	requester: Pick<InteractionActor, "type" | "id">,
) {
	const organizations = coreTable(db, d1Organizations);
	const tedis = coreTable(db, d1Tedis);
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
			requester,
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
				requester,
			})
		: null;
}

/** Investigation grants no approval authority, so it does not need approval opt-in. */
export async function preferredVerificationDelegate(
	db: DbQueryClient,
	orgId: string,
	ownerId: string,
) {
	const organizations = coreTable(db, d1Organizations);
	const externalAgentPrincipals = coreTable(db, d1ExternalAgentPrincipals);
	const tedis = coreTable(db, d1Tedis);
	const [organization] = await db
		.select({ metadata: organizations.metadata })
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.limit(1);
	const policy = DelegatedApprovalsPolicySchema.safeParse(
		organization?.metadata?.delegatedApprovals,
	).data;
	const lead = policy?.leadAgents[ownerId];
	if (lead) {
		const [agent] = await db
			.select({ id: externalAgentPrincipals.id })
			.from(externalAgentPrincipals)
			.where(
				and(
					eq(externalAgentPrincipals.organizationId, orgId),
					eq(externalAgentPrincipals.id, lead),
					eq(externalAgentPrincipals.status, "active"),
				),
			)
			.limit(1);
		if (agent) return { type: "external_agent" as const, id: agent.id };
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
	return tedi ? { type: "tedi" as const, id: tedi.id } : null;
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
		requester: { type: request.creatorType, id: request.creatorId },
	});
	if (!receipt) return null;
	if (request.targetType === p.actor.type && request.targetId === p.actor.id)
		return prior?.actorId === p.actor.id ? { request, receipt } : null;
	if (request.targetType !== "user") return null;
	const workInteractions = coreTable(db, d1WorkInteractions);
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
		.returning(interactionColumns(db));
	return row ? { request: row, receipt } : null;
}

/** The owner's one list, including decisions made by either kind of delegate. */
export async function listDecidedForYou(
	db: DbQueryClient,
	p: { orgId: string; ownerId: string; limit: number; before?: string },
) {
	const workInteractions = coreTable(db, d1WorkInteractions);
	const workInteractionResponses = coreTable(db, d1WorkInteractionResponses);
	const tediApprovalRequests = coreTable(db, d1TediApprovalRequests);
	const rows = await db
		.select({
			source: sql<"interaction">`'interaction'`.as("decision_source"),
			id: workInteractionResponses.id,
			requestId: sql<string>`${workInteractions.id}`.as("request_id"),
			subject: workInteractions.subject,
			body: workInteractionResponses.body,
			decision:
				sql<string>`coalesce(${jsonRead(db, workInteractionResponses.metadata, ["cardAction"], "text")},'Answered')`.as(
					"decision_choice",
				),
			decidedAt: workInteractionResponses.respondedAt,
			workItemId: workInteractions.workItemId,
			metadata: workInteractions.metadata,
			undoneAt: sql<
				string | null
			>`coalesce(${jsonRead(db, workInteractions.metadata, ["delegatedApprovalUndoneAt"], "text")}, (SELECT ${jsonRead(db, sql`a.metadata`, ["undoneAt"], "text")} FROM audit_events a WHERE a.organization_id=${workInteractions.orgId} AND a.id='delegated-undo:interaction:' || ${workInteractions.orgId} || ':' || ${workInteractions.id}))`.as(
				"undone_at",
			),
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
				eq(workInteractions.delegatedOwnerId, p.ownerId),
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
			>`${jsonRead(db, tediApprovalRequests.payload, ["workItemId"], "text")}`.as(
				"work_item_id",
			),
			metadata: tediApprovalRequests.payload,
			undoneAt: sql<
				string | null
			>`${jsonRead(db, tediApprovalRequests.payload, ["delegatedApprovalUndoneAt"], "text")}`.as(
				"undone_at",
			),
		})
		.from(tediApprovalRequests)
		.where(
			and(
				eq(tediApprovalRequests.orgId, p.orgId),
				sql`(${tediApprovalRequests.status} IN ('approved','rejected') OR (${tediApprovalRequests.status}='cancelled' AND ${interactionJsonType(db, tediApprovalRequests.payload, ["delegatedApprovalUndoneAt"])} IS NOT NULL))`,
				eq(tediApprovalRequests.delegatedOwnerId, p.ownerId),
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
	const tediApprovalRequests = coreTable(db, d1TediApprovalRequests);
	const [row] = await db
		.select(prefixedColumns(tediApprovalRequests, "approval"))
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

/** Withdraw authority without erasing the decision or replaying its effect. */
export async function undoDelegatedApproval(
	db: DbQueryClient,
	p: {
		orgId: string;
		ownerId: string;
		requestId: string;
		source: "interaction" | "runtime";
		now: string;
	},
) {
	const token = crypto.randomUUID();
	const workInteractions = coreTable(db, d1WorkInteractions);
	const tediApprovalRequests = coreTable(db, d1TediApprovalRequests);
	const auditEvents = auditWriteTable(db);
	const table =
		p.source === "interaction" ? workInteractions : tediApprovalRequests;
	const metadata =
		p.source === "interaction"
			? workInteractions.metadata
			: tediApprovalRequests.payload;
	const fence = and(
		eq(table.orgId, p.orgId),
		eq(table.id, p.requestId),
		sql`${jsonRead(db, metadata, ["delegatedApproval", "ownerId"], "text")}=${p.ownerId}`,
	);
	const [prior] = await db
		.select({ metadata })
		.from(table)
		.where(fence)
		.limit(1);
	if (!prior) return false;
	if (typeof prior.metadata.delegatedApprovalUndoneAt === "string") return true;
	const auditId = `delegated-undo:${p.source}:${p.orgId}:${p.requestId}`;
	if (await readAuditEventById(db, p.orgId, auditId)) return true;
	const changed = sql`${jsonRead(db, metadata, ["delegatedApprovalUndoId"], "text")}=${token}`;
	const undonePayload = {
		delegatedApprovalUndoneAt: p.now,
		delegatedApprovalUndoId: token,
	};
	const update =
		p.source === "interaction"
			? db
					.update(workInteractions)
					.set({
						metadata:
							coreStore(db) === "postgres"
								? sql`${metadata} || ${jsonParameter(db, undonePayload)}`
								: sql`json_set(${metadata},'$.delegatedApprovalUndoneAt',${p.now},'$.delegatedApprovalUndoId',${token})`,
					})
					.where(
						and(
							fence,
							eq(workInteractions.status, "resolved"),
							sql`${interactionJsonType(db, metadata, ["delegatedApprovalUndoneAt"])} IS NULL`,
						),
					)
			: db
					.update(tediApprovalRequests)
					.set({
						status: "cancelled",
						payload:
							coreStore(db) === "postgres"
								? sql`${metadata} || ${jsonParameter(db, undonePayload)}`
								: sql`json_set(${metadata},'$.delegatedApprovalUndoneAt',${p.now},'$.delegatedApprovalUndoId',${token})`,
					})
					.where(
						and(
							fence,
							sql`${tediApprovalRequests.status} IN ('approved','rejected')`,
							sql`${interactionJsonType(db, metadata, ["delegatedApprovalUndoneAt"])} IS NULL`,
						),
					);
	await db.batch([
		update,
		db
			.insert(auditEvents)
			.select(
				db
					.select({
						id: sql<string>`${auditId}`.as("id"),
						organizationId: table.orgId,
						actorId: sql<string>`${p.ownerId}`.as("actor_id"),
						actorType: sql<string>`'user'`.as("actor_type"),
						action: sql<string>`'delegated_approval.undone'`.as("action"),
						resourceType:
							sql<string>`${p.source === "interaction" ? "work_interaction" : "approval_request"}`.as(
								"resource_type",
							),
						resourceId: table.id,
						metadata: sql<
							Record<string, JsonValue>
						>`${jsonParameter(db, { source: p.source, receipt: prior.metadata.delegatedApproval ?? null, completedEffectsRetained: true, undoneAt: p.now })}`.as(
							"metadata",
						),
						timestamp: sql<Date>`${interactionAuditTime(db, p.now)}`.as(
							"timestamp",
						),
					})
					.from(table)
					.where(
						and(
							fence,
							p.source === "interaction"
								? eq(workInteractions.status, "resolved")
								: changed,
						),
					),
			)
			.onConflictDoNothing(),
	]);
	const record = await readAuditEventById(db, p.orgId, auditId);
	return Boolean(record);
}
