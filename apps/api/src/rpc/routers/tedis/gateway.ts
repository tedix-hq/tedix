import { resolveEmbeddedTediSelection } from "../../../services/embedded-tedi-selection";
import { buildModelCatalogProjection } from "../../../services/model-catalog-projection";
import { resolveQuickChatDefaultRef } from "../../../services/embedded-model-default";
import type { EmbeddedModelSelection } from "@tedix/api-contract/schemas/embedded-widget-access";
import type { HostDelegation } from "@tedix/api-contract/schemas/host-delegation";
/**
 * Tedis Router - runtime messaging and peer discovery.
 */

import { injectAgentMessage, listTediPeers } from "@tedix/provisioning";
import {
	type EmbeddedSessionSurface,
	type SignedPortableRoute,
	assertSignedPortableRouteCall,
	issueGatewayBrowserToken,
	verifyOsPortableBrowserToken,
} from "@tedix/auth/gateway-browser-token";
import {
	getOrganizationByDescopeId,
	getOrganizationById,
} from "@tedix/db/queries/organizations";
import { validateToken } from "@tedix/auth/jwt";
import { resolveProductSession } from "@tedix/auth/product-session-broker";
import { requireWorkspace } from "../os-workspaces-shared";
import type { Tedi } from "@tedix/db/schema/tedis";
import type { BaseContext } from "../../orpc";
import type { PortableWebMcpProfile } from "@tedix/api-contract/schemas/portable-webmcp";
import { resolveProviderRouteAssertion } from "../../../services/portable-webmcp-profile";
import {
	AUTHZ,
	authedTedisOs,
	createError,
	ErrorCodes,
	getProvisioningConfig,
	requireTediAccess,
	sanitizeProvisioningError,
	tedisOs,
	withServiceAuth,
} from "./helpers";

// =============================================================================
// PEER COMMUNICATION
// =============================================================================

export const listPeersProcedure = authedTedisOs.listPeers
	.use(AUTHZ.tedisAppsRead)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const provConfig = getProvisioningConfig(tedi, context.env);
		if (!provConfig) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Tedi runtime route is not configured",
			);
		}

		try {
			return await listTediPeers(provConfig);
		} catch (error) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				sanitizeProvisioningError(error),
			);
		}
	});

// =============================================================================
// MESSAGING
// =============================================================================

export const sendMessageProcedure = authedTedisOs.sendMessage
	.use(AUTHZ.tedisAppsWrite)
	.handler(async ({ input, context }) => {
		const tedi = await requireTediAccess(context, input.tediId);
		const provConfig = getProvisioningConfig(tedi, context.env);
		if (!provConfig) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Tedi runtime route is not configured",
			);
		}

		try {
			const result = await injectAgentMessage(provConfig, {
				message: input.message,
				session: input.session,
			});
			return {
				success: result.success,
				error: result.error,
				runId: result.run_id,
				sessionKey: result.session_key,
				assistant: result.assistant,
			};
		} catch (error) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				sanitizeProvisioningError(error),
			);
		}
	});

const EMBEDDED_SESSION_TTL_SECONDS = 10 * 60;

export function portableSessionCallables(
	profile: PortableWebMcpProfile | undefined,
	portableRoute?: SignedPortableRoute,
): { portable: string[] | undefined; assistant: string[] | undefined } {
	if (!profile) return { portable: undefined, assistant: undefined };
	const targetedRoute =
		Boolean(portableRoute?.entity) ||
		Boolean(
			portableRoute &&
			profile.routes.some((route) =>
				/(?:^|\/)[:*]/.test(route.match.pathname ?? ""),
			),
		) ||
		Object.values(portableRoute?.bindings ?? {}).some(
			(argumentsForTool) => Object.keys(argumentsForTool).length > 0,
		);
	return {
		portable: [
			...new Set(
				profile.routes.flatMap((route) =>
					route.tools.flatMap((tool) => [
						tool.callable,
						...(tool.action
							? [
									tool.action.prepareCallable,
									tool.action.convergeCallable,
								].filter((value): value is string => Boolean(value))
							: []),
					]),
				),
			),
		],
		assistant: [
			...new Set(
				profile.routes.flatMap((route) =>
					route.tools
						.filter(
							(tool) =>
								tool.annotations.readOnlyHint &&
								// The model-loop constraint is callable-wide; it cannot enforce
								// per-callable route targets. A targeted route stays browser-only.
								!targetedRoute &&
								(!portableRoute ||
									Object.keys(portableRoute.bindings[tool.callable] ?? {})
										.length === 0),
						)
						.map((tool) => tool.callable),
				),
			),
		],
	};
}

