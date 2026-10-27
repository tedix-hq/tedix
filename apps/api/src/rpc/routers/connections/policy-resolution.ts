import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import { enforceConnectionConsumerGrants } from "./consumer-grant-resolution";
import { getDescopeManagement } from "../../../lib/descope-management";
import { DESCOPE_SESSION_COOKIE, readCookieHeader } from "@tedix/auth/web";
import {
	type BaseContext,
	ErrorCodes,
	createError,
	withAuth,
	withTediAuth,
} from "../../orpc";
import {
	assertConnectionResourceArguments,
	assertOrganizationConnectionResourceArguments,
} from "../../../services/connection-resource-policy";
import { assertOwnAccessForToolCall } from "../../../services/connection-access-check";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	IssuerPinDriftError,
	assertPinnedIssuerMatches,
} from "@tedix/auth/oauth-iss";
import {
	buildConnectionProviderMaps,
	getConnectionProviderByDescopeAppId,
	getConnectionProviderIssuerPin,
	listConnectionProviders,
} from "@tedix/db/queries/connection-providers";
import { connectionsContract } from "@tedix/api-contract/contracts/connections";
import {
	ConnectionTokenLookupError,
	fetchConnectionToken,
	fetchConnectionTokenByScopes,
	fetchPersonalConnectionToken,
	fetchNamedTenantConnectionToken,
	fetchTenantConnectionToken,
	fetchTenantConnectionTokenByScopes,
} from "@tedix/auth/connections";
import { outboundAppExists } from "@tedix/auth/connection-providers";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import {
	getConnectionInstance,
	recordConnectionGrant,
} from "@tedix/db/queries/connection-instances";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getTediOrganizationId } from "@tedix/db/queries/tedis";
import { implement } from "@orpc/server";
import { tenantConnectionHandoffUrl } from "../catalog/tenant-install-handoff";
import { collectReferencedProviders } from "./provider-registration";
import {
	chooseEffectiveConsentScopes,
	normalizeRequestedScopes,
} from "./url-and-scopes";

export const connectionsOs =
	implement(connectionsContract).$context<BaseContext>();

export const authedOs = connectionsOs.use(withAuth);

export const mcpOrAuthOs = connectionsOs.use(withAuth);

export const tediOs = connectionsOs.use(withTediAuth);

// =============================================================================
// HELPERS
// =============================================================================

export // =============================================================================
// HELPERS
// =============================================================================

function requireUserId(context: BaseContext): string {
	const userId = context.user?.sub;
	if (!userId) {
		throw createError(ErrorCodes.UNAUTHORIZED, "User identity required");
	}
	return userId;
}

export async function resolveConnectionConsentScopes(input: {
	db: BaseContext["db"];
	orgId: string;
	providerId: string;
	requestedScopes?: string | string[];
}): Promise<string[] | undefined> {
	const requestedScopes = normalizeRequestedScopes(input.requestedScopes);
	if (requestedScopes) return requestedScopes;

	const [referenced, providers] = await Promise.all([
		collectReferencedProviders(input.db, input.orgId, {
			includeToolReferences: false,
		}),
		listConnectionProviders(input.db),
	]);
	const { byDescopeAppId } = buildConnectionProviderMaps(providers);
	return chooseEffectiveConsentScopes({
		connectionScopes: referenced.connectionScopes.get(input.providerId),
		credentialProfile: referenced.credentialProfiles.get(input.providerId),
		provider: byDescopeAppId.get(input.providerId),
	});
}

/**
 * List the authenticated user's active connections.
 *
 * Loads all Descope outbound apps and fans out tenant/user token checks.
 * API-key providers are stored in Descope Token Vault through the user/tenant
 * API-key upload endpoints; project-specific credentials are represented by
 * project-specific outbound app IDs.
 */

export // =============================================================================
// TEDI-SCOPED HELPERS
// =============================================================================

/**
 * Resolve the Descope tenant ID for a given tedi.
 * Looks up the tedi's organization, then returns the org's descopeTenantId.
 * Also verifies that the authenticated tedi matches the requested tediId (if auth type is "tedi").
 */
