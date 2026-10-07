/**
 * Work Items — principal-typing plumbing for the router: gateway-verified
 * external-agent identity, accountable-principal resolution for the
 * corroboration ledger, and the reserved external-agent metadata stamp.
 */

import { resolveAuthorizedExternalAgentMcpSession } from "@tedix/db/queries/external-agent-identity/mcp-credentials";
import { resolveOwnerHostSession } from "@tedix/db/queries/external-agent-identity/owner-host-sessions";
import { getExternalAgentPrincipalByCredential } from "@tedix/db/queries/external-agent-identity/principals";
import {
	getMemberByCanonicalUserId,
	getMemberByUserId,
} from "@tedix/db/queries/organization-members";
import { getTediById } from "@tedix/db/queries/tedis";
import { type BaseContext, createError, ErrorCodes } from "../orpc";

type ExternalWorkExecutor = {
	type: "external_agent";
	id: string;
	sessionId: string;
};

export async function assertTediAccess(
	context: BaseContext,
	tediId: string,
	orgId: string,
) {
	const tedi = await getTediById(context.db, tediId);
	if (!tedi) {
		throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	}
	if (tedi.organizationId !== orgId) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
	}
	if (tedi.retiredAt !== null) {
		throw createError(ErrorCodes.FORBIDDEN, "Retired tedis cannot mutate Work");
	}
	return tedi;
}

export interface VerifiedExternalAgent {
	executor: ExternalWorkExecutor;
	externalSessionKey: string;
	harness: string;
	clientRecordId: string;
	creditEligible: boolean;
	/**
	 * True for an owner-host session: the identity is asserted by the
	 * authenticated human owner's plugin host, not proven by a machine
	 * credential. Never credit eligible; `clientRecordId` is a marker.
	 */
	ownerBound?: true;
}

/** Stable non-secret client marker for an owner-host session. */
export function ownerHostClientRecordId(sessionId: string): string {
	return `owner-host:${sessionId}`;
}

/**
 * Resolve the calling human's own active owner-host Agent-Session. Shared by
 * Work admission and the edge preflight so both enforce the same predicate:
 * active session, active `owner_user` principal bound to this user's canonical
 * id, same organization.
 */
export async function resolveCallerOwnerHostSession(
	context: BaseContext,
	orgId: string,
	sessionId: string,
) {
	if (context.authType !== "user" || typeof context.user?.sub !== "string") {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Owner-host Agent-Sessions require an authenticated human user",
		);
	}
	const membership = await verifiedActiveUserMembership(
		context,
		orgId,
		"active owner-host",
	);
	const resolved = await resolveOwnerHostSession(context.db, {
		organizationId: orgId,
		userId: membership.userId,
		sessionId,
	});
	if (!resolved) {
		throw createError(
			ErrorCodes.UNAUTHORIZED,
			"Owner-host Agent-Session is not an active session of this user in this organization",
		);
	}
	return resolved;
}

export async function verifiedExternalAgent(
	context: BaseContext,
	orgId: string,
): Promise<VerifiedExternalAgent | null> {
	const supplied = [
		context.externalAgentPrincipalId,
		context.externalAgentSessionId,
		context.externalAgentClientRecordId,
	];
	if (supplied.every((value) => !value)) {
		if (!context.ownerHostSessionId) return null;
		// Defense in depth: withAuth already resolved this session for the
		// forwarded user; re-check it against the Work Item's organization.
		const { principal, session } = await resolveCallerOwnerHostSession(
			context,
			orgId,
			context.ownerHostSessionId,
		);
		return {
			executor: {
				type: "external_agent",
				id: principal.id,
				sessionId: session.id,
			},
			externalSessionKey: session.externalSessionKey,
			harness: session.harness,
			clientRecordId: ownerHostClientRecordId(session.id),
			creditEligible: false,
			ownerBound: true,
		};
	}
	if (context.ownerHostSessionId) {
		throw createError(
			ErrorCodes.UNAUTHORIZED,
			"Conflicting external-agent and owner-host identities",
		);
	}
	if (supplied.some((value) => !value)) {
		throw createError(
			ErrorCodes.UNAUTHORIZED,
			"Incomplete external-agent gateway identity",
		);
	}
	const principalId = context.externalAgentPrincipalId!;
	const sessionId = context.externalAgentSessionId!;
	const clientRecordId = context.externalAgentClientRecordId!;
	const resolved = await resolveAuthorizedExternalAgentMcpSession(context.db, {
		organizationId: orgId,
		principalId,
		sessionId,
		clientRecordId,
		now: new Date().toISOString(),
	});
	if (!resolved) {
		throw createError(
			ErrorCodes.UNAUTHORIZED,
			"External-agent principal, session, or MCP credential is no longer active",
		);
	}
	return {
		executor: { type: "external_agent", id: principalId, sessionId },
		externalSessionKey: resolved.session.externalSessionKey,
		harness: resolved.session.harness,
		clientRecordId,
		creditEligible: resolved.session.creditEligible,
	};
}

