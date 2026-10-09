import {
	HostDelegationSchema,
	type HostDelegation,
} from "@tedix/api-contract/schemas/host-delegation";
import * as jose from "jose";

const GATEWAY_BROWSER_TOKEN_TYPE = "tedix.gateway.browser";
const GATEWAY_BROWSER_TOKEN_ISSUER = "tedix:os";
const GATEWAY_BROWSER_TOKEN_AUDIENCE = "tedix:tedi-gateway";
const GATEWAY_BROWSER_TOKEN_SCOPE = "gateway:ws";

/**
 * A compact host-owned reference carried inside an embedded-session token.
 * It labels a conversation for the host product; it never grants Tedix or
 * host-tool authority by itself.
 */
export interface HostConversationContext {
	kind: string;
	reference: string;
	label?: string;
}

export interface SignedPortableRoute {
	id: string;
	pathname: string;
	routeKey?: string;
	params?: Record<string, string | number | boolean>;
	entity?: { type: string; id: string };
	/** Exact argument values derived from the provider server's route assertion. */
	bindings: Record<string, Record<string, string | number | boolean>>;
}

export function assertSignedPortableRouteCall(
	route: SignedPortableRoute,
	callable: string,
	args: Record<string, unknown>,
): void {
	const bound = route.bindings[callable];
	if (
		!bound ||
		Object.entries(bound).some(
			([argument, expected]) =>
				!Object.hasOwn(args, argument) || args[argument] !== expected,
		)
	)
		throw new GatewayBrowserTokenError(
			"Portable WebMCP route or target mismatch",
			"PORTABLE_ROUTE_MISMATCH",
		);
}

export interface GatewayBrowserTokenInput {
	allowedOrigin?: string;
	expiresAt: number;
	issuedAt?: number;
	secret: string;
	subject: string;
	sessionKey?: string;
	hostOrganizationId?: string;
	hostOrganizationLabel?: string;
	hostRole?: string;
	hostTenantArgument?: string;
	hostTenantNamespace?: string;
	hostUserId?: string;
	hostUserLabel?: string;
	providerAppId?: string;
	providerInstallationId?: string;
	hostDelegation?: HostDelegation;
	portableWebMcpCallables?: string[];
	portableRoute?: SignedPortableRoute;
	embeddedAssistantCallables?: string[];
	hostConversationContext?: HostConversationContext;
	/**
	 * Which product surface opened this session. The runtime reads it instead of
	 * inspecting `allowedOrigin`, so first-party behaviour is a stated property
	 * of the session rather than a hostname suffix.
	 */
	surface?: EmbeddedSessionSurface;
	/**
	 * The model this session routes at when the user picks nothing, resolved
	 * from D1 config and already checked against the model catalog. Signed so
	 * the runtime honours an operator's default without trusting the browser.
	 */
	defaultModelRef?: string;
	/**
	 * Per-hour embedded turn ceilings resolved from D1 config at mint. Absent
	 * means the runtime's platform default; the runtime never reads a limit
	 * from the browser.
	 */
	visitorTurnsPerHour?: number;
	originTurnsPerHour?: number;
	tediId: string;
	tenantId?: string | null;
}

/** `os` is the first-party console; every embedded host is `host`. */
export const EMBEDDED_SESSION_SURFACES = ["os", "host"] as const;
export type EmbeddedSessionSurface = (typeof EMBEDDED_SESSION_SURFACES)[number];

/**
 * A canonical `provider/model-id` ref, shape-checked only.
 *
 * WHAT the ref may be is decided from D1 config against the model-catalog
 * projection when the session is minted; signing it here is what stops a
 * browser from substituting one. This guard exists so a malformed claim cannot
 * reach the runtime, not to re-decide policy.
 */
function readModelRef(value: unknown): string | undefined {
	return typeof value === "string" &&
		/^[a-z0-9-]+\/[\w./@-]{1,120}$/i.test(value)
		? value
		: undefined;
}

/** A positive integer turn ceiling; anything else reads as "not configured". */
function readTurnLimit(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: undefined;
}