/**
 * The model roster an OS widget session may offer.
 *
 * Read through `buildModelCatalogProjection` — the same helper the enforcing
 * path and the OS model picker read — so the widget can never list a model that
 * admission would deny. Only `allowed` entries cross the boundary.
 *
 * `defaultRef` is deliberately null: on the OS surface the runtime edge applies
 * its own quick-chat default when the user picks nothing, and that value is a
 * runtime Worker var this Worker cannot read. Asserting a ref here would state
 * something the runtime does not honour, so the widget renders "automatic"
 * instead of a model name it cannot stand behind.
 *
 * Fail-soft: a projection error costs the picker, never the session.
 */
async function resolveEmbeddedModelSelection(
	context: BaseContext,
	tedi: Tedi,
	configuredDefaultRef?: string,
): Promise<EmbeddedModelSelection | undefined> {
	try {
		const projection = await buildModelCatalogProjection({
			db: context.db,
			env: context.env,
			organizationId: tedi.organizationId,
			tedi,
			includeDenied: false,
		});
		const models = projection.models
			.filter((model) => model.allowed)
			.map((model) => ({
				ref: model.ref,
				label: model.label,
				reasoning: model.reasoning,
			}));
		if (models.length === 0) return undefined;
		// Operator config first, the tedi's own resolved chat model second, and
		// EITHER only if the catalog still allows it. A default that survives this
		// check cannot be a model the tedi may not route at — which is exactly what
		// the old hardcoded Workers AI pin was (`runtime_provider_unsupported`).
		const defaultRef = resolveQuickChatDefaultRef({
			allowedRefs: models.map((model) => model.ref),
			configuredRef: configuredDefaultRef,
			routedRef: projection.routing?.modelRef,
		});
		if (configuredDefaultRef && defaultRef !== configuredDefaultRef)
			console.warn(
				`[embedded-session] configured quick-chat default is not routable for tedi ${tedi.id}; falling back`,
			);
		return {
			defaultRef,
			models: models.slice(0, 50),
			efforts: ["none", "low", "medium", "high"],
		};
	} catch (error) {
		console.error(
			"[embedded-session] model roster unavailable:",
			error instanceof Error ? error.message : String(error),
		);
		return undefined;
	}
}

export const createEmbeddedSessionProcedure =
	authedTedisOs.createEmbeddedSession
		.use(AUTHZ.tedisAppsWrite)
		.handler(async ({ input, context }) => {
			const tedi = await requireTediAccess(context, input.tediId);
			if (input.surface !== "os") {
				if (input.portableRouteAssertion)
					throw createError(
						ErrorCodes.FORBIDDEN,
						"First-party route assertion requires OS session",
					);
				return issueEmbeddedSession(context, tedi, input);
			}
			const organization = await getOrganizationById(
				context.db,
				tedi.organizationId,
			);
			let assertedRoute: SignedPortableRoute | undefined;
			if (input.portableRouteAssertion) {
				assertedRoute =
					resolveOsPortableRoute({
						assertion: input.portableRouteAssertion,
						profile: organization?.metadata?.tediWidget?.webMcpProfile,
						organizationSlug: organization?.slug,
						allowedOrigin: input.allowedOrigin,
						hostOrganizationId: input.hostOrganizationId,
						contextOrganizationId: context.organizationId,
						tediOrganizationId: tedi.organizationId,
						userSub: context.user?.sub,
					}) ?? undefined;
				if (!assertedRoute)
					throw createError(
						ErrorCodes.FORBIDDEN,
						"First-party route is unavailable or outside its organization",
					);
			}
			const { tediSelection } = await resolveEmbeddedTediSelection(
				context,
				tedi.organizationId,
				organization?.metadata?.tediWidget?.tediSelection,
				tedi.id,
			);
			// Resolve BEFORE minting: the surviving default is signed into the
			// session, so the runtime honours an operator's choice without the
			// browser being able to substitute one.
			const modelSelection = await resolveEmbeddedModelSelection(
				context,
				tedi,
				organization?.metadata?.tediWidget?.defaultModelRef,
			);
			return {
				...(await issueEmbeddedSession(context, tedi, {
					...input,
					...(assertedRoute
						? {
								hostUserId: context.user!.sub,
								portableRoute: assertedRoute,
							}
						: {}),
					...(modelSelection?.defaultRef
						? { defaultModelRef: modelSelection.defaultRef }
						: {}),
				})),
				tediSelection,
				modelSelection,
			};
		});

