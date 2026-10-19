import {
	memberEditableWorkFields,
	WorkSpecificationContributorsSchema,
} from "@tedix/api-contract/schemas/work-specification-policy";
import { getProjectByIdForOrganization } from "@tedix/db/queries/projects";
import { isWorkItemCreator } from "@tedix/db/queries/work-items/specification-access";
import type { WorkItem } from "@tedix/db/schema/work-items";
import { createError, ErrorCodes, type BaseContext } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import { verifiedActiveUserMembership } from "../work-items-principal";
import { workItemStewardActor } from "./policy-helpers";

export async function workItemSpecificationActor(
	context: BaseContext,
	item: WorkItem,
	input: Record<string, unknown>,
) {
	if (
		context.authType !== "user" ||
		context.ownerHostSessionId ||
		context.externalAgentPrincipalId ||
		context.externalAgentSessionId ||
		context.externalAgentClientRecordId
	)
		return workItemStewardActor(context, item, "specification");
	if (item.orgId !== requireOrgId(context))
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this Work Item");
	const membership = await verifiedActiveUserMembership(context, item.orgId);
	const actor = { type: "user" as const, id: membership.userId };
	if (membership.role === "owner" || membership.role === "admin") return actor;
	if (membership.role !== "member")
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Specification edits require a member role",
		);
	const allowed = new Set([
		"id",
		"expectedWorkItemVersion",
		...memberEditableWorkFields,
	]);
	if (
		Object.entries(input).some(
			([key, value]) => value !== undefined && !allowed.has(key),
		)
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Members may edit only title, description and priority; governance fields remain owner/admin controlled",
		);
	if (
		item.accountableOwnerType === "user" &&
		item.accountableOwnerId === actor.id
	)
		return actor;
	if (
		await isWorkItemCreator(context.db, {
			orgId: item.orgId,
			workItemId: item.id,
			userId: actor.id,
		})
	)
		return actor;
	const project = item.projectId
		? await getProjectByIdForOrganization(
				context.db,
				item.orgId,
				item.projectId,
			)
		: undefined;
	const grant = WorkSpecificationContributorsSchema.safeParse(
		project?.metadata?.workSpecificationContributors,
	);
	if (
		grant.success &&
		project?.status === "active" &&
		grant.data.userIds.includes(actor.id)
	)
		return actor;
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Specification edits require the creator, assignee or a granted project contributor",
	);
}

export async function assertSpecificationContributorGrant(
	context: BaseContext,
	orgId: string,
	existing: unknown,
	incoming: unknown,
) {
	if (
		incoming === undefined ||
		JSON.stringify(incoming) === JSON.stringify(existing)
	)
		return;
	const membership = await verifiedActiveUserMembership(
		context,
		orgId,
		"owner/admin",
	);
	if (membership.role !== "owner" && membership.role !== "admin")
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Project contributor grants require an active owner/admin",
		);
	if (
		incoming !== null &&
		!WorkSpecificationContributorsSchema.safeParse(incoming).success
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Invalid specification contributor grant",
		);
}