function readSurface(value: unknown): EmbeddedSessionSurface | undefined {
	return EMBEDDED_SESSION_SURFACES.includes(value as EmbeddedSessionSurface)
		? (value as EmbeddedSessionSurface)
		: undefined;
}

export interface GatewayBrowserTokenClaims {
	allowedOrigin?: string;
	exp: number;
	iat: number;
	iss: typeof GATEWAY_BROWSER_TOKEN_ISSUER;
	aud: typeof GATEWAY_BROWSER_TOKEN_AUDIENCE;
	scope: typeof GATEWAY_BROWSER_TOKEN_SCOPE;
	sub: string;
	sessionKey?: string;
	hostOrganizationId?: string;
	hostOrganizationLabel?: string;
	hostRole?: string;
	hostTenantArgument?: string;
	hostTenantNamespace?: string;
	hostUserId?: string;
	hostUserLabel?: string;
	providerAppId?: string;
	providerInstallationId?: string;
	hostDelegation?: HostDelegation;
	portableWebMcpCallables?: string[];
	portableRoute?: SignedPortableRoute;
	embeddedAssistantCallables?: string[];
	hostConversationContext?: HostConversationContext;
	surface?: EmbeddedSessionSurface;
	defaultModelRef?: string;
	visitorTurnsPerHour?: number;
	originTurnsPerHour?: number;
	tediId: string;
	tenantId?: string;
	typ: typeof GATEWAY_BROWSER_TOKEN_TYPE;
}

export class GatewayBrowserTokenError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "GatewayBrowserTokenError";
	}
}

function signingKey(secret: string): Uint8Array {
	if (!secret) {
		throw new GatewayBrowserTokenError(
			"Gateway browser token secret is required",
			"MISSING_SECRET",
		);
	}
	return new TextEncoder().encode(secret);
}

export async function issueGatewayBrowserToken(
	input: GatewayBrowserTokenInput,
): Promise<string> {
	const now = input.issuedAt ?? Math.floor(Date.now() / 1000);
	const payload: Record<string, unknown> = {
		scope: GATEWAY_BROWSER_TOKEN_SCOPE,
		tediId: input.tediId,
		typ: GATEWAY_BROWSER_TOKEN_TYPE,
	};
	if (input.allowedOrigin) payload.allowedOrigin = input.allowedOrigin;
	if (input.sessionKey) payload.sessionKey = input.sessionKey;
	if (input.hostOrganizationId)
		payload.hostOrganizationId = input.hostOrganizationId;
	if (input.hostOrganizationLabel)
		payload.hostOrganizationLabel = input.hostOrganizationLabel;
	if (input.hostRole) payload.hostRole = input.hostRole;
	if (input.hostTenantArgument)
		payload.hostTenantArgument = input.hostTenantArgument;
	if (input.hostTenantNamespace)
		payload.hostTenantNamespace = input.hostTenantNamespace;
	if (input.hostUserId) payload.hostUserId = input.hostUserId;
	if (input.hostUserLabel) payload.hostUserLabel = input.hostUserLabel;
	if (input.providerAppId) payload.providerAppId = input.providerAppId;
	if (input.providerInstallationId)
		payload.providerInstallationId = input.providerInstallationId;
	if (input.portableWebMcpCallables?.length)
		payload.portableWebMcpCallables = input.portableWebMcpCallables;
	if (input.portableRoute) payload.portableRoute = input.portableRoute;
	if (input.embeddedAssistantCallables?.length)
		payload.embeddedAssistantCallables = input.embeddedAssistantCallables;
	if (input.hostConversationContext)
		payload.hostConversationContext = input.hostConversationContext;
	if (input.surface) payload.surface = input.surface;
	if (readModelRef(input.defaultModelRef))
		payload.defaultModelRef = input.defaultModelRef;
	if (readTurnLimit(input.visitorTurnsPerHour))
		payload.visitorTurnsPerHour = input.visitorTurnsPerHour;
	if (readTurnLimit(input.originTurnsPerHour))
		payload.originTurnsPerHour = input.originTurnsPerHour;
	if (input.tenantId) payload.tenantId = input.tenantId;
	if (input.hostDelegation) {
		const delegation = HostDelegationSchema.parse(input.hostDelegation);
		if (delegation.expiresAt <= now || input.expiresAt > delegation.expiresAt)
			throw new GatewayBrowserTokenError(
				"Invalid delegation expiry",
				"INVALID_DELEGATION",
			);
		payload.hostDelegation = delegation;
	}

	return new jose.SignJWT(payload)
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setIssuer(GATEWAY_BROWSER_TOKEN_ISSUER)
		.setAudience(GATEWAY_BROWSER_TOKEN_AUDIENCE)
		.setSubject(input.subject)
		.setIssuedAt(now)
		.setExpirationTime(input.expiresAt)
		.sign(signingKey(input.secret));
}

