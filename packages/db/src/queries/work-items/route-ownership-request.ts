import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { organizationMembers } from "../../schema/organization-members";
import {
	workInteractions as d1WorkInteractions,
	workInteractionStoredColumns,
} from "../../schema/work-factory";
import { selectedStoredColumns } from "./factory-state";
import { requireWorkItem, WorkControlError } from "./factory-validation";
import { getWorkInteraction, type InteractionActor } from "./interactions";

export async function routeWorkOwnershipRequest(
	db: DbQueryClient,
	input: {
		orgId: string;
		requestId: string;
		expectedRequestVersion: number;
		actor: InteractionActor;
		now: string;
	},
) {
	const { orgId, requestId, actor, now } = input;
	const req = await getWorkInteraction(db, { orgId, interactionId: requestId });
	if (!req || req.kind !== "coordination" || !req.workItemId)
		throw new WorkControlError(
			"NOT_FOUND",
			"Workspace coordination request not found",
		);
	const work = await requireWorkItem(db, orgId, req.workItemId);
	const receipt = req.metadata.ownershipRoute;
	const previousSteward =
		receipt && typeof receipt === "object" && !Array.isArray(receipt)
			? receipt.fromTediId
			: null;
	const requester =
		actor.type === req.creatorType &&
		actor.id === req.creatorId &&
		(actor.type !== "external_agent" ||
			(req.creatorSessionId === (actor.sessionId ?? null) &&
				req.creatorExternalSessionKey === (actor.externalSessionKey ?? null)));
	if (
		!requester &&
		!(
			actor.type === "tedi" &&
			actor.id === work.stewardId &&
			work.stewardType === "tedi" &&
			((req.targetType === "tedi" && req.targetId === actor.id) ||
				(req.targetType === "user" && previousSteward === actor.id))
		)
	)
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"Only the requester or the addressed steward can send this request",
		);
	if (
		work.disposition !== "proposed" ||
		work.accountableOwnerId ||
		req.status !== "open" ||
		(req.expiresAt && req.expiresAt <= now)
	)
		throw new WorkControlError(
			"CONFLICT",
			"This request no longer needs a first owner",
		);
	const alreadyRouted =
		req.targetType === "user" && !!req.metadata.ownershipRoute;
	if (
		!alreadyRouted &&
		(req.targetType !== "tedi" ||
			work.stewardType !== "tedi" ||
			work.stewardId !== req.targetId ||
			req.version !== input.expectedRequestVersion)
	)
		throw new WorkControlError(
			"CONFLICT",
			"Read the current request addressed to the Work steward",
		);
	const members = coreTable(db, organizationMembers);
	const workInteractions = coreTable(db, d1WorkInteractions);
	const [recipient] = await db
		.select({ id: members.userId, name: members.name, role: members.role })
		.from(members)
		.where(
			and(
				eq(members.organizationId, orgId),
				eq(members.kind, "human"),
				eq(members.status, "active"),
				isNotNull(members.userId),
				inArray(members.role, ["owner", "admin"]),
				alreadyRouted ? eq(members.userId, req.targetId!) : undefined,
			),
		)
		.orderBy(
			sql`case when ${members.role}='owner' then 0 else 1 end`,
			asc(members.userId),
		)
		.limit(1);
	if (!recipient?.id)
		throw new WorkControlError(
			"NOT_ELIGIBLE",
			"No eligible organization owner or admin was found",
		);
	if (alreadyRouted) return req;
	const [routed] = await db
		.update(workInteractions)
		.set({
			targetType: "user",
			targetId: recipient.id,
			version: req.version + 1,
			metadata: {
				...req.metadata,
				ownershipRoute: {
					fromTediId: req.targetId,
					recipientId: recipient.id,
					recipientName: recipient.name,
					recipientRole: recipient.role,
					routedByType: actor.type,
					routedById: actor.id,
					routedAt: now,
					workLink: `/work/items/${work.id}`,
					nextAction: "Choose the first accountable owner for this proposal.",
				},
			},
		})
		.where(
			and(
				eq(workInteractions.orgId, orgId),
				eq(workInteractions.id, req.id),
				eq(workInteractions.version, req.version),
				eq(workInteractions.status, "open"),
				eq(workInteractions.targetType, "tedi"),
				eq(workInteractions.targetId, req.targetId!),
			),
		)
		.returning(
			selectedStoredColumns(
				db,
				d1WorkInteractions,
				workInteractionStoredColumns,
			),
		);
	if (!routed)
		throw new WorkControlError(
			"CONFLICT",
			"The request changed. Read it again.",
		);
	return routed;
}