export type VerifiedActiveWorkActor =
	| {
			type: "user";
			id: string;
			sessionId?: undefined;
			externalSessionKey?: undefined;
	  }
	| {
			type: "tedi";
			id: string;
			sessionId?: undefined;
			externalSessionKey?: undefined;
	  }
	| {
			type: "external_agent";
			id: string;
			sessionId: string;
			externalSessionKey: string;
	  };

export async function verifiedActiveUserMembership(
	context: BaseContext,
	orgId: string,
	requirement = "active",
) {
	const subject =
		context.authType === "user" && typeof context.user?.sub === "string"
			? context.user.sub.trim()
			: "";
	if (!subject)
		throw createError(
			ErrorCodes.FORBIDDEN,
			`Work mutation requires an authenticated ${requirement} user principal`,
		);
	const membership = context.userId
		? ((await getMemberByCanonicalUserId(context.db, orgId, context.userId)) ??
			(await getMemberByUserId(context.db, orgId, subject)))
		: await getMemberByUserId(context.db, orgId, subject);
	if (membership?.status !== "active" || !membership.userId)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Work mutation requires a canonical active organization user identity",
		);
	return membership as typeof membership & { userId: string };
}

/**
 * Resolve a Work actor only from the authenticated credential and re-check its
 * active org membership/session. Organization API keys and service identities
 * are intentionally excluded from accountable human/agent writes.
 */
export async function verifiedActiveWorkActor(
	context: BaseContext,
	orgId: string,
): Promise<VerifiedActiveWorkActor> {
	const external = await verifiedExternalAgent(context, orgId);
	if (external) {
		return {
			type: "external_agent",
			id: external.executor.id,
			sessionId: external.executor.sessionId,
			externalSessionKey: external.externalSessionKey,
		};
	}
	if (context.tediId) {
		await assertTediAccess(context, context.tediId, orgId);
		return { type: "tedi", id: context.tediId };
	}
	if (context.authType === "user" && typeof context.user?.sub === "string") {
		const membership = await verifiedActiveUserMembership(context, orgId);
		return { type: "user", id: membership.userId };
	}
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Work mutation requires an active user, tedi, or external-agent credential",
	);
}

/**
 * CANONICAL PRINCIPAL ENUMERATION. This is the single place that enumerates
 * every accountable principal type a Work Item write can act as —
 * `user | organization | tedi | external_agent` — and how each is derived from
 * the authenticated context (gateway-verified external agent first, then tedi,
 * then user JWT, then org-scoped API key). Add a new principal type HERE, not
 * at a call site, so the corroboration ledger and every future
 * principal-typed surface stay in agreement.
 */