export async function verifyGatewayBrowserToken(
	token: string,
	options: {
		expectedTediId: string;
		expectedTenantId?: string | null;
		secret: string;
	},
): Promise<GatewayBrowserTokenClaims> {
	try {
		const result = await jose.jwtVerify(token, signingKey(options.secret), {
			audience: GATEWAY_BROWSER_TOKEN_AUDIENCE,
			issuer: GATEWAY_BROWSER_TOKEN_ISSUER,
		});
		const payload = result.payload as Record<string, unknown>;
		const claims = normalizeGatewayBrowserClaims(payload);

		if (claims.tediId !== options.expectedTediId) {
			throw new GatewayBrowserTokenError(
				"Gateway browser token tedi scope mismatch",
				"TEDI_SCOPE_MISMATCH",
			);
		}
		if (
			options.expectedTenantId &&
			claims.tenantId !== options.expectedTenantId
		) {
			throw new GatewayBrowserTokenError(
				"Gateway browser token tenant scope mismatch",
				"TENANT_SCOPE_MISMATCH",
			);
		}

		return claims;
	} catch (error) {
		if (error instanceof GatewayBrowserTokenError) throw error;
		throw new GatewayBrowserTokenError(
			"Gateway browser token validation failed",
			"VALIDATION_FAILED",
			error,
		);
	}
}

/** Decode only to select the expected Tedi scope; signature verification follows. */
export async function verifyOsPortableBrowserToken(
	token: string,
	secret: string,
): Promise<GatewayBrowserTokenClaims> {
	let tediId: unknown;
	try {
		tediId = jose.decodeJwt(token).tediId;
	} catch {
		throw new GatewayBrowserTokenError(
			"Invalid portable capability",
			"VALIDATION_FAILED",
		);
	}
	if (typeof tediId !== "string" || !/^[0-9a-f-]{36}$/i.test(tediId))
		throw new GatewayBrowserTokenError(
			"Invalid portable Tedi scope",
			"TEDI_SCOPE_MISMATCH",
		);
	return verifyGatewayBrowserToken(token, { expectedTediId: tediId, secret });
}