export function resolveOsPortableRoute(input: {
	assertion: { routeId: string; pathname: string; routeKey: string };
	profile?: PortableWebMcpProfile;
	organizationSlug?: string;
	allowedOrigin: string;
	hostOrganizationId: string;
	contextOrganizationId?: string | null;
	tediOrganizationId: string;
	userSub?: string;
}): SignedPortableRoute | null {
	if (
		!input.userSub ||
		!input.contextOrganizationId ||
		input.contextOrganizationId !== input.tediOrganizationId ||
		input.hostOrganizationId !== input.tediOrganizationId ||
		!input.organizationSlug ||
		input.allowedOrigin !== `https://${input.organizationSlug}.os.tedix.dev` ||
		input.assertion.pathname !== "/workspaces" ||
		input.assertion.routeKey !== "workspaces"
	)
		return null;
	const selected = resolveProviderRouteAssertion(
		input.profile,
		input.assertion,
	);
	if (
		!selected ||
		selected.profile.routes[0]?.match.routeKey !== "workspaces" ||
		selected.signedRoute.entity ||
		selected.signedRoute.params ||
		Object.values(selected.signedRoute.bindings).some(
			(bound) => Object.keys(bound).length > 0,
		)
	)
		return null;
	return selected.signedRoute;
}

/** The OS relay asks API to verify this HMAC capability before forwarding an exact callable. */
export const authorizeOsPortableCallProcedure = tedisOs.authorizeOsPortableCall
	.use(withServiceAuth)
	.handler(async ({ input, context }) => {
		const tenantId = context.headers.get("X-Tedix-Tenant-Id");
		if (!tenantId || !context.env.SECRETS_MASTER_KEY)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"First-party portable call requires the OS service binding",
			);
		const organization = await getOrganizationByDescopeId(context.db, tenantId);
		const userSub = await verifyOsPortableUserSession({
			cookie: context.headers.get("Cookie"),
			projectId: context.env.DESCOPE_PROJECT_ID,
			baseUrl: context.env.DESCOPE_BASE_URL,
			descopeTenantId: organization?.descopeTenantId ?? null,
		});
		if (
			!userSub ||
			!organization ||
			!(await verifyOsPortableCallCapability(input, {
				secret: context.env.SECRETS_MASTER_KEY,
				organizationId: organization.id,
				userSub,
			}))
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"First-party portable route mismatch",
			);
		return { authorized: true as const };
	});

/** Revalidate the forwarded browser session; service-binding auth has no user principal. */
export async function verifyOsPortableUserSession(
	input: {
		cookie: string | null;
		projectId: string | undefined;
		baseUrl: string | undefined;
		descopeTenantId: string | null;
	},
	verify: typeof validateToken = validateToken,
): Promise<string | null> {
	const token = resolveProductSession(input.cookie, "DS");
	if (!token || !input.projectId || !input.descopeTenantId) return null;
	try {
		const claims = await verify(token, {
			projectId: input.projectId,
			baseUrl: input.baseUrl,
		});
		return typeof claims.sub === "string" &&
			claims.sub.length > 0 &&
			claims.dct === input.descopeTenantId
			? claims.sub
			: null;
	} catch {
		return null;
	}
}

export async function verifyOsPortableCallCapability(
	input: {
		token: string;
		routeId: string;
		callable: string;
		args: Record<string, unknown>;
		origin: string;
		refererPathname: string;
	},
	expected: { secret: string; organizationId: string; userSub: string },
): Promise<boolean> {
	try {
		const claims = await verifyOsPortableBrowserToken(
			input.token,
			expected.secret,
		);
		if (
			claims.surface !== "os" ||
			claims.providerInstallationId ||
			claims.hostOrganizationId !== expected.organizationId ||
			claims.hostUserId !== expected.userSub ||
			claims.allowedOrigin !== input.origin ||
			claims.portableRoute?.id !== input.routeId ||
			claims.portableRoute.pathname !== input.refererPathname ||
			!claims.portableWebMcpCallables?.includes(input.callable)
		)
			return false;
		assertSignedPortableRouteCall(
			claims.portableRoute,
			input.callable,
			input.args,
		);
		return true;
	} catch {
		return false;
	}
}