export async function corroborationPrincipal(
	context: BaseContext,
	orgId: string,
): Promise<{
	type: "user" | "organization" | "tedi" | "external_agent";
	id: string;
	sessionId?: string;
}> {
	const external = await verifiedExternalAgent(context, orgId);
	if (external) {
		if (!external.creditEligible) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				external.ownerBound
					? "Owner-host Agent-Sessions are owner-asserted and cannot create corroboration credit"
					: "Derived external-agent sessions cannot create corroboration credit",
			);
		}
		return {
			type: "external_agent",
			id: external.executor.id,
			sessionId: external.executor.sessionId,
		};
	}
	if (context.tediId) {
		await assertTediAccess(context, context.tediId, orgId);
		return { type: "tedi", id: context.tediId };
	}
	if (context.authType === "user" && typeof context.user?.sub === "string") {
		const membership = await verifiedActiveUserMembership(
			context,
			orgId,
			"active Work principal",
		);
		return { type: "user", id: membership.userId };
	}
	if (context.authType === "apikey") {
		const boundExternal = context.apiKey?.id
			? await getExternalAgentPrincipalByCredential(context.db, {
					organizationId: orgId,
					credentialBindingId: context.apiKey.id,
				})
			: null;
		if (boundExternal) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"An external-agent API key must corroborate through its active immutable MCP session",
			);
		}
		return { type: "organization", id: `organization:${orgId}` };
	}
	throw createError(
		ErrorCodes.FORBIDDEN,
		"An accountable user, organization, tedi, or external-agent principal is required",
	);
}

export interface VerifiedWorkItemCommentAuthor {
	authorType: "user" | "tedi" | "external_agent" | "system";
	authorId: string;
	executor?: ExternalWorkExecutor;
	metadata: Record<string, unknown> | undefined;
}

/**
 * Derive comment authorship exclusively from authenticated context. Callers
 * may retain legacy author fields in the wire schema, but those fields never
 * decide the persisted identity.
 */
export async function verifiedWorkItemCommentAuthor(
	context: BaseContext,
	orgId: string,
	metadata: Record<string, unknown> | undefined,
): Promise<VerifiedWorkItemCommentAuthor> {
	const external = await verifiedExternalAgent(context, orgId);
	if (external) {
		return {
			authorType: "external_agent",
			authorId: external.executor.id,
			executor: external.executor,
			metadata: stampExternalAgentMetadata(external, metadata),
		};
	}
	if (context.tediId) {
		await assertTediAccess(context, context.tediId, orgId);
		return {
			authorType: "tedi",
			authorId: context.tediId,
			metadata,
		};
	}
	if (context.authType === "user" && typeof context.user?.sub === "string") {
		return {
			authorType: "user",
			authorId: context.user.sub,
			metadata,
		};
	}
	if (context.authType === "apikey" && context.apiKey?.id) {
		return {
			authorType: "system",
			authorId: `apikey:${context.apiKey.id}`,
			metadata,
		};
	}
	if (context.serviceAccount?.clientId) {
		return {
			authorType: "system",
			authorId: `service:${context.serviceAccount.clientId}`,
			metadata,
		};
	}
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Authenticated Work Item comment identity is required",
	);
}

/**
 * Reserved metadata keys the platform stamps from gateway-verified identity.
 * Caller-supplied values for these keys are ALWAYS scrubbed before the stamp
 * so an external agent can never spoof its own session attribution.
 */
const EXTERNAL_AGENT_RESERVED_METADATA_KEYS = [
	"agentSession",
	"agentHarness",
	"externalAgentPrincipalId",
	"externalAgentSessionId",
	"externalAgentClientRecordId",
] as const;

/**
 * Scrub the reserved keys from caller metadata, then stamp the verified
 * external-agent identity fields. Single implementation for every
 * external-agent metadata write (comments, attempts, and evidence).
 */
export function stampExternalAgentMetadata(
	external: VerifiedExternalAgent,
	metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const scrubbed = { ...metadata };
	for (const key of EXTERNAL_AGENT_RESERVED_METADATA_KEYS) {
		delete scrubbed[key];
	}
	return {
		...scrubbed,
		agentSession: external.externalSessionKey,
		agentHarness: external.harness,
		externalAgentPrincipalId: external.executor.id,
		externalAgentSessionId: external.executor.sessionId,
		externalAgentClientRecordId: external.clientRecordId,
	};
}