async function resolveTediTenantId(
	context: BaseContext,
	tediId: string,
): Promise<{
	organizationId: string;
	descopeTenantId: string;
}> {
	// Guard: if authenticated via tedi access key, verify the tedi matches
	if (
		context.authType === "tedi" &&
		context.tediId &&
		context.tediId !== tediId
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Tedi access key does not match the requested tediId",
		);
	}

	// Look up the tedi's organization
	const tediOrgId = await getTediOrganizationId(context.db, tediId);
	if (!tediOrgId) {
		throw createError(ErrorCodes.NOT_FOUND, `Tedi ${tediId} not found`);
	}

	// Verify org ownership: the authenticated org must match the tedi's org
	if (context.organizationId && context.organizationId !== tediOrgId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Tedi does not belong to the authenticated organization",
		);
	}

	// Get the organization to find its Descope tenant ID
	const org = await getOrganizationById(context.db, tediOrgId);
	if (!org) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			`Organization ${tediOrgId} not found for tedi`,
		);
	}
	if (!org.descopeTenantId) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Organization does not have a Descope tenant configured",
		);
	}
	return {
		organizationId: tediOrgId,
		descopeTenantId: org.descopeTenantId,
	};
}

// =============================================================================
// TEDI-SCOPED PROCEDURES
// =============================================================================

/**
 * Fetch a connection token on behalf of a tedi.
 *
 * Uses scope-aware token retrieval from Descope Token Vault.
 * Supports tk_ access keys, service tokens, and all standard auth methods.
 */

export // =============================================================================
// TEDI-SCOPED PROCEDURES
// =============================================================================

/**
 * Fetch a connection token on behalf of a tedi.
 *
 * Uses scope-aware token retrieval from Descope Token Vault.
 * Supports tk_ access keys, service tokens, and all standard auth methods.
 */
type CredentialScope = "tenant" | "user" | "hybrid";

/**
 * Resolve the raw Descope user JWT for an Adaptive Connect call.
 *
 * Descope's connect endpoint is called as `Bearer {projectId}:{userToken}` and
 * must act AS the user, so it needs that user's own session JWT — a management
 * key cannot stand in.
 *
 * Direct bearer callers send it in `Authorization`. Browser user-session
 * callers, including Tedix OS, arrive through a trusted Worker boundary that
 * canonicalizes the host-only product session to the `DS` cookie before
 * forwarding. `orpc.ts` authenticates that same cookie as the user, so reading
 * its JWT here grants no authority the caller did not already hold.
 *
 * Returns null when neither source yields something JWT-shaped, leaving the
 * caller to raise its own 401 rather than handing Descope a junk credential.
 */
export function resolveAdaptiveConnectUserToken(
	headers: Headers,
): string | null {
	const authHeader =
		headers.get("Authorization") ?? headers.get("authorization");
	const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
	if (bearer?.startsWith("eyJ")) return bearer;
	const cookieToken = readCookieHeader(
		headers.get("Cookie") ?? headers.get("cookie"),
		DESCOPE_SESSION_COOKIE,
	);
	return cookieToken?.startsWith("eyJ") ? cookieToken : null;
}

export type CredentialPreference = "user-first" | "tenant-first";

export type CredentialResolutionTarget =
	| {
			kind: "user";
			source: "caller" | "owner";
			userId: string;
	  }
	| {
			kind: "tenant";
			tenantId: string;
	  };

export function buildCredentialResolutionTargets(args: {
	descopeTenantId: string;
	scope?: CredentialScope;
	preference?: CredentialPreference;
	callerUserId?: string;
	ownerUserId?: string | null;
	/** Whether the acting human owns the target organization. */
	actingUserOwnsOrganization?: boolean;
}): CredentialResolutionTarget[] {
	const scope = args.scope ?? "tenant";
	const userTargets: CredentialResolutionTarget[] = [];
	// A user-scoped connection is always the authenticated human's personal
	// credential. In particular, never substitute a Tedi owner's credential for
	// another human: doing so would let a guest execute an external call as that
	// owner. Hybrid keeps its explicit user-first opt-in for visiting operators.
	const callerPersonalAllowed =
		scope === "user" ||
		args.actingUserOwnsOrganization === true ||
		(scope === "hybrid" && args.preference === "user-first");
	if (args.callerUserId && callerPersonalAllowed) {
		userTargets.push({
			kind: "user",
			source: "caller",
			userId: args.callerUserId,
		});
	}
	if (
		args.ownerUserId &&
		// A Tedi may use its owner credential when there is no authenticated
		// human caller. Once a human is present, user scope is strictly theirs.
		!(scope === "user" && args.callerUserId) &&
		!userTargets.some(
			(target) => target.kind === "user" && target.userId === args.ownerUserId,
		)
	) {
		userTargets.push({
			kind: "user",
			source: "owner",
			userId: args.ownerUserId,
		});
	}
	const tenantTarget: CredentialResolutionTarget = {
		kind: "tenant",
		tenantId: args.descopeTenantId,
	};
	if (scope === "user") return userTargets;
	if (scope === "hybrid") {
		const effectivePreference =
			args.preference ??
			(args.actingUserOwnsOrganization === true
				? "user-first"
				: "tenant-first");
		return effectivePreference === "tenant-first"
			? [tenantTarget, ...userTargets]
			: [...userTargets, tenantTarget];
	}
	return [tenantTarget];
}