function normalizeGatewayBrowserClaims(
	payload: Record<string, unknown>,
): GatewayBrowserTokenClaims {
	if (payload.typ !== GATEWAY_BROWSER_TOKEN_TYPE) {
		throw new GatewayBrowserTokenError(
			"Gateway browser token type mismatch",
			"TYPE_MISMATCH",
		);
	}
	if (payload.scope !== GATEWAY_BROWSER_TOKEN_SCOPE) {
		throw new GatewayBrowserTokenError(
			"Gateway browser token scope mismatch",
			"SCOPE_MISMATCH",
		);
	}
	if (typeof payload.sub !== "string" || !payload.sub) {
		throw new GatewayBrowserTokenError(
			"Gateway browser token is missing subject",
			"MISSING_SUBJECT",
		);
	}
	if (typeof payload.tediId !== "string" || !payload.tediId) {
		throw new GatewayBrowserTokenError(
			"Gateway browser token is missing tedi scope",
			"MISSING_TEDI_SCOPE",
		);
	}
	if (typeof payload.exp !== "number" || typeof payload.iat !== "number") {
		throw new GatewayBrowserTokenError(
			"Gateway browser token is missing timestamps",
			"MISSING_TIMESTAMPS",
		);
	}

	const hostDelegation =
		payload.hostDelegation === undefined
			? undefined
			: HostDelegationSchema.parse(payload.hostDelegation);
	if (
		hostDelegation &&
		(hostDelegation.expiresAt < payload.exp ||
			hostDelegation.expiresAt <= Math.floor(Date.now() / 1000))
	)
		throw new GatewayBrowserTokenError(
			"Invalid delegation expiry",
			"INVALID_DELEGATION",
		);
	const portableRoute = readPortableRoute(payload.portableRoute);
	return {
		...(hostDelegation ? { hostDelegation } : {}),
		...(typeof payload.allowedOrigin === "string"
			? { allowedOrigin: payload.allowedOrigin }
			: {}),
		aud: GATEWAY_BROWSER_TOKEN_AUDIENCE,
		exp: payload.exp,
		iat: payload.iat,
		iss: GATEWAY_BROWSER_TOKEN_ISSUER,
		scope: GATEWAY_BROWSER_TOKEN_SCOPE,
		sub: payload.sub,
		...(typeof payload.sessionKey === "string"
			? { sessionKey: payload.sessionKey }
			: {}),
		...(typeof payload.hostOrganizationId === "string"
			? { hostOrganizationId: payload.hostOrganizationId }
			: {}),
		...(typeof payload.hostOrganizationLabel === "string"
			? { hostOrganizationLabel: payload.hostOrganizationLabel }
			: {}),
		...(typeof payload.hostRole === "string"
			? { hostRole: payload.hostRole }
			: {}),
		...(typeof payload.hostTenantArgument === "string"
			? { hostTenantArgument: payload.hostTenantArgument }
			: {}),
		...(typeof payload.hostTenantNamespace === "string"
			? { hostTenantNamespace: payload.hostTenantNamespace }
			: {}),
		...(typeof payload.hostUserId === "string"
			? { hostUserId: payload.hostUserId }
			: {}),
		...(typeof payload.hostUserLabel === "string"
			? { hostUserLabel: payload.hostUserLabel }
			: {}),
		...(typeof payload.providerAppId === "string"
			? { providerAppId: payload.providerAppId }
			: {}),
		...(typeof payload.providerInstallationId === "string"
			? { providerInstallationId: payload.providerInstallationId }
			: {}),
		...(Array.isArray(payload.portableWebMcpCallables) &&
		payload.portableWebMcpCallables.length <= 100 &&
		payload.portableWebMcpCallables.every(
			(value) =>
				typeof value === "string" &&
				/^[a-z][a-z0-9_]{1,127}\.[a-z][a-z0-9_]{1,127}$/.test(value),
		)
			? { portableWebMcpCallables: payload.portableWebMcpCallables as string[] }
			: {}),
		...(portableRoute ? { portableRoute } : {}),
		...(Array.isArray(payload.embeddedAssistantCallables) &&
		payload.embeddedAssistantCallables.length <= 100 &&
		payload.embeddedAssistantCallables.every(
			(value) =>
				typeof value === "string" &&
				/^[a-z][a-z0-9_]{1,127}\.[a-z][a-z0-9_]{1,127}$/.test(value),
		)
			? {
					embeddedAssistantCallables:
						payload.embeddedAssistantCallables as string[],
				}
			: {}),
		...(isHostConversationContext(payload.hostConversationContext)
			? { hostConversationContext: payload.hostConversationContext }
			: {}),
		// An unknown or absent surface reads as `host`: the conservative default,
		// and what every token minted before this claim existed means.
		...(readSurface(payload.surface)
			? { surface: readSurface(payload.surface) }
			: {}),
		// Absent on every token minted before this claim existed, which reads as
		// "no configured default" and leaves the tedi's own model in charge.
		...(readModelRef(payload.defaultModelRef)
			? { defaultModelRef: payload.defaultModelRef as string }
			: {}),
		// Absent on tokens minted before these claims existed: the runtime then
		// applies its platform default rather than skipping the quota.
		...(readTurnLimit(payload.visitorTurnsPerHour)
			? { visitorTurnsPerHour: payload.visitorTurnsPerHour as number }
			: {}),
		...(readTurnLimit(payload.originTurnsPerHour)
			? { originTurnsPerHour: payload.originTurnsPerHour as number }
			: {}),
		tediId: payload.tediId,
		...(typeof payload.tenantId === "string"
			? { tenantId: payload.tenantId }
			: {}),
		typ: GATEWAY_BROWSER_TOKEN_TYPE,
	};
}

