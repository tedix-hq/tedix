import {
	canonicalPartyKey,
	resolveCanonicalWorkParties,
} from "@tedix/db/queries/external-agent-identity/canonical-party";
import { getExternalAgentPrincipal } from "@tedix/db/queries/external-agent-identity/principals";
import {
	getMemberByCanonicalUserId,
	getMemberByUserId,
} from "@tedix/db/queries/organization-members";
import { createError, ErrorCodes, type BaseContext } from "../../orpc";
import {
	assertTediAccess,
	verifiedActiveWorkActor,
	verifiedExternalAgent,
} from "../work-items-principal";

/**
 * Who answers for Work created without a named owner. A person who creates
 * Work directly answers for it. Work an external agent creates is answered
 * for by the person that agent acts for, or the person who registered it on
 * their own machine, while they are an active contributing member. Acceptance refuses Work without an accountable owner,
 * so without this default such Work could not be accepted. Work a tedi
 * proposes (Home included) still names nobody: the member who accepts it
 * answers.
 */
export async function defaultAccountableOwner(
	context: BaseContext,
	orgId: string,
	creator: { type: string; id: string } | undefined,
): Promise<{ type: "user"; id: string } | undefined> {
	if (context.authType === "user" && creator?.type === "user")
		return { type: "user", id: creator.id };
	const agent =
		creator?.type === "external_agent"
			? creator
			: context.authType === "service-binding" &&
				  context.externalAgentPrincipalId
				? (await verifiedExternalAgent(context, orgId))?.executor
				: undefined;
	if (!agent) return undefined;
	const party = { type: "external_agent", id: agent.id };
	const represented = canonicalPartyKey(
		await resolveCanonicalWorkParties(context.db, {
			organizationId: orgId,
			parties: [party],
		}),
		party,
	);
	let userId = represented.startsWith("user:")
		? represented.slice("user:".length)
		: undefined;
	if (!userId) {
		// An agent a person registered on their own machine (`tedix agent`)
		// names nobody it represents; that person answers for what it files.
		// Workload and API-key agents without a represented person name nobody.
		const principal = await getExternalAgentPrincipal(context.db, {
			organizationId: orgId,
			principalId: agent.id,
		});
		if (
			principal?.credentialBindingType === "aih_m2m" &&
			principal.createdByType === "user"
		)
			userId = principal.createdById;
	}
	if (!userId) return undefined;
	const member =
		(await getMemberByCanonicalUserId(context.db, orgId, userId)) ??
		(await getMemberByUserId(context.db, orgId, userId));
	return member?.status === "active" &&
		member.userId &&
		["owner", "admin", "member"].includes(member.role)
		? { type: "user", id: member.userId }
		: undefined;
}

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