/** Suffixes that distinguish a credential-vault outbound app id from its base
 * provider name (e.g. `promptwatch-api-key` → base `promptwatch`). */

export /** Suffixes that distinguish a credential-vault outbound app id from its base
 * provider name (e.g. `promptwatch-api-key` → base `promptwatch`). */
const PROVIDER_CREDENTIAL_SUFFIX_RE =
	/-(?:db-api-key|api-key|api-token|pat-key|key|token)$/;

/** Connection labels are operator-config slugs — reject anything else so a
 * forwarded header can't be abused to probe arbitrary outbound app ids. */

export /** Connection labels are operator-config slugs — reject anything else so a
 * forwarded header can't be abused to probe arbitrary outbound app ids. */
const CONNECTION_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Candidate label-scoped provider (Descope outbound app) ids for a
 * `providerId` + connection label pair, in preference order.
 *
 * Labeled credentials are stored as project-specific outbound apps (see
 * `uploadTenantApiKeyToken` doc in `@tedix/auth/connections`): e.g. the
 * `promptwatch` provider keeps its default key under `promptwatch-api-key`
 * and per-project keys under `promptwatch-{project}`, such as
 * `promptwatch-tedix`. Given (providerId="promptwatch-api-key", label="tedix")
 * this returns ["promptwatch-tedix", "promptwatch-api-key-tedix"].
 *
 * Returns [] when there is no label, the label is malformed, or the
 * providerId already targets the labeled app (ends with `-{label}`).
 */

export /**
 * Candidate label-scoped provider (Descope outbound app) ids for a
 * `providerId` + connection label pair, in preference order.
 *
 * Labeled credentials are stored as project-specific outbound apps (see
 * `uploadTenantApiKeyToken` doc in `@tedix/auth/connections`): e.g. the
 * `promptwatch` provider keeps its default key under `promptwatch-api-key`
 * and per-project keys under `promptwatch-{project}`, such as
 * `promptwatch-tedix`. Given (providerId="promptwatch-api-key", label="tedix")
 * this returns ["promptwatch-tedix", "promptwatch-api-key-tedix"].
 *
 * Returns [] when there is no label, the label is malformed, or the
 * providerId already targets the labeled app (ends with `-{label}`).
 */
function buildLabeledProviderCandidates(
	providerId: string,
	label?: string,
): string[] {
	const normalized = label?.trim();
	if (!normalized || !CONNECTION_LABEL_RE.test(normalized)) return [];
	if (providerId === normalized || providerId.endsWith(`-${normalized}`)) {
		return [];
	}
	const candidates: string[] = [];
	const base = providerId.replace(PROVIDER_CREDENTIAL_SUFFIX_RE, "");
	if (base && base !== providerId) candidates.push(`${base}-${normalized}`);
	candidates.push(`${providerId}-${normalized}`);
	return candidates;
}

/**
 * Resolve a token preferring the label-scoped credential when a connection
 * label is provided. Falls back to the default (unlabeled) provider id —
 * with a warn — when no labeled credential exists, so providers without
 * per-label tokens keep working unchanged.
 */

export /**
 * Resolve a token preferring the label-scoped credential when a connection
 * label is provided. Falls back to the default (unlabeled) provider id —
 * with a warn — when no labeled credential exists, so providers without
 * per-label tokens keep working unchanged.
 */
