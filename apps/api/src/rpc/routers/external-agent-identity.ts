import { implement, ORPCError } from "@orpc/server";
import { externalAgentIdentityContract } from "@tedix/api-contract/contracts/external-agent-identity";
import { parseTedixMcpAudience } from "@tedix/auth/aih-audiences";
import {
	createDescopeMcpServerClient,
	deleteDescopeMcpServerClient,
	deleteDescopeMcpServerClients,
	exchangeAihClientCredentials,
	getDescopeMcpServerClientSecret,
	loadDescopeMcpServer,
	searchDescopeMcpServerClients,
	type McpServerApprovedScopes,
} from "@tedix/auth/aih-client";
import { descopeIssuer } from "@tedix/auth/principal-identity";
import { DESCOPE_MANAGEMENT_BASE_URL } from "@tedix/auth/types";
import { extractMcpApprovedScopeNames } from "../../services/descope-mcp-server-reconcile";
import {
	GITHUB_ACTIONS_OIDC_ISSUER,
	issueExternalAgentWorkloadGrant,
	resolveFederatedWorkloadScopes,
	verifyExternalAgentWorkloadGrant,
	verifyGithubActionsWorkloadToken,
	WorkloadIdentityError,
} from "@tedix/auth/workload-identity";
import { getApiKeyById } from "@tedix/db/queries/api-keys";
import { getAppMetadataJson } from "@tedix/db/queries/app-records";
import { getAppBySlugForOrg } from "@tedix/db/queries/apps";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { recordExternalAgentAttribution } from "@tedix/db/queries/external-agent-identity/attribution";
import { getExternalAgentContextualReputation } from "@tedix/db/queries/external-agent-identity/contextual-reputation";
import {
	endExternalAgentSession,
	listStaleExternalAgentKnowledgeSessions,
	recordExternalAgentKnowledgeCheckpoint,
	recordExternalAgentKnowledgeDisposition,
} from "@tedix/db/queries/external-agent-identity/knowledge-lifecycle";
import {
	acquireExternalAgentMcpIssuanceLease,
	listActiveExternalAgentMcpCredentials,
	listActiveExternalAgentMcpCredentialsForSession,
	refreshExternalAgentMcpCredentialUnderLease,
	recordExternalAgentMcpCredentialUnderLease,
	releaseExternalAgentMcpIssuanceLease,
	resolveAuthorizedExternalAgentMcpSession,
	revokeExternalAgentMcpCredential,
} from "@tedix/db/queries/external-agent-identity/mcp-credentials";
import { recordVerifiedExternalAgentMcpExecution } from "@tedix/db/queries/external-agent-identity/mcp-executions";
import {
	getOwnerUserExternalAgentPrincipal,
	OWNER_USER_BINDING_TYPE,
} from "@tedix/db/queries/external-agent-identity/owner-host-sessions";
import {
	createExternalAgentPrincipal,
	ExternalAgentIdentityError,
	getExternalAgentPrincipal,
	getExternalAgentPrincipalById,
	getExternalAgentPrincipalByCredential,
	listExternalAgentPrincipals,
	setExternalAgentPrincipalStatus,
} from "@tedix/db/queries/external-agent-identity/principals";
import {
	recordExternalAgentReviewEvidence,
	remediateExternalAgentReviewEvidence,
} from "@tedix/db/queries/external-agent-identity/review-evidence";
import {
	hasExternalAgentWorkAttempt,
	heartbeatExternalAgentSession,
	listExternalAgentSessions,
	openExternalAgentSession,
	resolveActiveExternalAgentSession,
} from "@tedix/db/queries/external-agent-identity/sessions";
import { getExternalAgentSession } from "@tedix/db/queries/external-agent-identity/session-state";
import { consumeExternalAgentWorkloadToken } from "@tedix/db/queries/external-agent-identity/workload-tokens";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	bindPrincipalIdentity,
	revokePrincipalIdentity,
} from "@tedix/db/queries/principal-identities";
import { type BaseContext, createError, ErrorCodes, withAuth } from "../orpc";
import { requireAihEnv } from "./descope-aih-env";
import {
	governanceAuthorityActor,
	hasEarnedDelegationGovernanceAuthority,
} from "./earned-delegation-access";
import {
	resolveCallerOwnerHostSession,
	verifiedActiveUserMembership,
} from "./work-items-principal";

/** Reserved: only openOwnerHostSession mints principals with this key prefix. */
const OWNER_HOST_PRINCIPAL_KEY_PREFIX = "owner-host-";

const identityOs = implement(
	externalAgentIdentityContract,
).$context<BaseContext>();
const authed = identityOs.use(withAuth);

function requireOrganization(context: BaseContext, requested?: string): string {
	const organizationId =
		context.organizationId ?? context.apiKey?.organizationId;
	if (!organizationId) {
		throw createError(ErrorCodes.FORBIDDEN, "Organization scope is required");
	}
	if (requested && requested !== organizationId) {
		throw createError(ErrorCodes.FORBIDDEN, "Organization is out of scope");
	}
	return organizationId;
}

function rethrowIdentityError(error: unknown): never {
	if (!(error instanceof ExternalAgentIdentityError)) throw error;
	const code =
		error.reason === "principal_not_found" ||
		error.reason === "session_not_found" ||
		error.reason === "review_not_found"
			? ErrorCodes.NOT_FOUND
			: error.reason === "wrong_org"
				? ErrorCodes.FORBIDDEN
				: ErrorCodes.CONFLICT;
	throw createError(code, error.message);
}

function requireGovernance(context: BaseContext) {
	if (!hasEarnedDelegationGovernanceAuthority(context)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"External-agent principal governance requires owner/admin authority",
		);
	}
	const actor = governanceAuthorityActor(context);
	if (!actor) {
		throw createError(ErrorCodes.FORBIDDEN, "Governance actor is unavailable");
	}
	return actor;
}