export async function issueEmbeddedSession(
	context: BaseContext,
	tedi: Tedi,
	input: {
		allowedOrigin: string;
		conversationId: string;
		hostOrganizationId: string;
		hostOrganizationLabel?: string;
		hostRole?: string;
		hostTenantArgument?: string;
		hostTenantNamespace?: string;
		hostUserId: string;
		hostUserLabel?: string;
		providerAppId?: string;
		providerInstallationId?: string;
		hostConversationContext?: {
			kind: string;
			reference: string;
			label?: string;
		};
		webMcpProfile?: PortableWebMcpProfile;
		portableRoute?: SignedPortableRoute;
		hostDelegation?: HostDelegation;
		surface?: EmbeddedSessionSurface;
		/** Catalog-checked quick-chat default, signed into the session. */
		defaultModelRef?: string;
	},
) {
	// The tenant fence is all-or-nothing. Leaving one field out used to produce
	// an unfenced session that looked fenced at the call site, so a partial
	// fence is refused rather than silently downgraded. `hostOrganizationId`
	// identifies every session, fenced or not, and is required to pin one.
	const fencing = Boolean(
		input.hostTenantNamespace || input.hostTenantArgument,
	);
	if (
		fencing &&
		!(
			input.hostTenantNamespace &&
			input.hostTenantArgument &&
			input.hostOrganizationId
		)
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"A tenant-fenced embedded session requires hostTenantNamespace, hostTenantArgument and hostOrganizationId together",
		);
	const secret = context.env.SECRETS_MASTER_KEY;
	if (!secret) {
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Embedded Tedi sessions are not configured",
		);
	}
	const organization = await getOrganizationById(
		context.db,
		tedi.organizationId,
	);
	if (!organization) {
		throw createError(ErrorCodes.BAD_REQUEST, "Tedi organization is missing");
	}
	// OS workspace context is the one first-party reference this API can verify
	// itself. Other host kinds stay opaque, signed context: platform authority
	// remains the origin/org/user claims and never this display reference.
	if (input.hostConversationContext?.kind === "tedix_workspace") {
		await requireWorkspace(context, input.hostConversationContext.reference);
	}
	const runtime = getProvisioningConfig(tedi, context.env);
	if (!runtime) {
		throw createError(
			ErrorCodes.SERVICE_UNAVAILABLE,
			"Tedi runtime route is not configured",
		);
	}
	const sessionKey = `embed:${await digestEmbeddedIdentity(
		secret,
		`${tedi.id}:${input.hostOrganizationId}:${input.hostUserId}:${input.conversationId}`,
	)}`;
	const actorCacheKey = await embeddedActorCacheKey(secret, {
		allowedOrigin: input.allowedOrigin,
		hostOrganizationId: input.hostOrganizationId,
		hostUserId: input.hostUserId,
		tediId: tedi.id,
	});
	const expiresAtSeconds = Math.min(
		Math.floor(Date.now() / 1000) + EMBEDDED_SESSION_TTL_SECONDS,
		input.hostDelegation?.expiresAt ?? Infinity,
	);
	if (expiresAtSeconds <= Math.floor(Date.now() / 1000))
		throw createError(ErrorCodes.BAD_REQUEST, "Host delegation has expired");
	const availableWebMcpProfile =
		input.webMcpProfile ?? organization.metadata?.tediWidget?.webMcpProfile;
	const webMcpProfile = input.portableRoute
		? availableWebMcpProfile && {
				...availableWebMcpProfile,
				routes: availableWebMcpProfile.routes.filter(
					(route) => route.id === input.portableRoute?.id,
				),
			}
		: availableWebMcpProfile;
	if (input.portableRoute && webMcpProfile?.routes.length !== 1)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Asserted provider route is unavailable",
		);
	const portableCallables = portableSessionCallables(
		webMcpProfile,
		input.portableRoute,
	);
	const token = await issueGatewayBrowserToken({
		allowedOrigin: input.allowedOrigin,
		expiresAt: expiresAtSeconds,
		hostDelegation: input.hostDelegation,
		secret,
		sessionKey,
		subject: `host:${input.hostUserId}`,
		hostOrganizationId: input.hostOrganizationId,
		hostOrganizationLabel: input.hostOrganizationLabel,
		hostRole: input.hostRole,
		hostTenantArgument: input.hostTenantArgument,
		hostTenantNamespace: input.hostTenantNamespace,
		hostUserId: input.hostUserId,
		hostUserLabel: input.hostUserLabel,
		providerAppId: input.providerAppId,
		providerInstallationId: input.providerInstallationId,
		defaultModelRef: input.defaultModelRef,
		portableWebMcpCallables: portableCallables.portable,
		portableRoute: input.portableRoute,
		embeddedAssistantCallables: portableCallables.assistant,
		hostConversationContext: input.hostConversationContext,
		surface: input.surface,
		tediId: tedi.id,
		tenantId: organization.descopeTenantId,
	});
	return {
		token,
		expiresAt: expiresAtSeconds * 1000,
		actorCacheKey,
		sessionKey,
		streamUrl: `${runtime.workerUrl}/chat/stream`,
		...(input.hostRole ? { hostRole: input.hostRole } : {}),
		...(webMcpProfile ? { webMcpProfile } : {}),
		...(input.portableRoute ? { portableRoute: input.portableRoute } : {}),
	};
}

export async function embeddedActorCacheKey(
	secret: string,
	identity: {
		allowedOrigin: string;
		hostOrganizationId: string;
		hostUserId: string;
		tediId: string;
	},
): Promise<string> {
	return `actor:${await digestEmbeddedIdentity(
		secret,
		JSON.stringify([
			identity.tediId,
			identity.hostOrganizationId,
			identity.hostUserId,
			identity.allowedOrigin,
		]),
	)}`;
}

async function digestEmbeddedIdentity(
	secret: string,
	value: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(value),
	);
	return btoa(String.fromCharCode(...new Uint8Array(signature)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "")
		.slice(0, 32);
}