function readPortableRoute(value: unknown): SignedPortableRoute | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new GatewayBrowserTokenError(
			"Invalid portable route claim",
			"INVALID_PORTABLE_ROUTE",
		);
	const route = value as Record<string, unknown>;
	if (
		typeof route.id !== "string" ||
		!/^[a-z][a-z0-9_-]{0,79}$/.test(route.id) ||
		typeof route.pathname !== "string" ||
		!route.pathname.startsWith("/") ||
		route.pathname.startsWith("//") ||
		route.pathname.includes("?") ||
		route.pathname.length > 500 ||
		(route.routeKey !== undefined &&
			(typeof route.routeKey !== "string" || route.routeKey.length > 120)) ||
		!route.bindings ||
		typeof route.bindings !== "object" ||
		Array.isArray(route.bindings)
	)
		throw new GatewayBrowserTokenError(
			"Invalid portable route claim",
			"INVALID_PORTABLE_ROUTE",
		);
	if (route.entity !== undefined) {
		const entity = route.entity as Record<string, unknown>;
		if (
			!entity ||
			typeof entity !== "object" ||
			Array.isArray(entity) ||
			typeof entity.type !== "string" ||
			!/^[A-Za-z0-9_.:-]{1,64}$/.test(entity.type) ||
			typeof entity.id !== "string" ||
			!/^[A-Za-z0-9_.:-]{1,128}$/.test(entity.id)
		)
			throw new GatewayBrowserTokenError(
				"Invalid portable route target",
				"INVALID_PORTABLE_ROUTE",
			);
	}
	if (route.params !== undefined) {
		if (
			!route.params ||
			typeof route.params !== "object" ||
			Array.isArray(route.params) ||
			Object.keys(route.params).length > 24 ||
			Object.entries(route.params).some(
				([key, item]) =>
					!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) ||
					(typeof item !== "string" &&
						typeof item !== "number" &&
						typeof item !== "boolean") ||
					(typeof item === "string" && item.length > 200) ||
					(typeof item === "number" && !Number.isFinite(item)),
			)
		)
			throw new GatewayBrowserTokenError(
				"Invalid portable route parameters",
				"INVALID_PORTABLE_ROUTE",
			);
	}
	const entries = Object.entries(route.bindings);
	if (
		entries.length > 100 ||
		entries.some(
			([callable, args]) =>
				!/^[a-z][a-z0-9_]{1,127}\.[a-z][a-z0-9_]{1,127}$/.test(callable) ||
				!args ||
				typeof args !== "object" ||
				Array.isArray(args) ||
				Object.keys(args).length > 50 ||
				Object.entries(args).some(
					([key, item]) =>
						!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key) ||
						!["string", "number", "boolean"].includes(typeof item) ||
						(typeof item === "number" && !Number.isFinite(item)),
				),
		)
	)
		throw new GatewayBrowserTokenError(
			"Invalid portable route bindings",
			"INVALID_PORTABLE_ROUTE",
		);
	return route as unknown as SignedPortableRoute;
}

function isHostConversationContext(
	value: unknown,
): value is HostConversationContext {
	if (!value || typeof value !== "object") return false;
	const context = value as Record<string, unknown>;
	return (
		typeof context.kind === "string" &&
		/^[a-z][a-z0-9_]{1,63}$/.test(context.kind) &&
		typeof context.reference === "string" &&
		context.reference.length > 0 &&
		context.reference.length <= 200 &&
		(context.label === undefined ||
			(typeof context.label === "string" && context.label.length <= 300))
	);
}
