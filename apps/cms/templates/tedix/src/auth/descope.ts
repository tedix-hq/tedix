/**
 * Tedix Emdash Descope authentication adapter.
 *
 * Transparent Descope authentication for Emdash CMS.
 * Implements Emdash's AuthProviderModule interface — validates Descope JWTs
 * on every request, maps Descope roles to Emdash role levels, and provisions
 * users automatically.
 *
 * Reference: @emdash-cms/cloudflare/src/auth/cloudflare-access.ts
 *
 * Descope JWT claims (standard + custom):
 *   sub       — Descope user ID
 *   email     — user email
 *   name      — display name
 *   dct       — active Descope tenant ID
 *   roles     — roles flattened to the active `dct` tenant
 *   tenants   — legacy compatibility claim (older session shapes only)
 *   tediId    — (V2 JWT) associated tedi ID
 *   descopeUserId — (V2 JWT) Descope user ID
 */

import { env as cfEnv } from "cloudflare:workers";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { assertDescopeSessionBoundary } from "./descope-jwt-boundary";

// Emdash role levels (from @emdash-cms/auth/src/types.ts)
const EMDASH_ROLES = {
	SUBSCRIBER: 10,
	CONTRIBUTOR: 20,
	AUTHOR: 30,
	EDITOR: 40,
	ADMIN: 50,
} as const;

export interface DescopeConfig {
	/**
	 * Descope project ID (e.g., "P2abc123...")
	 * Used to construct JWKS URL for token validation.
	 */
	projectId?: string;

	/**
	 * Custom Descope base URL (for self-hosted or EU regions).
	 * @default "https://api.descope.com"
	 */
	baseUrl?: string;

	/**
	 * Environment variable containing the Descope base URL.
	 * @default "DESCOPE_BASE_URL"
	 */
	baseUrlEnvVar?: string;

	/**
	 * Environment variable name containing the project ID.
	 * Read at runtime if projectId is not set directly.
	 * @default "DESCOPE_PROJECT_ID"
	 */
	projectIdEnvVar?: string;

	/**
	 * Default Emdash role level for users without explicit mapping.
	 * @default 40 (Editor)
	 */
	defaultRole?: number;

	/**
	 * Map Descope role names to Emdash role levels.
	 * Checked against the user's roles in their tenant/org.
	 * First match wins (highest role should come first).
	 *
	 * @example
	 * {
	 *   "Org Admin": 50,     // Emdash Admin
	 *   "Content Manager": 40, // Emdash Editor
	 *   "Member": 30,          // Emdash Author
	 * }
	 */
	roleMapping?: Record<string, number>;

	/**
	 * Descope tenant/org ID to check roles against.
	 * The JWT must include this tenant and only roles from this tenant are
	 * considered. Set directly or through tenantIdEnvVar.
	 */
	tenantId?: string;

	/**
	 * Environment variable name containing the tenant ID.
	 * Read at runtime if tenantId is not set directly.
	 */
	tenantIdEnvVar?: string;

	/**
	 * Environment variable name containing the Site Builder service-binding shared secret.
	 * Requests with a matching X-Tedix-CMS-Internal-Auth header are authenticated
	 * as an internal Emdash admin principal.
	 *
	 * @default "CMS_INTERNAL_AUTH_TOKEN"
	 */
	internalAuthTokenEnvVar?: string;
}

interface DescopeTenantInfo {
	tenantId: string;
	roles?: string[];
	permissions?: string[];
}

type RawDescopeTenant =
	| {
			tenantId?: unknown;
			id?: unknown;
			roles?: unknown;
			roleNames?: unknown;
			permissions?: unknown;
	  }
	| null
	| undefined;

type RawDescopeTenantsClaim =
	| Record<string, RawDescopeTenant>
	| RawDescopeTenant[];

interface DescopeJwtPayload extends JWTPayload {
	dct?: string;
	displayName?: string;
	email?: string;
	familyName?: string;
	family_name?: string;
	givenName?: string;
	given_name?: string;
	name?: string;
	tenants?: RawDescopeTenantsClaim;
	roles?: string[];
	roleNames?: string[];
	permissions?: string[];
	tediId?: string;
	descopeUserId?: string;
}

interface AuthResult {
	email: string;
	name: string;
	role: number;
	subject?: string;
	metadata?: Record<string, unknown>;
}