function workloadAllowedScopes(metadata: unknown): string[] {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return [];
	}
	const value = (metadata as Record<string, unknown>).allowedScopes;
	return Array.isArray(value)
		? value.filter((scope): scope is string => typeof scope === "string")
		: [];
}

function rethrowWorkloadIdentityError(error: unknown): never {
	if (!(error instanceof WorkloadIdentityError)) throw error;
	throw createError(ErrorCodes.UNAUTHORIZED, error.message);
}

export function resolveExternalAgentMcpClientScopes(
	requestedScopes: string[],
	approvedScopes: McpServerApprovedScopes | null | undefined,
): string[] {
	const requested = [...new Set(requestedScopes)].sort();
	const approved = new Set(extractMcpApprovedScopeNames(approvedScopes));
	const unapproved = requested.filter((scope) => !approved.has(scope));
	if (unapproved.length > 0) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Requested MCP scopes are not approved by the target resource: ${unapproved.join(", ")}`,
		);
	}
	return requested;
}

function sameScopeSet(
	left: readonly string[],
	right: readonly string[],
): boolean {
	const normalizedLeft = [...new Set(left)].sort();
	const normalizedRight = [...new Set(right)].sort();
	return (
		normalizedLeft.length === normalizedRight.length &&
		normalizedLeft.every((scope, index) => scope === normalizedRight[index])
	);
}

export function selectReusableExternalAgentMcpCredential<
	TCredential extends { clientRecordId: string },
>(
	activeCredentials: readonly TCredential[],
	registeredClients: ReadonlyArray<{
		id: string;
		status?: string | null;
		scopes?: string[] | null;
		tags?: string[] | null;
	}>,
	desiredScopes: readonly string[],
	requiredTags: readonly string[],
): TCredential | null {
	return (
		activeCredentials.find((credential) => {
			const registered = registeredClients.find(
				(candidate) => candidate.id === credential.clientRecordId,
			);
			if (!registered || registered.status !== "verified") return false;
			const tags = registered.tags ?? [];
			const identityPrefixes = [
				"external-agent-org:",
				"external-agent-principal:",
				"external-agent-session:",
			];
			return (
				requiredTags.every((tag) => tags.includes(tag)) &&
				identityPrefixes.every(
					(prefix) => tags.filter((tag) => tag.startsWith(prefix)).length === 1,
				) &&
				!tags.some((tag) => tag.startsWith("tedi:")) &&
				sameScopeSet(registered.scopes ?? [], desiredScopes)
			);
		}) ?? null
	);
}

async function resolveMcpCredentialTarget(
	context: BaseContext,
	organizationId: string,
	requestedUrl: string,
): Promise<{ mcpServerId: string; mcpServerUrl: string }> {
	let url: URL;
	try {
		url = new URL(requestedUrl);
	} catch {
		throw createError(ErrorCodes.BAD_REQUEST, "Invalid MCP server URL");
	}
	const parsedAudience = parseTedixMcpAudience(requestedUrl);
	if (
		url.protocol !== "https:" ||
		url.port ||
		url.username ||
		url.password ||
		url.pathname !== "/mcp" ||
		url.search ||
		url.hash ||
		!parsedAudience
	) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"MCP server must be an HTTPS Tedix app URL ending in /mcp",
		);
	}
	const app = await getAppBySlugForOrg(
		context.db,
		parsedAudience.slug,
		organizationId,
	);
	if (!app) throw createError(ErrorCodes.NOT_FOUND, "MCP app not found");
	const metadata = getAppMetadataJson(app);
	const mcpServerId =
		typeof metadata?.mcpConfig?.descopeResourceId === "string"
			? metadata.mcpConfig.descopeResourceId
			: null;
	if (!mcpServerId) {
		throw createError(
			ErrorCodes.CONFLICT,
			"MCP app is missing a Descope AIH resource id",
		);
	}
	return {
		mcpServerId,
		mcpServerUrl: `https://${url.hostname.toLowerCase()}/mcp`,
	};
}

async function invalidateMcpClientCache(
	env: CloudflareEnv,
	mcpServerId: string,
): Promise<void> {
	if (!env.MCP_SERVICE) return;
	await env.MCP_SERVICE.fetch(
		new Request("https://internal/__internal/invalidate-scope-cache", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Service-Binding": "true",
			},
			body: JSON.stringify({ mcpServerId }),
		}),
	).catch(() => undefined);
}

async function requireBoundPrincipal(
	context: BaseContext,
	organizationId: string,
	principalId: string,
	options: { allowInactive?: boolean } = {},
) {
	const principal = await getExternalAgentPrincipal(context.db, {
		organizationId,
		principalId,
	});
	if (!principal) {
		throw createError(
			ErrorCodes.NOT_FOUND,
			"External-agent principal not found",
		);
	}
	const bindingMatches =
		principal.credentialBindingType === "api_key" &&
		context.authType === "apikey" &&
		context.apiKey?.id === principal.credentialBindingId;
	if (!bindingMatches) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Authenticated credential is not bound to this external-agent principal",
		);
	}
	if (!options.allowInactive && principal.status !== "active") {
		throw createError(
			ErrorCodes.CONFLICT,
			`External-agent principal is ${principal.status}`,
		);
	}
	return principal;
}

function requireGatewayVerifiedSession(
	context: BaseContext,
	input: { principalId: string; sessionId: string; clientRecordId?: string },
): string {
	const clientRecordId = context.externalAgentClientRecordId;
	if (
		context.authType !== "service-binding" ||
		context.externalAgentPrincipalId !== input.principalId ||
		context.externalAgentSessionId !== input.sessionId ||
		!clientRecordId ||
		(input.clientRecordId !== undefined &&
			clientRecordId !== input.clientRecordId)
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"External-agent lifecycle call must match the gateway-verified principal, session, and client",
		);
	}
	return clientRecordId;
}