async function resolveTokenPreferringLabel<T>(args: {
	providerId: string;
	label?: string;
	fetchTokenForProvider: (providerId: string) => Promise<T | null>;
}): Promise<T | null> {
	const labeledCandidates = buildLabeledProviderCandidates(
		args.providerId,
		args.label,
	);
	for (const candidate of labeledCandidates) {
		const token = await args.fetchTokenForProvider(candidate);
		if (token) return token;
	}
	if (labeledCandidates.length > 0) {
		console.warn(
			`[Connections] No labeled credential for provider=${args.providerId} label=${args.label} (tried: ${labeledCandidates.join(", ")}); falling back to default credential resolution`,
		);
	}
	return args.fetchTokenForProvider(args.providerId);
}

/**
 * Shared credential-resolution chain. Used by both fetchTediToken (optionally
 * including owner-personal lookup) and fetchOrgToken (skips owner step — for
 * human callers and orgs without a tedi).
 *
 * Scope behavior:
 *   - tenant: only tenant-scoped Descope Token Vault entry
 *   - user: org-owner caller and/or tedi-owner personal tokens; visitors excluded
 *   - hybrid: org owners default user-first; visitors default tenant-first
 *
 * Throws NOT_FOUND when nothing resolves. Returns plaintext token when found.

 *
 * Retired providers fail closed — but the D1 registry cannot be the test: many
 * referenced providers have no `connection_providers` row while being
 * perfectly live, so requiring registration would sever them. The authority is
 * Descope: an unregistered provider is allowed only while its outbound app
 * still exists. That closes the retirement hole — Descope keeps serving a
 * deleted app's tenant API-key token forever, with no delete path — and costs
 * one probe on the unregistered minority only.
 */

/**
 * Shared credential-resolution chain. Used by both fetchTediToken (optionally
 * including owner-personal lookup) and fetchOrgToken (skips owner step — for
 * human callers and orgs without a tedi).
 *
 * Scope behavior:
 *   - tenant: only tenant-scoped Descope Token Vault entry
 *   - user: only caller/owner personal Descope tokens
 *   - hybrid: caller/owner personal tokens first, then tenant-scoped token
 *
 * Throws NOT_FOUND when nothing resolves. Returns plaintext token when found.

 *
 * Retired providers fail closed — but the D1 registry cannot be the test: many
 * referenced providers have no `connection_providers` row while being
 * perfectly live, so requiring registration would sever them. The authority is
 * Descope: an unregistered provider is allowed only while its outbound app
 * still exists. That closes the retirement hole — Descope keeps serving a
 * deleted app's tenant API-key token forever, with no delete path — and costs
 * one probe on the unregistered minority only.
 */
export async function fetchNamedConnection(
	context: BaseContext,
	owner: { userId: string } | { organizationId: string; tenantId: string },
	providerId: string,
	instanceId: string,
	scopes?: string[],
	delegatedToolUse?: { appId: string; arguments: JsonValue } | "inventory",
	/** The person a live tool call reads for; checks their own provider access. */
	reader?: { userId: string | null },
) {
	const instance = await getConnectionInstance(
		context.db,
		owner,
		instanceId,
		providerId,
	);
	if (!instance) return null;
	if (context.tediId && "userId" in owner) {
		if (!context.organizationId)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Personal connection consumers require an organization",
			);
		await enforceConnectionConsumerGrants(context, {
			organizationId: context.organizationId,
			providerId,
			connectionInstanceId: instanceId,
			personalUserId: owner.userId,
		});
	}
	// Inventory consumes credential metadata internally; RPC inputs cannot select this mode.
	if (instance.allowedResources != null && delegatedToolUse !== "inventory") {
		const providerResourceId = await assertConnectionResourceArguments(
			context,
			instance,
			delegatedToolUse,
		);
		if (reader && "organizationId" in owner)
			await assertOwnAccessForToolCall(context, reader.userId, {
				organizationId: owner.organizationId,
				providerId,
				providerResourceId,
				connectionInstanceId: instance.id,
			});
	}
	const selection = {
		appId: providerId,
		externalIdentifier: `tedix_${instance.id}`,
		scopes,
	};
	const token =
		"userId" in owner
			? await fetchPersonalConnectionToken(context.env, {
					...selection,
					userId: owner.userId,
				})
			: await fetchNamedTenantConnectionToken(context.env, {
					...selection,
					tenantId: owner.tenantId,
				});
	if (!token)
		return "userId" in owner
			? fetchAdoptedDefaultConnection(context, owner.userId, instance, scopes)
			: null;
	// Vault presence is not activation: only ticket redemption may pin a new
	// personal grant, including a reconnect with the same provider subject.
	if ("userId" in owner && (!token.id || !instance.tokenIds.includes(token.id)))
		return null;
	if (instance.tokenSub && token.tokenSub !== instance.tokenSub)
		throw createError(
			ErrorCodes.CONFLICT,
			"This account slot was reconnected as a different external identity. Reconnect the original account or add a new slot.",
		);
	if (
		!instance.tokenIds.includes(token.id!) ||
		(!instance.tokenSub && token.tokenSub)
	) {
		const recorded = await recordConnectionGrant(context.db, {
			owner,
			providerId,
			id: instance.id,
			tokenId: token.id!,
			tokenSub: token.tokenSub,
		});
		if (!recorded.length)
			throw createError(
				ErrorCodes.CONFLICT,
				"Account identity changed during verification",
			);
	}
	return token;
}

