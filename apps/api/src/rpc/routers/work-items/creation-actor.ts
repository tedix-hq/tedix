import {
	getMemberByCanonicalUserId,
	getMemberByUserId,
} from "@tedix/db/queries/organization-members";
import { createError, ErrorCodes, type BaseContext } from "../../orpc";
import {
	assertTediAccess,
	verifiedActiveWorkActor,
} from "../work-items-principal";

/** Attribute a Home-requested creation without changing its service authorization. */
export async function workItemCreationActor(
	context: BaseContext,
	orgId: string,
) {
	if (context.authType === "user")
		return verifiedActiveWorkActor(context, orgId);
	if (
		context.authType !== "service-binding" ||
		context.serviceBindingPrincipal !== "mcp-edge" ||
		context.headers.get("X-Tedix-Kernel") !== "true" ||
		context.externalAgentPrincipalId ||
		context.externalAgentSessionId ||
		context.externalAgentClientRecordId ||
		context.ownerHostSessionId
	)
		return undefined;
	const subject = context.headers.get("X-Tedix-Acting-User")?.trim();
	if (!subject) return undefined;
	if (context.descopeUserId && context.descopeUserId !== subject)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Conflicting Home creator identity",
		);
	// Home uses the primary worker's scopes but keeps the requesting member
	// distinct. Check the bound worker without promoting it to user auth.
	if (context.tediId) await assertTediAccess(context, context.tediId, orgId);
	const member =
		(await getMemberByCanonicalUserId(context.db, orgId, subject)) ??
		(await getMemberByUserId(context.db, orgId, subject));
	if (
		member?.status !== "active" ||
		!member.userId ||
		!["owner", "admin", "member"].includes(member.role)
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Home Work creation requires an active contributing member",
		);
	return { type: "user" as const, id: member.userId };
}
