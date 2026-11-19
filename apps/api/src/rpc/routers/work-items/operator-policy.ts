import { WorkOperatorsSchema } from "@tedix/api-contract/schemas/work-specification-policy";
import { getProjectByIdForOrganization } from "@tedix/db/queries/projects";
import type { Project } from "@tedix/db/schema/projects";
import type { WorkItem } from "@tedix/db/schema/work-items";
import { createError, ErrorCodes, type BaseContext } from "../../orpc";
import { requireOrgId } from "../../org-scope";
import {
	verifiedActiveUserMembership,
	verifiedActiveWorkActor,
} from "../work-items-principal";

export async function workItemOperatorAuthor(
	context: BaseContext,
	item: WorkItem,
	action: "acceptance" | "completion" | "cancellation",
	readProject?: Project | null,
): Promise<string> {
	if (item.orgId !== requireOrgId(context))
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this Work Item");
	const membership = await verifiedActiveUserMembership(context, item.orgId);
	if (membership.role === "owner" || membership.role === "admin")
		return membership.userId;
	const project =
		membership.role === "member" && item.projectId
			? readProject === undefined
				? await getProjectByIdForOrganization(
						context.db,
						item.orgId,
						item.projectId,
					)
				: readProject
			: undefined;
	const grant = WorkOperatorsSchema.safeParse(project?.metadata?.workOperators);
	if (
		project?.status === "active" &&
		project.id === item.projectId &&
		project.orgId === item.orgId &&
		grant.success &&
		grant.data.userIds.includes(membership.userId) &&
		grant.data.actions.includes(action)
	)
		return membership.userId;
	throw createError(
		ErrorCodes.FORBIDDEN,
		`Work Item ${action} requires an owner/admin or a delegated project member operator`,
	);
}

/** Advisory permission for the signed-in person's Work detail page. */
export async function canShowWorkItemCompletion(
	context: BaseContext,
	item: WorkItem,
	project: Project | null,
): Promise<boolean> {
	if (
		item.disposition !== "accepted" ||
		context.authType !== "user" ||
		context.tediId ||
		context.ownerHostSessionId ||
		context.externalAgentPrincipalId ||
		context.externalAgentSessionId ||
		context.externalAgentClientRecordId
	)
		return false;
	try {
		await workItemOperatorAuthor(context, item, "completion", project);
		return true;
	} catch {
		return false;
	}
}

export async function assertWorkOperatorGrant(
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
	const actor = await verifiedActiveWorkActor(context, orgId);
	if (actor.type !== "user")
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Work operator delegation requires a human organization owner",
		);
	const membership = await verifiedActiveUserMembership(context, orgId);
	if (membership.role !== "owner")
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Work operator delegation requires an active organization owner",
		);
	if (incoming !== null && !WorkOperatorsSchema.safeParse(incoming).success)
		throw createError(ErrorCodes.BAD_REQUEST, "Invalid Work operator grant");
}