/**
 * A slot adopted from the owner's unlabeled default login carries no vault
 * selector. It serves only the exact default grant pinned at adoption: same
 * Descope token id and provider subject. A reconnect mints a new grant and
 * fails closed until the owner adopts it again; nothing is recorded here.
 */
async function fetchAdoptedDefaultConnection(
	context: BaseContext,
	userId: string,
	instance: { providerId: string; tokenIds: string[]; tokenSub: string | null },
	scopes?: string[],
) {
	if (!instance.tokenSub || !instance.tokenIds.length) return null;
	const token = await fetchConnectionToken(
		getDescopeManagement(context.env, true),
		instance.providerId,
		userId,
	);
	if (
		!token?.id ||
		!instance.tokenIds.includes(token.id) ||
		token.tokenSub !== instance.tokenSub ||
		!(scopes ?? []).every((scope) => token.scopes?.includes(scope))
	)
		return null;
	return token;
}

/** Pin the owner's current default login into a new slot without a second OAuth round trip. */
export async function adoptDefaultPersonalConnection(
	context: BaseContext,
	input: { userId: string; providerId: string },
) {
	const token = await fetchConnectionToken(
		getDescopeManagement(context.env, true),
		input.providerId,
		input.userId,
	);
	if (!token?.id || !token.tokenSub)
		throw createError(
			ErrorCodes.NOT_FOUND,
			"No verified default account is connected for this provider",
		);
	return { tokenId: token.id, tokenSub: token.tokenSub };
}

/** Plain answer for a missing connection, with a link that starts connecting it. */
async function connectToUseMessage(
	context: BaseContext,
	input: {
		organizationId: string;
		providerId: string;
		appName?: string;
		personal: boolean;
	},
): Promise<string> {
	const app = input.appName || input.providerId;
	const org = await getOrganizationById(context.db, input.organizationId).catch(
		() => undefined,
	);
	if (!org?.slug)
		return `Connect ${app} to use this, in Settings → Connections.`;
	return `Connect ${app} to use this: ${tenantConnectionHandoffUrl({
		environment: context.env.ENVIRONMENT,
		organizationSlug: org.slug,
		providerId: input.providerId,
		personal: input.personal,
	})}`;
}