interface DescopeRequestTokens {
	sessionJwt: string;
	refreshJwt?: string;
}

type DescopeProfileResponse = {
	displayName?: unknown;
	email?: unknown;
	familyName?: unknown;
	family_name?: unknown;
	givenName?: unknown;
	given_name?: unknown;
	loginIds?: unknown;
	name?: unknown;
	user?: {
		displayName?: unknown;
		email?: unknown;
		familyName?: unknown;
		family_name?: unknown;
		givenName?: unknown;
		given_name?: unknown;
		loginIds?: unknown;
		name?: unknown;
	};
};

// JWKS cache — jose handles key rotation internally
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const profileNameCache = new Map<string, { expiresAt: number; name: string }>();
const PROFILE_NAME_CACHE_TTL_MS = 5 * 60 * 1000;
const PROFILE_NAME_CACHE_MAX = 1000;

function getJwks(
	projectId: string,
	baseUrl: string,
): ReturnType<typeof createRemoteJWKSet> {
	const key = `${baseUrl}:${projectId}`;
	let jwks = jwksCache.get(key);
	if (!jwks) {
		const jwksUrl = new URL(`${baseUrl}/${projectId}/.well-known/jwks.json`);
		jwks = createRemoteJWKSet(jwksUrl);
		jwksCache.set(key, jwks);
	}
	return jwks;
}

const COOKIE_SPLIT_RE = /;\s*/;
const INTERNAL_AUTH_HEADER = "X-Tedix-CMS-Internal-Auth";

function readCookie(request: Request, name: string): string | undefined {
	const cookies = request.headers.get("Cookie") ?? "";
	for (const part of cookies.split(COOKIE_SPLIT_RE)) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		if (part.slice(0, eq) !== name) continue;
		const value = part.slice(eq + 1);
		try {
			return decodeURIComponent(value);
		} catch {
			return value;
		}
	}
	return undefined;
}

/** Existing broker session only; never returns or rotates a refresh token. */
export function getCmsEditorSession(request: Request): string | null {
	return extractDescopeTokens(request)?.sessionJwt ?? null;
}

function extractDescopeTokens(request: Request): DescopeRequestTokens | null {
	const authHeader = request.headers.get("Authorization");
	if (authHeader?.startsWith("Bearer ")) {
		return { sessionJwt: authHeader.slice(7) };
	}

	const sessionJwt = readCookie(request, "DS");
	if (!sessionJwt) return null;

	return {
		sessionJwt,
		refreshJwt: readCookie(request, "DSR"),
	};
}

function rejectDescopeAuth(code: string, message: string): never {
	console.warn(JSON.stringify({ code, event: "cms.descope_auth_rejected" }));
	throw new Error(message);
}

function resolveProjectId(config: DescopeConfig): string {
	if (config.projectId) return config.projectId;

	const envVar = config.projectIdEnvVar ?? "DESCOPE_PROJECT_ID";

	// Cloudflare Workers — env vars via cloudflare:workers module
	const cfValue = (cfEnv as unknown as Record<string, unknown>)?.[envVar] as
		| string
		| undefined;
	if (cfValue) return cfValue;

	throw new Error(
		`Descope project ID not configured. Set projectId or ${envVar} env var.`,
	);
}

function resolveBaseUrl(config: DescopeConfig): string {
	const configured = config.baseUrl?.trim();
	if (configured) return configured.replace(/\/+$/, "");

	const envVar = config.baseUrlEnvVar ?? "DESCOPE_BASE_URL";
	const envValue = (cfEnv as unknown as Record<string, unknown>)?.[envVar];
	if (typeof envValue === "string" && envValue.trim()) {
		return envValue.trim().replace(/\/+$/, "");
	}
	return "https://api.descope.com";
}