async function requireKnowledgeWorkItem(
	context: BaseContext,
	organizationId: string,
	workItemId: string,
	principalId: string,
	sessionId: string,
): Promise<void> {
	const checkedOut = await hasExternalAgentWorkAttempt(context.db, {
		organizationId,
		workItemId,
		principalId,
		sessionId,
	});
	if (!checkedOut) {
		throw createError(
			ErrorCodes.NOT_FOUND,
			"Knowledge lifecycle Work Item was not checked out by this external Agent-Session",
		);
	}
}

const createPrincipal = authed.createPrincipal.handler(
	async ({ input, context }) => {
		const organizationId = requireOrganization(context, input.organizationId);
		const actor = requireGovernance(context);
		if (input.key.toLowerCase().startsWith(OWNER_HOST_PRINCIPAL_KEY_PREFIX)) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Principal keys starting with "${OWNER_HOST_PRINCIPAL_KEY_PREFIX}" are reserved for owner-host sessions`,
			);
		}
		if (input.credentialBindingType === "api_key") {
			const apiKey = await getApiKeyById(context.db, input.credentialBindingId);
			if (
				!apiKey ||
				apiKey.organizationId !== organizationId ||
				apiKey.status !== "active"
			) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Credential binding must reference an active API key in this organization",
				);
			}
		} else if (
			!input.credentialBindingId.startsWith("repo:") ||
			workloadAllowedScopes(input.metadata).length === 0
		) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"GitHub Actions workload bindings require an exact repo subject and non-empty metadata.allowedScopes",
			);
		}
		try {
			return await createExternalAgentPrincipal(context.db, {
				id: crypto.randomUUID(),
				organizationId,
				key: input.key,
				displayName: input.displayName,
				credentialBindingType: input.credentialBindingType,
				credentialBindingId: input.credentialBindingId,
				createdByType: actor.type === "api_key" ? "api_key" : "user",
				createdById: actor.id,
				metadata:
					input.metadata === undefined
						? undefined
						: toJsonRecord(input.metadata),
				createdAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowIdentityError(error);
		}
	},
);

const setPrincipalStatus = authed.setPrincipalStatus.handler(
	async ({ input, context }) => {
		const organizationId = requireOrganization(context, input.organizationId);
		requireGovernance(context);
		try {
			return await setExternalAgentPrincipalStatus(context.db, {
				organizationId,
				principalId: input.principalId,
				status: input.status,
				updatedAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowIdentityError(error);
		}
	},
);

const openSession = authed.openSession.handler(async ({ input, context }) => {
	const organizationId = requireOrganization(context, input.organizationId);
	await requireBoundPrincipal(context, organizationId, input.principalId);
	try {
		return await openExternalAgentSession(context.db, {
			id: crypto.randomUUID(),
			organizationId,
			principalId: input.principalId,
			externalSessionKey: input.externalSessionKey,
			harness: input.harness,
			harnessVersion: input.harnessVersion,
			modelProvider: input.modelProvider,
			modelId: input.modelId,
			modelVersion: input.modelVersion,
			identitySource: "explicit",
			metadata:
				input.metadata === undefined ? undefined : toJsonRecord(input.metadata),
			startedAt: new Date().toISOString(),
		});
	} catch (error) {
		rethrowIdentityError(error);
	}
});

function requireHumanUser(context: BaseContext): void {
	if (
		context.authType !== "user" ||
		typeof context.user?.sub !== "string" ||
		context.tediId ||
		context.externalAgentPrincipalId
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Owner-host Agent-Sessions require an authenticated human user",
		);
	}
}

async function ownerHostPrincipalKey(userId: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(userId),
	);
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `${OWNER_HOST_PRINCIPAL_KEY_PREFIX}${hex.slice(0, 12)}`;
}

function ownerHostDisplayName(context: BaseContext): string {
	const claims = (context.user ?? {}) as Record<string, unknown>;
	const name = typeof claims.name === "string" ? claims.name.trim() : "";
	const email = typeof claims.email === "string" ? claims.email.trim() : "";
	const label = name || email.split("@")[0]?.trim() || "their owner";
	return `Plugin hosts of ${label}`.slice(0, 200);
}

/**
 * Get or create the caller's single owner_user principal. The binding is the
 * canonical user id from verified active membership; organization comes only
 * from authenticated context. A suspended or retired principal stays so.
 */
async function ensureOwnerHostPrincipal(
	context: BaseContext,
	organizationId: string,
	userId: string,
) {
	const existing = await getOwnerUserExternalAgentPrincipal(context.db, {
		organizationId,
		userId,
	});
	let principal = existing;
	if (!principal) {
		try {
			principal = await createExternalAgentPrincipal(context.db, {
				id: crypto.randomUUID(),
				organizationId,
				key: await ownerHostPrincipalKey(userId),
				displayName: ownerHostDisplayName(context),
				credentialBindingType: OWNER_USER_BINDING_TYPE,
				credentialBindingId: userId,
				createdByType: "user",
				createdById: userId,
				metadata: { ownerBound: true, source: "mcp-plugin" },
				createdAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowIdentityError(error);
		}
	}
	if (principal.status !== "active") {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`Owner-host principal is ${principal.status}`,
		);
	}
	return principal;
}

const openOwnerHostSession = authed.openOwnerHostSession.handler(
	async ({ input, context }) => {
		requireHumanUser(context);
		const organizationId = requireOrganization(context);
		const membership = await verifiedActiveUserMembership(
			context,
			organizationId,
			"active owner-host",
		);
		const externalSessionKey =
			input.externalSessionKey ?? `${input.harness}:${crypto.randomUUID()}`;
		if (!externalSessionKey.startsWith(`${input.harness}:`)) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"externalSessionKey must be <harness>:<id> for the supplied harness",
			);
		}
		const principal = await ensureOwnerHostPrincipal(
			context,
			organizationId,
			membership.userId,
		);
		let session: Awaited<ReturnType<typeof openExternalAgentSession>>;
		try {
			session = await openExternalAgentSession(context.db, {
				id: crypto.randomUUID(),
				organizationId,
				principalId: principal.id,
				externalSessionKey,
				harness: input.harness,
				harnessVersion: input.harnessVersion,
				modelProvider: input.modelProvider,
				modelId: input.modelId,
				modelVersion: input.modelVersion,
				identitySource: "explicit",
				creditEligible: false,
				metadata: { ownerBound: true, source: "mcp-plugin" },
				startedAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowIdentityError(error);
		}
		if (session.creditEligible) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Owner-host Agent-Session unexpectedly carries corroboration credit",
			);
		}
		return {
			session,
			principal: {
				id: principal.id,
				key: principal.key,
				displayName: principal.displayName,
			},
		};
	},
);

const resolveOwnerHostSession = authed.resolveOwnerHostSession.handler(
	async ({ input, context }) => {
		requireHumanUser(context);
		const organizationId = requireOrganization(context);
		const { principal, session } = await resolveCallerOwnerHostSession(
			context,
			organizationId,
			input.sessionId,
		);
		return {
			session,
			principal: {
				id: principal.id,
				key: principal.key,
				displayName: principal.displayName,
			},
		};
	},
);

const authorizeWorkloadSession = authed.authorizeWorkloadSession.handler(
	async ({ input, context }) => {
		const principal = await getExternalAgentPrincipalById(
			context.db,
			input.principalId,
		);
		if (!principal) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"External-agent principal not found",
			);
		}
		const organizationId = principal.organizationId;
		if (input.organizationId !== organizationId) {
			throw createError(ErrorCodes.FORBIDDEN, "Organization is out of scope");
		}
		if (
			principal.status !== "active" ||
			principal.credentialBindingType !== "github_actions_oidc"
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"External-agent principal is not an active workload identity",
			);
		}

		let verified;
		let scopes: string[];
		try {
			verified = await verifyGithubActionsWorkloadToken(input.subjectToken, {
				expectedSubject: principal.credentialBindingId,
			});
			scopes = resolveFederatedWorkloadScopes(
				input.scopes,
				workloadAllowedScopes(principal.metadata),
			);
		} catch (error) {
			rethrowWorkloadIdentityError(error);
		}

		const now = new Date();
		const exchangeId = crypto.randomUUID();
		const consumed = await consumeExternalAgentWorkloadToken(context.db, {
			id: exchangeId,
			organizationId,
			principalId: input.principalId,
			issuer: verified.issuer,
			subject: verified.subject,
			audience: verified.audience,
			jti: verified.jti,
			externalSessionKey: input.externalSessionKey,
			tokenIssuedAt: new Date(verified.issuedAt * 1_000).toISOString(),
			tokenExpiresAt: new Date(verified.expiresAt * 1_000).toISOString(),
			consumedAt: now.toISOString(),
		});
		if (!consumed) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Workload assertion was already consumed",
			);
		}

		try {
			const session = await openExternalAgentSession(context.db, {
				id: crypto.randomUUID(),
				organizationId,
				principalId: input.principalId,
				externalSessionKey: input.externalSessionKey,
				harness: input.harness,
				harnessVersion: input.harnessVersion,
				modelProvider: input.modelProvider,
				modelId: input.modelId,
				modelVersion: input.modelVersion,
				identitySource: "explicit",
				metadata: {
					...(input.metadata === undefined ? {} : toJsonRecord(input.metadata)),
					workloadExchangeId: exchangeId,
					workloadIssuer: GITHUB_ACTIONS_OIDC_ISSUER,
					workloadSubject: verified.subject,
				},
				startedAt: now.toISOString(),
			});
			const grantToken = await issueExternalAgentWorkloadGrant({
				secret: context.env.SECRETS_MASTER_KEY,
				organizationId,
				principalId: input.principalId,
				sessionId: session.id,
				exchangeId,
				scopes,
				expiresAt: Math.min(
					verified.expiresAt,
					Math.floor(Date.now() / 1_000) + 60,
				),
			});
			console.log(
				JSON.stringify({
					event: "external_agent_workload_session_authorized",
					exchangeId,
					organizationId,
					principalId: input.principalId,
					sessionId: session.id,
				}),
			);
			return { session, grantToken };
		} catch (error) {
			rethrowIdentityError(error);
		}
	},
);

const heartbeatSession = authed.heartbeatSession.handler(
	async ({ input, context }) => {
		const organizationId = requireOrganization(context, input.organizationId);
		await requireBoundPrincipal(context, organizationId, input.principalId);
		try {
			return await heartbeatExternalAgentSession(context.db, {
				organizationId,
				principalId: input.principalId,
				sessionId: input.sessionId,
				seenAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowIdentityError(error);
		}
	},
);

const recordKnowledgeCheckpoint = authed.recordKnowledgeCheckpoint.handler(
	async ({ input, context }) => {
		const organizationId = requireOrganization(context, input.organizationId);
		requireGatewayVerifiedSession(context, input);
		await requireKnowledgeWorkItem(
			context,
			organizationId,
			input.workItemId,
			input.principalId,
			input.sessionId,
		);
		try {
			return await recordExternalAgentKnowledgeCheckpoint(context.db, {
				organizationId,
				principalId: input.principalId,
				sessionId: input.sessionId,
				checkpoint: {
					idempotencyKey: input.idempotencyKey,
					workItemId: input.workItemId,
					summary: input.summary,
					evidenceRefs: input.evidenceRefs,
					artifactRef: input.artifactRef ?? null,
					recordedAt: new Date().toISOString(),
				},
			});
		} catch (error) {
			rethrowIdentityError(error);
		}
	},
);

const recordKnowledgeDisposition = authed.recordKnowledgeDisposition.handler(
	async ({ input, context }) => {
		const organizationId = requireOrganization(context, input.organizationId);
		requireGatewayVerifiedSession(context, input);
		await requireKnowledgeWorkItem(
			context,
			organizationId,
			input.workItemId,
			input.principalId,
			input.sessionId,
		);
		const recordedAt = new Date().toISOString();
		try {
			return await recordExternalAgentKnowledgeDisposition(context.db, {
				organizationId,
				principalId: input.principalId,
				sessionId: input.sessionId,
				disposition: {
					type: "no_handoff",
					idempotencyKey: input.idempotencyKey,
					workItemId: input.workItemId,
					reason: input.reason,
					recordedAt,
				},
			});
		} catch (error) {
			rethrowIdentityError(error);
		}
	},
);

const endSession = authed.endSession.handler(async ({ input, context }) => {
	const organizationId = requireOrganization(context, input.organizationId);
	const clientRecordId = requireGatewayVerifiedSession(context, input);
	try {
		const ended = await endExternalAgentSession(context.db, {
			organizationId,
			principalId: input.principalId,
			sessionId: input.sessionId,
			endedAt: new Date().toISOString(),
			zeroWorkDisposition: input.zeroWorkDisposition,
		});
		let revoked: Awaited<ReturnType<typeof revokeExternalAgentMcpCredential>>;
		try {
			revoked = await revokeExternalAgentMcpCredential(context.db, {
				organizationId,
				principalId: input.principalId,
				sessionId: input.sessionId,
				clientRecordId,
				revokedAt: new Date().toISOString(),
			});
		} catch (error) {
			if (
				!(error instanceof ExternalAgentIdentityError) ||
				error.reason !== "credential_not_found"
			) {
				throw error;
			}
			return ended;
		}
		const aihEnv =
			context.env.DESCOPE_PROJECT_ID && context.env.DESCOPE_MANAGEMENT_KEY
				? requireAihEnv(context.env)
				: null;
		if (aihEnv) {
			await deleteDescopeMcpServerClient(aihEnv, {
				id: clientRecordId,
				mcpServerId: revoked.mcpServerId,
			}).catch(() => undefined);
		}
		await invalidateMcpClientCache(context.env, revoked.mcpServerId);
		return ended;
	} catch (error) {
		rethrowIdentityError(error);
	}
});

const retireAbandonedSession = authed.retireAbandonedSession.handler(
	async ({ input, context }) => {
		const organizationId = requireOrganization(context, input.organizationId);
		const actor = requireGovernance(context);
		const activeCredentials =
			await listActiveExternalAgentMcpCredentialsForSession(context.db, {
				organizationId,
				principalId: input.principalId,
				sessionId: input.sessionId,
			});
		const aihEnv =
			context.env.DESCOPE_PROJECT_ID && context.env.DESCOPE_MANAGEMENT_KEY
				? requireAihEnv(context.env)
				: null;
		const retiredAt = new Date().toISOString();
		let session: Awaited<ReturnType<typeof endExternalAgentSession>>;
		let alreadyEnded = false;
		try {
			const existingSession = await getExternalAgentSession(context.db, {
				organizationId,
				principalId: input.principalId,
				sessionId: input.sessionId,
			});
			alreadyEnded = existingSession?.status === "ended";
			if (existingSession && existingSession.status === "ended") {
				// A prior self-teardown can end the session before its Descope delete or
				// D1 credential update completes. Governance recovery must remain able to
				// finish that partial cleanup instead of failing on the terminal session.
				session = existingSession;
			} else if (input.workDisposition) {
				await recordExternalAgentKnowledgeDisposition(context.db, {
					organizationId,
					principalId: input.principalId,
					sessionId: input.sessionId,
					disposition: {
						...input.workDisposition,
						recordedAt: retiredAt,
					},
				});
				session = await endExternalAgentSession(context.db, {
					organizationId,
					principalId: input.principalId,
					sessionId: input.sessionId,
					endedAt: retiredAt,
				});
			} else {
				session = await endExternalAgentSession(context.db, {
					organizationId,
					principalId: input.principalId,
					sessionId: input.sessionId,
					endedAt: retiredAt,
					zeroWorkDisposition: {
						idempotencyKey: `governed-retirement:${input.sessionId}`,
						reason: input.reason,
					},
				});
			}
			const credentialsByServer = Map.groupBy(
				activeCredentials,
				(credential) => credential.mcpServerId,
			);
			if (aihEnv) {
				for (const [mcpServerId, credentials] of credentialsByServer) {
					await deleteDescopeMcpServerClients(aihEnv, {
						ids: credentials.map((credential) => credential.clientRecordId),
						mcpServerId,
					});
				}
			}
			for (const mcpServerId of credentialsByServer.keys()) {
				await invalidateMcpClientCache(context.env, mcpServerId);
			}
			for (const credential of activeCredentials) {
				await revokeExternalAgentMcpCredential(context.db, {
					organizationId,
					principalId: input.principalId,
					sessionId: input.sessionId,
					clientRecordId: credential.clientRecordId,
					revokedAt: retiredAt,
				});
			}
		} catch (error) {
			rethrowIdentityError(error);
		}
		await insertAuditEvent(context.db, {
			id: `external-agent-session-retired:${input.sessionId}`,
			organizationId,
			actorId: actor.id,
			actorType: actor.type,
			action: "external_agent.session.retired_abandoned",
			resourceType: "external_agent_session",
			resourceId: input.sessionId,
			metadata: {
				principalId: input.principalId,
				reason: input.reason,
				knowledgeDispositionType: alreadyEnded
					? "already_ended"
					: (input.workDisposition?.type ?? "zero_work"),
				retiredAt,
				revokedClientRecordIds: activeCredentials.map(
					(credential) => credential.clientRecordId,
				),
			},
			ignoreDuplicates: true,
		});
		return {
			session,
			revokedCredentialCount: activeCredentials.length,
		};
	},
);

const recordAttribution = authed.recordAttribution.handler(
	async ({ input, context }) => {
		const organizationId = requireOrganization(context, input.organizationId);
		await requireBoundPrincipal(context, organizationId, input.principalId);
		try {
			return await recordExternalAgentAttribution(context.db, {
				id: crypto.randomUUID(),
				organizationId,
				principalId: input.principalId,
				sessionId: input.sessionId,
				targetType: input.targetType,
				targetId: input.targetId,
				role: input.role,
				workItemId: input.workItemId,
				metadata:
					input.metadata === undefined
						? undefined
						: toJsonRecord(input.metadata),
				occurredAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowIdentityError(error);
		}
	},
);

const recordReview = authed.recordReview.handler(async ({ input, context }) => {
	const organizationId = requireOrganization(context, input.organizationId);
	let reviewer:
		| {
				type: "external_agent";
				id: string;
				sessionId: string;
		  }
		| { type: "user" | "certification_service"; id: string };
	if (context.authType === "apikey" && context.apiKey?.id) {
		const external = await getExternalAgentPrincipalByCredential(context.db, {
			organizationId,
			credentialBindingId: context.apiKey.id,
		});
		if (external) {
			if (!input.reviewerSessionId) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"External-agent reviewers must supply their active reviewerSessionId",
				);
			}
			reviewer = {
				type: "external_agent",
				id: external.id,
				sessionId: input.reviewerSessionId,
			};
		} else {
			const actor = requireGovernance(context);
			reviewer = { type: "certification_service", id: actor.id };
		}
	} else if (
		context.authType === "user" &&
		typeof context.user?.sub === "string"
	) {
		requireGovernance(context);
		if (input.reviewerSessionId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Human reviewers cannot supply an external reviewer session",
			);
		}
		reviewer = { type: "user", id: context.user.sub };
	} else {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"An accountable human, certification service, or external-agent principal is required",
		);
	}
	try {
		return await recordExternalAgentReviewEvidence(context.db, {
			id: crypto.randomUUID(),
			organizationId,
			executionAttributionId: input.executionAttributionId,
			reviewerPrincipalType: reviewer.type,
			reviewerPrincipalId: reviewer.id,
			reviewerSessionId:
				reviewer.type === "external_agent" ? reviewer.sessionId : undefined,
			context: {
				taskFamily: input.taskFamily,
				repositoryKey: input.repositoryKey,
				repositoryVersion: input.repositoryVersion,
				riskLevel: input.riskLevel,
				environment: input.environment,
			},
			outcome: input.outcome,
			score: input.score,
			policyViolationSeverity: input.policyViolationSeverity,
			reviewMethod: input.reviewMethod,
			evidenceRefs: input.evidenceRefs,
			occurredAt: new Date().toISOString(),
		});
	} catch (error) {
		rethrowIdentityError(error);
	}
});

const remediateReview = authed.remediateReview.handler(
	async ({ input, context }) => {
		const organizationId = requireOrganization(context, input.organizationId);
		const actor = requireGovernance(context);
		try {
			return await remediateExternalAgentReviewEvidence(context.db, {
				organizationId,
				reviewId: input.reviewId,
				evidenceRef: input.evidenceRef,
				resolvedByType: actor.type,
				resolvedById: actor.id,
				resolvedAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowIdentityError(error);
		}
	},
);

const getContextualReputation = authed.getContextualReputation.handler(
	async ({ input, context }) => {
		const organizationId = requireOrganization(context, input.organizationId);
		requireGovernance(context);
		const principal = await getExternalAgentPrincipal(context.db, {
			organizationId,
			principalId: input.subjectPrincipalId,
		});
		if (!principal) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"External-agent principal not found",
			);
		}
		return getExternalAgentContextualReputation(context.db, {
			organizationId,
			subjectPrincipalId: principal.id,
			context: {
				taskFamily: input.taskFamily,
				repositoryKey: input.repositoryKey,
				repositoryVersion: input.repositoryVersion,
				riskLevel: input.riskLevel,
				environment: input.environment,
				harness: input.harness,
				harnessVersion: input.harnessVersion,
				modelProvider: input.modelProvider,
				modelId: input.modelId,
				modelVersion: input.modelVersion,
			},
			now: new Date().toISOString(),
			halfLifeDays: input.halfLifeDays,
		});
	},
);

const resolveSessionAuth = authed.resolveSessionAuth.handler(
	async ({ input, context }) => {
		if (context.authType !== "service-binding") {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"External-agent session resolution requires a trusted service binding",
			);
		}
		const resolved = await resolveAuthorizedExternalAgentMcpSession(
			context.db,
			{
				...input,
				now: new Date().toISOString(),
			},
		);
		if (!resolved) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Active external-agent session not found",
			);
		}
		return { principal: resolved.principal, session: resolved.session };
	},
);

const recordVerifiedMcpExecution = authed.recordVerifiedMcpExecution.handler(
	async ({ input, context }) => {
		if (context.authType !== "service-binding") {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Verified MCP attribution requires a trusted service binding",
			);
		}
		if (
			context.externalAgentPrincipalId !== input.principalId ||
			context.externalAgentSessionId !== input.sessionId ||
			context.externalAgentClientRecordId !== input.clientRecordId
		) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Verified MCP attribution must match the gateway caller identity",
			);
		}
		try {
			return await recordVerifiedExternalAgentMcpExecution(context.db, {
				id: crypto.randomUUID(),
				organizationId: input.organizationId,
				principalId: input.principalId,
				sessionId: input.sessionId,
				targetId: input.targetId,
				clientRecordId: input.clientRecordId,
				metadata:
					input.metadata === undefined
						? undefined
						: toJsonRecord(input.metadata),
				occurredAt: input.occurredAt,
			});
		} catch (error) {
			rethrowIdentityError(error);
		}
	},
);

const issueMcpCredential = authed.issueMcpCredential.handler(
	async ({ input, context }) => {
		const workloadGrant = context.headers.get(
			"X-Tedix-External-Agent-Workload-Grant",
		);
		if (context.authType === "service-binding" && workloadGrant) {
			try {
				const grant = await verifyExternalAgentWorkloadGrant(workloadGrant, {
					secret: context.env.SECRETS_MASTER_KEY,
					principalId: input.principalId,
					sessionId: input.sessionId,
				});
				const organizationId = grant.organizationId;
				if (input.organizationId !== organizationId) {
					throw new WorkloadIdentityError(
						"Workload grant organization does not match the request",
						"subject_mismatch",
					);
				}
				resolveFederatedWorkloadScopes(input.scopes, grant.scopes);
				return await issueMcpCredentialForOrganization(
					input,
					context,
					organizationId,
				);
			} catch (error) {
				rethrowWorkloadIdentityError(error);
			}
		}
		const organizationId = requireOrganization(context, input.organizationId);
		{
			// The binding key proves the accountable principal and carries only Work
			// lifecycle authority. MCP capabilities belong to the target Descope
			// resource; resolveExternalAgentMcpClientScopes below constrains every
			// requested grant to that resource's approved exact scopes.
			await requireBoundPrincipal(context, organizationId, input.principalId);
		}
		return issueMcpCredentialForOrganization(input, context, organizationId);
	},
);

async function issueMcpCredentialForOrganization(
	input: {
		organizationId?: string;
		principalId: string;
		sessionId: string;
		scopes: string[];
		mcpServerUrl: string;
		clientName?: string;
	},
	context: BaseContext,
	organizationId: string,
) {
	const active = await resolveActiveExternalAgentSession(context.db, {
		organizationId,
		principalId: input.principalId,
		sessionId: input.sessionId,
	});
	if (!active) {
		throw createError(ErrorCodes.NOT_FOUND, "Active session not found");
	}
	const aihEnv = requireAihEnv(context.env);
	const { mcpServerId, mcpServerUrl } = await resolveMcpCredentialTarget(
		context,
		organizationId,
		input.mcpServerUrl,
	);
	const leaseOwnerToken = crypto.randomUUID();
	const leaseStartedAt = new Date();
	const leaseInput = {
		organizationId,
		principalId: input.principalId,
		sessionId: input.sessionId,
		mcpServerId,
		ownerToken: leaseOwnerToken,
	};
	const acquired = await acquireExternalAgentMcpIssuanceLease(context.db, {
		...leaseInput,
		id: crypto.randomUUID(),
		now: leaseStartedAt.toISOString(),
		expiresAt: new Date(leaseStartedAt.getTime() + 120_000).toISOString(),
	});
	if (!acquired) {
		throw createError(
			ErrorCodes.CONFLICT,
			"MCP credential issuance is already in progress for this session and resource",
		);
	}
	let client: Awaited<ReturnType<typeof createDescopeMcpServerClient>> | null =
		null;
	try {
		const mcpServer = await loadDescopeMcpServer(aihEnv, mcpServerId);
		const desiredScopes = resolveExternalAgentMcpClientScopes(
			input.scopes,
			mcpServer.approvedScopes,
		);
		const activeCredentials = await listActiveExternalAgentMcpCredentials(
			context.db,
			{
				organizationId,
				principalId: input.principalId,
				sessionId: input.sessionId,
				mcpServerId,
			},
		);
		const registeredClients = activeCredentials.length
			? await searchDescopeMcpServerClients(aihEnv, { mcpServerId })
			: [];
		const identityTags = [
			"external-agent",
			`external-agent-org:${organizationId}`,
			`external-agent-principal:${input.principalId}`,
			`external-agent-session:${input.sessionId}`,
		];
		const reusable = selectReusableExternalAgentMcpCredential(
			activeCredentials,
			registeredClients,
			desiredScopes,
			identityTags,
		);

		// Reuse-miss telemetry: when the session already has active credentials
		// but none were reusable, a fresh client is about to be minted — the
		// leak's live signature. Emit why the newest candidate was rejected so
		// the runtime cause (offline analysis rules out scope/tag/search-cap)
		// can be pinned from logs instead of inference.
		const newestActive = reusable ? undefined : activeCredentials[0];
		if (newestActive) {
			const registered = registeredClients.find(
				(candidate) => candidate.id === newestActive.clientRecordId,
			);
			console.warn(
				JSON.stringify({
					event: "external-agent-mcp-reuse-miss",
					organizationId,
					principalId: input.principalId,
					sessionId: input.sessionId,
					mcpServerId,
					activeCredentials: activeCredentials.length,
					registeredClients: registeredClients.length,
					desiredScopes,
					newestClientRecordId: newestActive.clientRecordId,
					newestRegistered: Boolean(registered),
					newestStatus: registered?.status ?? null,
					newestScopesMatch: registered
						? sameScopeSet(registered.scopes ?? [], desiredScopes)
						: null,
					newestTags: registered?.tags ?? null,
				}),
			);
		}

		if (reusable) {
			const secret = await getDescopeMcpServerClientSecret(aihEnv, {
				id: reusable.clientRecordId,
				mcpServerId,
			});
			const registered = registeredClients.find(
				(candidate) => candidate.id === reusable.clientRecordId,
			);
			const clientId = registered?.clientId ?? registered?.client_id;
			if (!clientId)
				throw new Error("Reusable AIH MCP client is missing its client id");
			const token = await exchangeAihClientCredentials(
				{ DESCOPE_PROJECT_ID: aihEnv.DESCOPE_PROJECT_ID },
				mcpServerUrl,
				clientId,
				secret,
			);
			const issuedAt = new Date();
			await refreshExternalAgentMcpCredentialUnderLease(context.db, {
				organizationId,
				principalId: input.principalId,
				sessionId: input.sessionId,
				clientRecordId: reusable.clientRecordId,
				mcpServerId,
				leaseOwnerToken,
				leaseNow: issuedAt.toISOString(),
				issuedAt: issuedAt.toISOString(),
				expiresAt: new Date(
					issuedAt.getTime() + token.expiresIn * 1_000,
				).toISOString(),
			});
			await invalidateMcpClientCache(context.env, mcpServerId).catch((error) =>
				console.error(
					"[ExternalAgentIdentity] MCP client cache invalidation failed",
					error,
				),
			);
			return {
				accessToken: token.accessToken,
				clientRecordId: reusable.clientRecordId,
				expiresIn: token.expiresIn,
				mcpServerUrl,
			};
		}

		client = await createDescopeMcpServerClient(aihEnv, {
			forceAddAllAuthorizationInfo: true,
			mcpServerId,
			name:
				input.clientName ??
				`External agent ${active.principal.displayName} ${active.session.harness}`,
			scopes: desiredScopes,
			tags: identityTags,
		});
		const token = await exchangeAihClientCredentials(
			{ DESCOPE_PROJECT_ID: aihEnv.DESCOPE_PROJECT_ID },
			mcpServerUrl,
			client.clientId,
			client.clientSecret,
		);
		const issuedAt = new Date();
		await bindPrincipalIdentity(context.db, {
			organizationId,
			principalType: "external_agent",
			principalId: input.principalId,
			provider: "descope",
			issuer: descopeIssuer(
				aihEnv.DESCOPE_PROJECT_ID,
				DESCOPE_MANAGEMENT_BASE_URL,
			),
			subject: client.clientId,
		});
		await recordExternalAgentMcpCredentialUnderLease(context.db, {
			id: crypto.randomUUID(),
			organizationId,
			principalId: input.principalId,
			sessionId: input.sessionId,
			clientRecordId: client.id,
			mcpServerId,
			mcpServerUrl,
			leaseOwnerToken,
			leaseNow: issuedAt.toISOString(),
			issuedAt: issuedAt.toISOString(),
			expiresAt: new Date(
				issuedAt.getTime() + token.expiresIn * 1_000,
			).toISOString(),
		});
		await invalidateMcpClientCache(context.env, mcpServerId).catch((error) =>
			console.error(
				"[ExternalAgentIdentity] MCP client cache invalidation failed",
				error,
			),
		);
		return {
			accessToken: token.accessToken,
			clientRecordId: client.id,
			expiresIn: token.expiresIn,
			mcpServerUrl,
		};
	} catch (error) {
		if (client) {
			await revokePrincipalIdentity(context.db, {
				provider: "descope",
				issuer: descopeIssuer(
					aihEnv.DESCOPE_PROJECT_ID,
					DESCOPE_MANAGEMENT_BASE_URL,
				),
				subject: client.clientId,
			}).catch(() => undefined);
			await deleteDescopeMcpServerClient(aihEnv, {
				id: client.id,
				mcpServerId,
			}).catch(() => {});
		}
		if (error instanceof ORPCError && error.code === ErrorCodes.BAD_REQUEST) {
			throw error;
		}
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			error instanceof Error
				? `External-agent MCP credential issuance failed: ${error.message}`
				: "External-agent MCP credential issuance failed",
		);
	} finally {
		await releaseExternalAgentMcpIssuanceLease(context.db, leaseInput).catch(
			(error) =>
				console.error(
					"[ExternalAgentIdentity] MCP issuance lease release failed",
					error,
				),
		);
	}
}

const revokeMcpCredential = authed.revokeMcpCredential.handler(
	async ({ input, context }) => {
		const organizationId = requireOrganization(context, input.organizationId);
		requireGatewayVerifiedSession(context, input);
		let revoked: Awaited<ReturnType<typeof revokeExternalAgentMcpCredential>>;
		try {
			revoked = await revokeExternalAgentMcpCredential(context.db, {
				organizationId,
				principalId: input.principalId,
				sessionId: input.sessionId,
				clientRecordId: input.clientRecordId,
				revokedAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowIdentityError(error);
		}
		const aihEnv =
			context.env.DESCOPE_PROJECT_ID && context.env.DESCOPE_MANAGEMENT_KEY
				? requireAihEnv(context.env)
				: null;
		if (aihEnv)
			await deleteDescopeMcpServerClient(aihEnv, {
				id: input.clientRecordId,
				mcpServerId: revoked.mcpServerId,
			}).catch(() => undefined);
		await invalidateMcpClientCache(context.env, revoked.mcpServerId);
		return { success: true as const };
	},
);

const listPrincipals = authed.listPrincipals.handler(
	async ({ input, context }) => {
		const organizationId = requireOrganization(context, input.organizationId);
		requireGovernance(context);
		return listExternalAgentPrincipals(context.db, {
			organizationId,
			limit: input.limit,
		});
	},
);

const listSessions = authed.listSessions.handler(async ({ input, context }) => {
	const organizationId = requireOrganization(context, input.organizationId);
	requireGovernance(context);
	return listExternalAgentSessions(context.db, {
		organizationId,
		principalId: input.principalId,
		limit: input.limit,
	});
});

const listStaleKnowledgeSessions = authed.listStaleKnowledgeSessions.handler(
	async ({ input, context }) => {
		const organizationId = requireOrganization(context, input.organizationId);
		requireGovernance(context);
		return listStaleExternalAgentKnowledgeSessions(context.db, {
			organizationId,
			staleBefore: input.staleBefore,
			limit: input.limit,
		});
	},
);

export const externalAgentIdentityContractRouter = identityOs.router({
	createPrincipal,
	setPrincipalStatus,
	openSession,
	openOwnerHostSession,
	resolveOwnerHostSession,
	authorizeWorkloadSession,
	heartbeatSession,
	recordKnowledgeCheckpoint,
	recordKnowledgeDisposition,
	endSession,
	retireAbandonedSession,
	resolveSessionAuth,
	recordVerifiedMcpExecution,
	issueMcpCredential,
	revokeMcpCredential,
	recordAttribution,
	recordReview,
	remediateReview,
	getContextualReputation,
	listPrincipals,
	listSessions,
	listStaleKnowledgeSessions,
});

export type ExternalAgentIdentityContractRouter =
	typeof externalAgentIdentityContractRouter;