export async function resolveCredentialChain(
	context: BaseContext,
	args: {
		organizationId: string;
		descopeTenantId: string;
		providerId: string;
		scopes?: string[];
		scope?: CredentialScope;
		preference?: CredentialPreference;
		callerUserId?: string;
		ownerUserId?: string | null;
		/** Connection label — prefers the label-scoped credential when set. */
		label?: string;
		connectionInstanceId?: string;
		delegatedToolUse?: { appId: string; arguments: JsonValue };
	},
): Promise<{
	accessToken: string;
	expiresAt?: number;
	scopes?: string[];
}> {
	if (args.scope !== "user")
		await assertOrganizationConnectionResourceArguments(
			context,
			args.organizationId,
			args.providerId,
			args.delegatedToolUse,
		);
	const authorizedProviders = new Set<string>();
	const authorizeTenantProvider = async (providerId: string) => {
		if (authorizedProviders.has(providerId)) return;
		await enforceConnectionConsumerGrants(context, { ...args, providerId });
		authorizedProviders.add(providerId);
	};
	if ((args.scope ?? "tenant") === "tenant")
		await authorizeTenantProvider(args.providerId);
	if (args.connectionInstanceId && args.scope !== "user") {
		if (args.scope !== "tenant")
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Choose personal or organization scope for a named account",
			);
		const instance = await getConnectionInstance(
			context.db,
			{ organizationId: args.organizationId },
			args.connectionInstanceId,
			args.providerId,
		);
		if (!instance)
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Selected organization account not found",
			);
		if (instance.allowedResources != null)
			await assertConnectionResourceArguments(
				context,
				instance,
				args.delegatedToolUse,
			);
	}
	const registeredProvider = await getConnectionProviderByDescopeAppId(
		context.db,
		args.providerId,
	);
	if (!registeredProvider) {
		const stillLiveInDescope = await outboundAppExists(
			args.providerId,
			context.env,
		);
		if (!stillLiveInDescope) {
			console.warn(
				`[Connections] Refusing credentials for retired provider=${args.providerId} org=${args.organizationId} (no D1 registry row and no Descope outbound app)`,
			);
			throw createError(
				ErrorCodes.NOT_FOUND,
				`Connection provider ${args.providerId} has been retired. Its credentials are no longer served.`,
			);
		}
	}
	let actingUserOwnsOrganization = false;
	const actingUserId = args.callerUserId ?? args.ownerUserId ?? undefined;
	if (actingUserId && (args.scope === "user" || args.scope === "hybrid")) {
		try {
			const membership = await getMemberByUserId(
				context.db,
				args.organizationId,
				actingUserId,
			);
			actingUserOwnsOrganization =
				membership?.status === "active" && membership.role === "owner";
		} catch (error) {
			console.error(
				`[Connections] Credential ownership lookup failed for org=${args.organizationId}; applying tenant-safe precedence`,
				{ exception: safeExceptionTopology(error) },
			);
		}
	}
	const targets = buildCredentialResolutionTargets({
		...args,
		actingUserOwnsOrganization,
	});
	if (args.connectionInstanceId) {
		if (args.scope !== "user" && args.scope !== "tenant")
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Choose personal or organization scope for a named account",
			);
		for (const target of targets) {
			if (args.scope === "user" && target.kind !== "user") continue;
			if (args.scope === "tenant" && target.kind !== "tenant") continue;
			const owner =
				target.kind === "user"
					? { userId: target.userId }
					: {
							organizationId: args.organizationId,
							tenantId: args.descopeTenantId,
						};
			if (target.kind === "tenant")
				await authorizeTenantProvider(args.providerId);
			else
				await enforceConnectionConsumerGrants(context, {
					...args,
					personalUserId: target.userId,
				});
			const selected = await fetchNamedConnection(
				context,
				owner,
				args.providerId,
				args.connectionInstanceId,
				args.scopes,
				args.delegatedToolUse,
				args.delegatedToolUse && {
					userId:
						args.callerUserId ??
						context.gatewayEndUserId ??
						args.ownerUserId ??
						null,
				},
			);
			if (selected?.reconnectNeeded)
				throw createError(
					ErrorCodes.UNPROCESSABLE_CONTENT,
					`Reconnect ${args.providerId} in Settings → Connections`,
				);
			if (selected)
				return {
					accessToken: selected.accessToken,
					expiresAt: selected.expiresAt,
					scopes: selected.scopes,
				};
		}
		throw createError(
			ErrorCodes.NOT_FOUND,
			"Selected account is not connected or does not belong to this scope. Choose or connect that exact account.",
		);
	}
	let lookupFailure: ConnectionTokenLookupError | undefined;
	const fetchTokenForProvider = async (
		providerId: string,
	): Promise<Awaited<ReturnType<typeof fetchConnectionToken>> | null> => {
		let token: Awaited<ReturnType<typeof fetchConnectionToken>> | null = null;
		if (args.scope !== "user" && providerId !== args.providerId)
			await assertOrganizationConnectionResourceArguments(
				context,
				args.organizationId,
				providerId,
				args.delegatedToolUse,
			);
		for (const target of targets) {
			if (target.kind === "tenant") {
				await authorizeTenantProvider(args.providerId);
				if (providerId !== args.providerId)
					await authorizeTenantProvider(providerId);
			}
			if (target.kind === "user") {
				await enforceConnectionConsumerGrants(context, {
					...args,
					personalUserId: target.userId,
				});
				if (providerId !== args.providerId)
					await enforceConnectionConsumerGrants(context, {
						...args,
						providerId,
						personalUserId: target.userId,
					});
			}
			try {
				const client = getDescopeManagement(context.env, true);
				if (target.kind === "user") {
					token = args.scopes?.length
						? await fetchConnectionTokenByScopes(
								client,
								providerId,
								target.userId,
								args.scopes,
							)
						: await fetchConnectionToken(client, providerId, target.userId);
				} else {
					token = args.scopes?.length
						? await fetchTenantConnectionTokenByScopes(
								client,
								providerId,
								target.tenantId,
								args.scopes,
							)
						: await fetchTenantConnectionToken(
								client,
								providerId,
								target.tenantId,
							);
				}
			} catch (error) {
				lookupFailure =
					error instanceof ConnectionTokenLookupError
						? error
						: new ConnectionTokenLookupError();
			}
			if (token) break;
		}
		return token;
	};
	const token = await resolveTokenPreferringLabel({
		providerId: args.providerId,
		label: args.label,
		fetchTokenForProvider,
	});
	if (!token) {
		if (lookupFailure)
			throw createError(ErrorCodes.SERVICE_UNAVAILABLE, lookupFailure.message);
		throw createError(
			ErrorCodes.NOT_FOUND,
			await connectToUseMessage(context, {
				organizationId: args.organizationId,
				providerId: args.providerId,
				appName: registeredProvider?.name,
				personal: args.scope === "user",
			}),
		);
	}
	if (token.reconnectNeeded)
		throw createError(
			ErrorCodes.UNPROCESSABLE_CONTENT,
			`Reconnect ${args.providerId} in Settings → Connections`,
		);
	if (!token.accessToken) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Token retrieval succeeded but access token is empty. The connection may need to be re-established.",
		);
	}
	const expiresAt =
		typeof token.expiresAt === "number" && token.expiresAt > 0
			? token.expiresAt
			: typeof token.expiresAt === "string" && Number(token.expiresAt) > 0
				? Number(token.expiresAt)
				: undefined;
	return {
		accessToken: token.accessToken,
		expiresAt,
		scopes: token.scopes ?? undefined,
	};
}