function resolveTenantId(config: DescopeConfig): string | undefined {
	if (config.tenantId) return config.tenantId;
	if (!config.tenantIdEnvVar) return undefined;

	const value = (cfEnv as unknown as Record<string, unknown>)?.[
		config.tenantIdEnvVar
	];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveRequiredTenantId(config: DescopeConfig): string {
	const tenantId = resolveTenantId(config);
	if (tenantId) return tenantId;

	const envVar = config.tenantIdEnvVar ?? "tenantId";
	throw new Error(
		`Descope tenant ID not configured. Set tenantId or ${envVar} env var.`,
	);
}

function resolveInternalAuthToken(config: DescopeConfig): string | undefined {
	const envVar = config.internalAuthTokenEnvVar ?? "CMS_INTERNAL_AUTH_TOKEN";
	const value = (cfEnv as unknown as Record<string, unknown>)?.[envVar];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function authenticateInternalRequest(
	request: Request,
	config: DescopeConfig,
): AuthResult | null {
	const expected = resolveInternalAuthToken(config);
	if (!expected) return null;

	const actual = request.headers.get(INTERNAL_AUTH_HEADER);
	if (!actual || actual !== expected) return null;

	return {
		email: "cms-service@tedix.dev",
		name: "Tedix CMS Service",
		role: EMDASH_ROLES.ADMIN,
		subject: "tedix-cms-service",
		metadata: {
			internal: true,
			authProvider: "tedix-cms-internal",
		},
	};
}

async function authenticateHumanAssertion(
	request: Request,
	config: DescopeConfig,
): Promise<AuthResult | null> {
	const assertion = request.headers.get("X-Tedix-CMS-Human-Assertion");
	if (!assertion) return null;
	const runtime = cfEnv as unknown as Record<string, unknown>;
	const keyText = runtime.CMS_HUMAN_AUTH_KEY;
	const siteId = runtime.CMS_HUMAN_AUTH_SITE_ID;
	const bundleEtag = runtime.CMS_HUMAN_AUTH_BUNDLE_ETAG;
	if (
		typeof keyText !== "string" ||
		typeof siteId !== "string" ||
		typeof bundleEtag !== "string"
	) {
		rejectDescopeAuth(
			"human_assertion_disabled",
			"CMS human assertion is unavailable for this bundle",
		);
	}
	const parts = assertion.split(".");
	if (
		parts.length !== 2 ||
		!parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))
	) {
		rejectDescopeAuth("human_assertion_format", "Invalid CMS human assertion");
	}
	const [payloadText, signatureText] = parts as [string, string];
	let payload: Record<string, unknown>;
	try {
		const padded = payloadText.replace(/-/g, "+").replace(/_/g, "/");
		payload = JSON.parse(
			new TextDecoder().decode(
				Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)),
			),
		) as Record<string, unknown>;
	} catch {
		rejectDescopeAuth("human_assertion_json", "Invalid CMS human assertion");
	}
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(keyText),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	const signatureBase64 = signatureText.replace(/-/g, "+").replace(/_/g, "/");
	let signature: Uint8Array;
	try {
		signature = Uint8Array.from(atob(signatureBase64), (char) =>
			char.charCodeAt(0),
		);
	} catch {
		rejectDescopeAuth(
			"human_assertion_signature",
			"Invalid CMS human assertion",
		);
	}
	const verified = await crypto.subtle.verify(
		"HMAC",
		key,
		signature.buffer as ArrayBuffer,
		new TextEncoder().encode(payloadText),
	);
	if (!verified)
		rejectDescopeAuth(
			"human_assertion_signature",
			"Invalid CMS human assertion",
		);
	const now = Math.floor(Date.now() / 1000);
	const url = new URL(request.url);
	if (
		payload.siteId !== siteId ||
		payload.bundleEtag !== bundleEtag ||
		payload.slug !== runtime.ORG_SLUG ||
		payload.tenantId !== resolveRequiredTenantId(config) ||
		payload.method !== request.method.toUpperCase() ||
		payload.path !== url.pathname + url.search ||
		typeof payload.iat !== "number" ||
		typeof payload.exp !== "number" ||
		payload.iat > now + 5 ||
		payload.iat < now - 30 ||
		payload.exp <= now ||
		payload.exp > payload.iat + 30 ||
		![10, 40, 50].includes(payload.role as number) ||
		typeof payload.subject !== "string" ||
		!payload.subject ||
		typeof payload.email !== "string" ||
		!payload.email ||
		typeof payload.name !== "string" ||
		!payload.name
	)
		rejectDescopeAuth(
			"human_assertion_binding",
			"CMS human assertion is not valid for this request",
		);
	return {
		email: payload.email as string,
		name: payload.name as string,
		role: payload.role as number,
		subject: payload.subject as string,
		metadata: {
			descopeUserId: payload.subject,
			authProvider: "tedix-cms-human",
		},
	};
}

function readStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is string => typeof item === "string" && item.length > 0,
	);
}

function normalizeTenantRoles(
	raw: RawDescopeTenant,
): Omit<DescopeTenantInfo, "tenantId"> {
	if (!raw || typeof raw !== "object") return {};

	return {
		roles: [...readStringArray(raw.roles), ...readStringArray(raw.roleNames)],
		permissions: readStringArray(raw.permissions),
	};
}

function normalizeTenantsClaim(
	raw: RawDescopeTenantsClaim | undefined,
): DescopeTenantInfo[] {
	if (!raw || typeof raw !== "object") return [];

	if (Array.isArray(raw)) {
		return raw.flatMap((tenant) => {
			if (!tenant || typeof tenant !== "object") return [];
			const tenantId =
				typeof tenant.tenantId === "string"
					? tenant.tenantId
					: typeof tenant.id === "string"
						? tenant.id
						: undefined;
			return tenantId ? [{ tenantId, ...normalizeTenantRoles(tenant) }] : [];
		});
	}

	return Object.entries(raw).map(([tenantId, tenant]) => ({
		tenantId,
		...normalizeTenantRoles(tenant),
	}));
}

function mapRole(
	roles: string[],
	roleMapping: Record<string, number> | undefined,
	defaultRole: number,
): number {
	if (!roleMapping) return defaultRole;

	const roleSet = new Set(roles);
	for (const [roleName, roleLevel] of Object.entries(roleMapping)) {
		if (roleSet.has(roleName)) return roleLevel;
	}

	return defaultRole;
}

export function resolveDescopeTenantRole(
	payload: DescopeJwtPayload,
	config: DescopeConfig,
): number {
	const defaultRole = config.defaultRole ?? EMDASH_ROLES.EDITOR;
	const tenantId = resolveRequiredTenantId(config);

	// Current Descope user sessions flatten roles to the selected `dct` tenant.
	// Treat dct only as a verified token binding, never as authority derived from
	// the CMS hostname. A mismatched selected tenant fails closed even if an old
	// multi-tenant claim also happens to name the required tenant.
	if (payload.dct) {
		if (payload.dct !== tenantId) {
			throw new Error(
				`Descope JWT is not authorized for required tenant ${tenantId}`,
			);
		}
		return mapRole(
			[
				...readStringArray(payload.roles),
				...readStringArray(payload.roleNames),
			],
			config.roleMapping,
			defaultRole,
		);
	}

	// Compatibility for sessions minted before Descope's selected-tenant shape
	// was adopted. Remove only after the broker migration's legacy window closes.
	const tenants = normalizeTenantsClaim(payload.tenants);
	const tenant = tenants.find((item) => item.tenantId === tenantId);
	if (!tenant) {
		throw new Error(
			`Descope JWT is not authorized for required tenant ${tenantId}`,
		);
	}
	return mapRole(tenant.roles ?? [], config.roleMapping, defaultRole);
}

function firstNonEmptyString(
	...values: Array<null | string | undefined>
): string | undefined {
	return values.find(
		(value): value is string =>
			typeof value === "string" && value.trim().length > 0,
	);
}