/**
 * Org/user credential lookup — no tedi required.
 *
 * Use when the caller is a human user (or any non-tedi context) and the
 * resolution doesn't need the tedi-owner-personal hop (Step 2 of the full
 * chain). Required for orgs that haven't created a tedi yet — the previous
 * "find any tedi to use as proxy" hop fails for tedi-less orgs.
 */

export /**
 * ADR tedi-client-oauth-cimd phase 1a drift gate: compare the freshly
 * discovered authorization-server issuer against the issuer pinned on the
 * `connection_providers` row at first discovery. Drift → typed CONFLICT
 * refusal (fail closed, no re-provisioning). No row / NULL pin (legacy) →
 * pass-through; the caller pins after a successful provision.
 */
async function enforceConnectionProviderIssuerPin(input: {
	db: BaseContext["db"];
	providerId: string;
	discoveredIssuer: string;
}): Promise<void> {
	const pin = await getConnectionProviderIssuerPin(input.db, input.providerId);
	try {
		assertPinnedIssuerMatches({
			providerId: input.providerId,
			pinnedIssuer: pin?.pinnedIssuer ?? null,
			discoveredIssuer: input.discoveredIssuer,
		});
	} catch (error) {
		if (error instanceof IssuerPinDriftError) {
			console.error(
				`[Connections] issuer drift refused: provider=${error.providerId} pinned=${error.pinnedIssuer} discovered=${error.discoveredIssuer}`,
			);
			throw createError(ErrorCodes.CONFLICT, error.message);
		}
		throw error;
	}
}

/**
 * Create a Descope outbound app from an upstream MCP protected resource.
 *
 * This is the operator-friendly path for catalog MCP apps: callers provide the
 * upstream MCP URL or a catalog app selector.
 */