function nameFromParts(
	givenName: unknown,
	familyName: unknown,
): string | undefined {
	const parts = [givenName, familyName].flatMap((value) =>
		typeof value === "string" && value.trim() ? [value.trim()] : [],
	);
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function resolveJwtDisplayName(payload: DescopeJwtPayload): string | undefined {
	return firstNonEmptyString(
		payload.name,
		payload.displayName,
		nameFromParts(
			payload.givenName ?? payload.given_name,
			payload.familyName ?? payload.family_name,
		),
	);
}

function emailPrefix(email: string): string | undefined {
	const [prefix] = email.split("@");
	return prefix?.trim() || undefined;
}

function isWeakEmailPrefixName(
	name: string | undefined,
	email: string,
): boolean {
	const prefix = emailPrefix(email);
	return Boolean(
		name && prefix && name.trim().toLowerCase() === prefix.trim().toLowerCase(),
	);
}

function profileCacheKey(payload: DescopeJwtPayload, email: string): string {
	return String(payload.sub ?? payload.descopeUserId ?? email);
}

function cacheProfileName(key: string, name: string): void {
	if (profileNameCache.size >= PROFILE_NAME_CACHE_MAX) {
		const firstKey = profileNameCache.keys().next().value;
		if (firstKey !== undefined) profileNameCache.delete(firstKey);
	}
	profileNameCache.set(key, {
		expiresAt: Date.now() + PROFILE_NAME_CACHE_TTL_MS,
		name,
	});
}

async function fetchDescopeProfileName(params: {
	baseUrl: string;
	email: string;
	payload: DescopeJwtPayload;
	projectId: string;
	refreshJwt?: string;
}): Promise<string | undefined> {
	if (!params.refreshJwt) return undefined;

	const key = profileCacheKey(params.payload, params.email);
	const cached = profileNameCache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.name;

	const response = await fetch(
		`${params.baseUrl.replace(/\/+$/, "")}/v1/auth/me`,
		{
			headers: {
				Authorization: `Bearer ${params.projectId}:${params.refreshJwt}`,
			},
		},
	);
	if (!response.ok) return undefined;

	const data = (await response.json()) as DescopeProfileResponse;
	const user = data.user ?? data;
	const name = firstNonEmptyString(
		typeof user?.name === "string" ? user.name : undefined,
		typeof user?.displayName === "string" ? user.displayName : undefined,
		nameFromParts(
			user?.givenName ?? user?.given_name,
			user?.familyName ?? user?.family_name,
		),
	);
	if (name) cacheProfileName(key, name);
	return name;
}

async function resolveDisplayName(params: {
	baseUrl: string;
	email: string;
	payload: DescopeJwtPayload;
	projectId: string;
	refreshJwt?: string;
}): Promise<string> {
	const jwtName = resolveJwtDisplayName(params.payload);
	if (jwtName && !isWeakEmailPrefixName(jwtName, params.email)) return jwtName;

	const profileName = await fetchDescopeProfileName(params).catch(
		() => undefined,
	);
	if (profileName && !isWeakEmailPrefixName(profileName, params.email)) {
		return profileName;
	}
	return jwtName ?? profileName ?? emailPrefix(params.email) ?? "Unknown";
}

/**
 * Authenticate a request using Descope JWT.
 *
 * Implements Emdash's AuthProviderModule.authenticate interface.
 * Called by Emdash's auth middleware on every request to /_emdash/* routes.
 */
export async function authenticate(
	request: Request,
	config: unknown,
): Promise<AuthResult> {
	const descopeConfig = config as DescopeConfig;
	const internal = authenticateInternalRequest(request, descopeConfig);
	if (internal) return internal;
	const assertedHuman = await authenticateHumanAssertion(
		request,
		descopeConfig,
	);
	if (assertedHuman) return assertedHuman;

	const projectId = resolveProjectId(descopeConfig);
	const baseUrl = resolveBaseUrl(descopeConfig);

	const tokens = extractDescopeTokens(request);
	if (!tokens) {
		rejectDescopeAuth(
			"missing_session",
			"No Descope session token found (Authorization header or DS cookie)",
		);
	}

	const jwks = getJwks(projectId, baseUrl);

	let payload: DescopeJwtPayload;
	try {
		const result = await jwtVerify(tokens.sessionJwt, jwks, {
			clockTolerance: 60,
		});
		payload = result.payload as DescopeJwtPayload;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const code =
			err && typeof err === "object" && "code" in err
				? String(err.code)
				: "unknown";
		rejectDescopeAuth(
			`jwt_validation:${code}`,
			`Descope JWT validation failed: ${msg}`,
		);
	}

	try {
		assertDescopeSessionBoundary(payload, { projectId });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		rejectDescopeAuth(
			message.includes("issuer") ? "issuer_mismatch" : "audience_mismatch",
			message,
		);
	}

	const email = payload.email;
	if (!email) {
		rejectDescopeAuth("missing_email", "Descope JWT missing email claim");
	}

	const role = resolveDescopeTenantRole(payload, descopeConfig);
	const name = await resolveDisplayName({
		baseUrl,
		email,
		payload,
		projectId,
		refreshJwt: tokens.refreshJwt,
	});

	return {
		email,
		name,
		role,
		subject: payload.sub,
		metadata: {
			tediId: payload.tediId,
			descopeUserId: payload.descopeUserId,
			tenants: normalizeTenantsClaim(payload.tenants),
			permissions: payload.permissions,
		},
	};
}
