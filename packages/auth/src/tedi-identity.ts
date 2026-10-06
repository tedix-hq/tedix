/**
 * @tedix/auth - Tedi Identity Management (V2)
 *
 * Tedis are proper Descope users with access keys, not standalone access keys.
 * This replaces agentic-identity.ts.
 *
 * Identity model:
 * - Descope User with customAttributes: { tediId, entityType: "tedi" }
 * - Tenant-scoped "tedi" role
 * - Access key bound to user (inherits user's tenant/role context)
 * - Access key customClaims carry `tediId`, `entityType`, and Tedix-owned
 *   runtime API scopes for V2 JWTs
 * - JWT template puts tediId + entityType at top level (no nsec hacks)
 * - Public login/email alias `{slug}@tedix.tech` for first-party tedi
 *   dashboard access. The stable Descope login ID remains `tedi:{slug}`.
 *
 * SDK methods used:
 * - management.user.create(loginId, options)
 * - management.user.delete(loginId)
 * - management.user.activate(loginId)
 * - management.user.deactivate(loginId)
 * - management.user.loadByUserId(userId)
 * - management.user.updateCustomAttribute(loginId, key, value)
 * - management.accessKey.create(name, expireTime, roles, tenants, userId)
 * - management.accessKey.delete(id)
 * - auth.accessKey.exchange(accessKey)
 */

import type { DescopeClient } from "@tedix/auth/descope";

// =============================================================================
// TYPES
// =============================================================================

export interface TediIdentity {
	/** Descope user ID for this tedi */
	descopeUserId: string;
	/** Descope access key ID */
	descopeKeyId: string;
	/** Raw access key cleartext (only at creation time) */
	cleartext?: string;
	/** Our D1 tedi UUID */
	tediId: string;
	/** Org's Descope tenant ID */
	tenantId: string;
	/** Roles assigned */
	roles: string[];
	/** Login ID used in Descope */
	loginId: string;
}

export interface ExchangedTediToken {
	/** JWT session token */
	sessionJwt: string;
	/** Decoded claims */
	claims: Record<string, unknown>;
}

interface SearchedUser {
	userId?: string;
	loginIds?: string[];
	roleNames?: string[];
	customAttributes?: Record<string, unknown>;
}

interface TediUserRecord {
	userId?: string;
	loginIds?: string[];
	email?: string;
	name?: string;
	roleNames?: string[];
	customAttributes?: Record<string, unknown>;
	userTenants?: Array<{ tenantId?: string; roleNames?: string[] }>;
	status?: string;
}

interface UserSearchResponse {
	users: SearchedUser[];
	total: number;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Login ID prefix for tedi users — prevents collision with human users */
export const TEDI_LOGIN_PREFIX = "tedi:";

/** First-party email domain for tedi login aliases and mailboxes */
export const TEDI_EMAIL_DOMAIN = "tedix.tech";

/** Default role for tedis */
export const TEDI_DEFAULT_ROLE = "tedi";

/**
 * Default bounded lifetime for tedi access keys.
 *
 * Descope `accessKey.create(expireTime)` takes an ABSOLUTE Unix epoch (seconds),
 * where `0` means non-expiring. Tedi access keys carry write scopes
 * (`TEDI_RUNTIME_API_SCOPES`), so minting them non-expiring by default is a
 * standing least-privilege risk. Bound them instead: the runtime access-key
 * guard (`ensureScopedAccessKey` in apps/tedi-runtime) already re-mints any key
 * whose exchange fails, so a bounded lifetime self-heals via rotation without
 * operator intervention.
 *
 * TODO(rotation-SLA): add a PROACTIVE rotation cadence well inside this window
 * (e.g. re-mint at ~60d) rather than relying solely on expiry-triggered repair,
 * so a key never reaches its hard expiry in a live path. Owner: platform-auth.
 */
export const TEDI_ACCESS_KEY_DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Absolute Descope `expireTime` (epoch seconds) a bounded TTL out from `now`.
 * Injectable `now`/`ttlSeconds` keep it deterministic under test.
 */
export function defaultTediAccessKeyExpireTime(
	now: Date = new Date(),
	ttlSeconds: number = TEDI_ACCESS_KEY_DEFAULT_TTL_SECONDS,
): number {
	return Math.floor(now.getTime() / 1000) + ttlSeconds;
}

/** Custom attribute keys */
export const ATTR_TEDI_ID = "tediId";
export const ATTR_ENTITY_TYPE = "entityType";

/** Entity type value for tedis */
export const ENTITY_TYPE_TEDI = "tedi";

/**
 * Exact API scopes direct tedi JWTs need for runtime-owned platform writes.
 * These are not platform-admin scopes; they only unlock the tedi-scoped API
 * surfaces the Agent-runtime and workstation bridges call directly.
 */
export const TEDI_RUNTIME_API_SCOPES = [
	"tedis:read",
	"tedis:write",
	"billing:read",
	"mcp:messaging.read",
	"mcp:messaging.write",
] as const;

export const TEDI_RUNTIME_API_SCOPES_CLAIM = "tedixRuntimeApiScopes";

export const TEDI_BODY_GENERATION_TOKEN_BYTES = 32;

export const TEDI_BODY_GENERATION_STATUSES = [
	"armed",
	"starting",
	"ready",
	"failed",
	"terminated",
	"expired",
] as const;
export type TediBodyGenerationStatus =
	(typeof TEDI_BODY_GENERATION_STATUSES)[number];

// `agent` is the Agent-runtime body kind (mirrors runtime_kind='agent'). The
// legacy `isolate` alias was backfilled to `agent` and dropped.
export const TEDI_BODY_KINDS = ["agent", "workstation"] as const;
export type TediBodyKind = (typeof TEDI_BODY_KINDS)[number];

export interface TediBodyGenerationCredential {
	generationId: string;
	token: string;
	tokenHash: string;
	tokenExpiresAt: string;
}

export function extractTediRuntimeApiScopes(
	payload: Record<string, unknown> | null | undefined,
): string[] {
	const scopes = new Set<string>();
	const runtimeScopes = payload?.[TEDI_RUNTIME_API_SCOPES_CLAIM];
	if (Array.isArray(runtimeScopes)) {
		for (const scope of runtimeScopes.map(String).filter(Boolean)) {
			scopes.add(scope);
		}
	}
	return [...scopes];
}

export function buildTediAccessKeyClaims(params: {
	tediId: string;
	descopeUserId: string;
}): Record<string, unknown> {
	return {
		[ATTR_TEDI_ID]: params.tediId,
		[ATTR_ENTITY_TYPE]: ENTITY_TYPE_TEDI,
		descopeUserId: params.descopeUserId,
		[TEDI_RUNTIME_API_SCOPES_CLAIM]: [...TEDI_RUNTIME_API_SCOPES],
	};
}

export function buildTediLoginId(slug: string): string {
	return `${TEDI_LOGIN_PREFIX}${slug}`;
}

export function buildTediEmail(slug: string): string {
	return `${slug}@${TEDI_EMAIL_DOMAIN}`;
}

function base64Url(bytes: Uint8Array): string {
	const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join(
		"",
	);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

export async function hashTediBodyGenerationToken(
	token: string,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token),
	);
	return bytesToHex(new Uint8Array(digest));
}

export async function createTediBodyGenerationCredential(
	params: {
		generationId?: string;
		now?: Date;
		randomBytes?: Uint8Array;
		tokenTtlMs?: number;
	} = {},
): Promise<TediBodyGenerationCredential> {
	const bytes =
		params.randomBytes ??
		crypto.getRandomValues(new Uint8Array(TEDI_BODY_GENERATION_TOKEN_BYTES));
	const token = `tbg_${base64Url(bytes)}`;
	const now = params.now ?? new Date();
	const tokenTtlMs = params.tokenTtlMs ?? 10 * 60 * 1000;
	return {
		generationId: params.generationId ?? crypto.randomUUID(),
		token,
		tokenHash: await hashTediBodyGenerationToken(token),
		tokenExpiresAt: new Date(now.getTime() + tokenTtlMs).toISOString(),
	};
}

export async function verifyTediBodyGenerationToken(params: {
	expectedHash: string | null | undefined;
	token: string | null | undefined;
	tokenExpiresAt: string | null | undefined;
	now?: Date;
}): Promise<boolean> {
	if (!params.expectedHash || !params.token || !params.tokenExpiresAt) {
		return false;
	}
	const expiresAt = new Date(params.tokenExpiresAt).getTime();
	const now = (params.now ?? new Date()).getTime();
	if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
	// This compare is not constant-time; generation tokens are short-lived body
	// boot credentials, not reusable operator secrets.
	return (
		(await hashTediBodyGenerationToken(params.token)) === params.expectedHash
	);
}

// =============================================================================
// CREATE
// =============================================================================

/**
 * Best-effort delete of a just-created tedi Descope user, used to roll back a
 * partially-provisioned identity when a later step fails. The caller is already
 * throwing the root failure, so a cleanup error is intentionally swallowed.
 */
async function rollbackTediUser(
	client: DescopeClient,
	loginId: string,
): Promise<void> {
	try {
		await client.management.user.delete(loginId);
	} catch {
		// Best-effort cleanup.
	}
}

/**
 * Create a full Descope identity for a tedi:
 * 1. Create Descope user with tedi custom attributes
 * 2. Assign to tenant with "tedi" role
 * 3. Create access key bound to user
 *
 * @throws {Error} if the Descope user creation API call fails
 * @throws {Error} if tenant/role assignment fails (rolls back user)
 * @throws {Error} if the Descope access key creation API call fails (rolls back user)
 */
export async function createTediIdentity(
	client: DescopeClient,
	params: {
		tediId: string;
		slug: string;
		displayName: string;
		tenantId: string;
		roles?: string[];
		expireTime?: number;
	},
): Promise<TediIdentity> {
	const roles = params.roles ?? [TEDI_DEFAULT_ROLE];
	const loginId = buildTediLoginId(params.slug);
	const email = buildTediEmail(params.slug);

	// 1. Create Descope user. Keep `tedi:{slug}` as the stable login ID while
	// exposing `{slug}@tedix.tech` as both email and login alias.
	const userResp = await client.management.user.create(loginId, {
		displayName: params.displayName,
		email,
		verifiedEmail: true,
		additionalLoginIds: [email],
		userTenants: [{ tenantId: params.tenantId, roleNames: roles }],
		customAttributes: {
			[ATTR_TEDI_ID]: params.tediId,
			[ATTR_ENTITY_TYPE]: ENTITY_TYPE_TEDI,
		},
	});

	if (!userResp.ok || !userResp.data) {
		throw new Error(
			`Failed to create Descope user for tedi: ${JSON.stringify(userResp)}`,
		);
	}

	const descopeUserId = userResp.data.userId;

	// Descope's user.create doesn't always persist userTenants, so explicitly
	// assign tenant + roles to ensure they stick. addTenant/addTenantRoles resolve
	// with an SdkResponse — they do NOT throw on API errors — so we must check
	// resp.ok rather than swallowing failures in a catch. The old catch-swallow
	// silently marked a failed assignment as success and left the tedi without
	// tenant/role context (an authz correctness hole). Mirror repairTediIdentity:
	// ok is success, an "already present" error is tolerated, anything else rolls
	// back the just-created user and throws.
	const addTenantResp = await client.management.user.addTenant(
		loginId,
		params.tenantId,
	);
	if (!addTenantResp.ok && !isAlreadyPresentError(addTenantResp.error)) {
		await rollbackTediUser(client, loginId);
		throw new Error(
			`Failed to assign tenant to tedi user ${loginId}: ${addTenantResp.error?.errorCode} ${addTenantResp.error?.errorDescription}`,
		);
	}

	const addTenantRolesResp = await client.management.user.addTenantRoles(
		loginId,
		params.tenantId,
		roles,
	);
	if (
		!addTenantRolesResp.ok &&
		!isAlreadyPresentError(addTenantRolesResp.error)
	) {
		await rollbackTediUser(client, loginId);
		throw new Error(
			`Failed to assign tenant roles to tedi user ${loginId}: ${addTenantRolesResp.error?.errorCode} ${addTenantRolesResp.error?.errorDescription}`,
		);
	}

	// 2. Create access key bound to the user
	const tediAttrs = buildTediAccessKeyClaims({
		tediId: params.tediId,
		descopeUserId,
	});
	const keyResp = await client.management.accessKey.create(
		`tedi:${params.slug}`,
		// Bounded absolute expiry (epoch seconds) instead of 0 (non-expiring):
		// tedi keys carry write scopes and self-heal via runtime rotation.
		params.expireTime ?? defaultTediAccessKeyExpireTime(),
		roles,
		undefined,
		descopeUserId,
		tediAttrs, // customClaims — injected into JWT on exchange
		undefined, // description
		undefined, // permittedIps
		tediAttrs, // customAttributes — persistent metadata on the key object (v1.10.0+)
	);

	if (!keyResp.ok || !keyResp.data) {
		// Rollback: delete the user we just created
		await rollbackTediUser(client, loginId);
		throw new Error(
			`Failed to create access key for tedi: ${JSON.stringify(keyResp)}`,
		);
	}

	return {
		descopeUserId,
		descopeKeyId: keyResp.data.key.id,
		cleartext: keyResp.data.cleartext,
		tediId: params.tediId,
		tenantId: params.tenantId,
		roles,
		loginId,
	};
}

// =============================================================================
// EXCHANGE
// =============================================================================

/**
 * Exchange a tedi's access key for a JWT.
 * The JWT will contain `descopeUserId` from the JWT template and `tediId`/`entityType` from access-key customClaims.
 *
 * @throws {Error} if the Descope access key exchange API call fails
 */
export async function exchangeTediToken(
	client: DescopeClient,
	accessKey: string,
): Promise<ExchangedTediToken> {
	const resp = await client.accessKey.exchange(accessKey);

	if (!resp.ok || !resp.data) {
		throw new Error(
			`Failed to exchange tedi access key: ${JSON.stringify(resp)}`,
		);
	}

	return {
		sessionJwt: resp.data.sessionJwt ?? "",
		claims: (resp.data as Record<string, unknown>) ?? {},
	};
}

// =============================================================================
// LOAD
// =============================================================================

/**
 * Load a tedi's Descope user by user ID.
 *
 * @returns null if user not found OR if the Descope API call fails
 */
export async function loadTediUser(
	client: DescopeClient,
	descopeUserId: string,
) {
	const resp = await client.management.user.loadByUserId(descopeUserId);
	if (!resp.ok || !resp.data) {
		return null;
	}
	return resp.data;
}

/**
 * Load a tedi's Descope user by login ID (slug).
 *
 * @returns null if user not found OR if the Descope API call fails
 */
export async function loadTediBySlug(client: DescopeClient, slug: string) {
	const loginId = buildTediLoginId(slug);
	const resp = await client.management.user.load(loginId);
	if (!resp.ok || !resp.data) {
		return null;
	}
	return resp.data;
}

// =============================================================================
// LIST
// =============================================================================

/**
 * List all tedi identities for a tenant.
 * Filters by entityType custom attribute. Paginates until all results are
 * fetched (Descope caps each page at 100).
 *
 * @throws {Error} if any Descope API call fails
 */
export async function listTediIdentities(
	client: DescopeClient,
	tenantId: string,
): Promise<TediIdentity[]> {
	const limit = 100;
	const allUsers: SearchedUser[] = [];
	let page = 0;

	while (true) {
		const resp = await client.management.user.search({
			tenantIds: [tenantId],
			customAttributes: { [ATTR_ENTITY_TYPE]: ENTITY_TYPE_TEDI },
			limit,
			page,
		});

		if (!resp.ok || !resp.data) {
			throw new Error(
				`listTediIdentities failed for tenant ${tenantId} (page ${page}): ${JSON.stringify(resp.error ?? resp)}`,
			);
		}

		const { users } = resp.data as unknown as UserSearchResponse;
		allUsers.push(...users);

		// Fewer results than the page limit means this is the last page.
		if (users.length < limit) break;
		page += 1;
	}

	return allUsers.map((user) => ({
		descopeUserId: user.userId ?? "",
		descopeKeyId: "",
		tediId:
			typeof user.customAttributes?.[ATTR_TEDI_ID] === "string"
				? user.customAttributes[ATTR_TEDI_ID]
				: "",
		tenantId,
		roles: user.roleNames ?? [],
		loginId: user.loginIds?.[0] ?? "",
	}));
}

// =============================================================================
// LIFECYCLE
// =============================================================================

/**
 * Deactivate a tedi's Descope user.
 * All access keys become unusable.
 */
export async function deactivateTediIdentity(
	client: DescopeClient,
	loginId: string,
): Promise<void> {
	await client.management.user.deactivate(loginId);
}

/**
 * Activate a previously deactivated tedi.
 */
export async function activateTediIdentity(
	client: DescopeClient,
	loginId: string,
): Promise<void> {
	await client.management.user.activate(loginId);
}

/**
 * Delete a tedi's Descope identity permanently.
 * Cascades: all access keys revoked, all FGA relations removed by caller.
 */
export async function deleteTediIdentity(
	client: DescopeClient,
	loginId: string,
): Promise<void> {
	await client.management.user.delete(loginId);
}

// =============================================================================
// REPAIR HELPERS
// =============================================================================

/**
 * Returns true when a Descope SDK error indicates the association already
 * exists (tenant already assigned, roles already present, etc.).
 *
 * Checks the errorDescription against a substring pattern as the safe fallback,
 * since exact Descope errorCode constants are not exported by the SDK.
 */
function isAlreadyPresentError(
	error: { errorCode?: string; errorDescription?: string } | null | undefined,
): boolean {
	if (!error) return false;
	const desc = error.errorDescription ?? "";
	return /already (exist|associat|member|assign|part\b)/i.test(desc);
}

// =============================================================================
// REPAIR
// =============================================================================

/**
 * Reconcile an existing Descope tedi user with the current Tedix identity
 * contract. This is intentionally idempotent and non-destructive:
 * - stable login ID: `tedi:{slug}`
 * - public login/email alias: `{slug}@tedix.tech`
 * - custom attributes: `tediId`, `entityType: "tedi"`
 * - tenant roles: caller-provided tedi roles
 */
export async function repairTediIdentity(
	client: DescopeClient,
	params: {
		tediId: string;
		slug: string;
		displayName: string;
		tenantId: string;
		descopeUserId?: string | null;
		roles?: string[];
	},
): Promise<{
	descopeUserId: string;
	loginId: string;
	email: string;
	descopeKeyId?: string;
	cleartext?: string;
	changed: string[];
	alreadyPresent: string[];
}> {
	const roles = params.roles ?? [TEDI_DEFAULT_ROLE];
	const loginId = buildTediLoginId(params.slug);
	const email = buildTediEmail(params.slug);

	const loaded = params.descopeUserId
		? await client.management.user.loadByUserId(params.descopeUserId)
		: null;
	let user = loaded?.ok && loaded.data ? (loaded.data as TediUserRecord) : null;

	if (!user) {
		const byLogin = await client.management.user.load(loginId);
		user = byLogin.ok && byLogin.data ? (byLogin.data as TediUserRecord) : null;
	}

	if (!user) {
		const created = await createTediIdentity(client, {
			tediId: params.tediId,
			slug: params.slug,
			displayName: params.displayName,
			tenantId: params.tenantId,
			roles,
		});
		return {
			descopeUserId: created.descopeUserId,
			loginId: created.loginId,
			email,
			descopeKeyId: created.descopeKeyId,
			cleartext: created.cleartext,
			changed: ["descope_user_created", "access_key_created"],
			alreadyPresent: [],
		};
	}

	const currentLoginIds = user.loginIds ?? [];
	const primaryLoginId = currentLoginIds[0] ?? loginId;
	const desiredLoginIds = Array.from(
		new Set([loginId, email, ...currentLoginIds]),
	);
	const additionalIdentifiers = desiredLoginIds.filter(
		(id) => id !== primaryLoginId,
	);

	const changed: string[] = [];
	const alreadyPresent: string[] = [];
	const patch: Record<string, unknown> = {};

	if (user.email !== email) {
		patch.email = email;
		patch.verifiedEmail = true;
		changed.push("email");
	} else {
		alreadyPresent.push("email");
	}

	for (const requiredLoginId of [loginId, email]) {
		if (currentLoginIds.includes(requiredLoginId)) {
			alreadyPresent.push(`login:${requiredLoginId}`);
		} else {
			changed.push(`login:${requiredLoginId}`);
		}
	}
	if (changed.some((item) => item.startsWith("login:"))) {
		patch.additionalIdentifiers = additionalIdentifiers;
	}

	const customAttributeUpdates: Array<{ key: string; value: string }> = [];
	if (
		user.customAttributes?.[ATTR_TEDI_ID] !== params.tediId ||
		user.customAttributes?.[ATTR_ENTITY_TYPE] !== ENTITY_TYPE_TEDI
	) {
		customAttributeUpdates.push(
			{ key: ATTR_TEDI_ID, value: params.tediId },
			{ key: ATTR_ENTITY_TYPE, value: ENTITY_TYPE_TEDI },
		);
		changed.push("customAttributes");
	} else {
		alreadyPresent.push("customAttributes");
	}

	if (Object.keys(patch).length > 0) {
		const resp = await client.management.user.patch(primaryLoginId, patch);
		if (!resp.ok) {
			throw new Error(
				`Failed to repair Descope tedi user ${primaryLoginId}: ${JSON.stringify(resp)}`,
			);
		}
	}

	for (const attr of customAttributeUpdates) {
		const resp = await client.management.user.updateCustomAttribute(
			primaryLoginId,
			attr.key,
			attr.value,
		);
		if (!resp.ok) {
			throw new Error(
				`Failed to update Descope tedi user attribute ${attr.key}: ${JSON.stringify(resp)}`,
			);
		}
	}

	// addTenant/addTenantRoles resolve with SdkResponse — they do NOT throw on
	// API errors. We must check resp.ok rather than relying on a catch to detect
	// failure; the old catch-swallow pattern silently marked failures as success.
	const addTenantResp = await client.management.user.addTenant(
		primaryLoginId,
		params.tenantId,
	);
	if (addTenantResp.ok) {
		changed.push("tenant");
	} else if (isAlreadyPresentError(addTenantResp.error)) {
		alreadyPresent.push("tenant");
	} else {
		throw new Error(
			`Failed to add tenant to tedi user ${primaryLoginId}: ${addTenantResp.error?.errorCode} ${addTenantResp.error?.errorDescription}`,
		);
	}

	const addTenantRolesResp = await client.management.user.addTenantRoles(
		primaryLoginId,
		params.tenantId,
		roles,
	);
	if (addTenantRolesResp.ok) {
		changed.push("tenantRoles");
	} else if (isAlreadyPresentError(addTenantRolesResp.error)) {
		alreadyPresent.push("tenantRoles");
	} else {
		throw new Error(
			`Failed to add tenant roles to tedi user ${primaryLoginId}: ${addTenantRolesResp.error?.errorCode} ${addTenantRolesResp.error?.errorDescription}`,
		);
	}

	if (user.status && user.status !== "enabled") {
		try {
			await client.management.user.activate(primaryLoginId);
			changed.push("status");
		} catch {
			// Leave status repair best-effort; access-key flows can still work for
			// already-active service use, and the caller gets all hard failures above.
		}
	}

	return {
		descopeUserId: user.userId ?? params.descopeUserId ?? "",
		loginId: primaryLoginId,
		email,
		changed,
		alreadyPresent,
	};
}

/**
 * Rotate a tedi's access key.
 * Creates a new key bound to the same user, deactivates the old one.
 *
 * @throws {Error} if the Descope access key creation API call fails
 */
export async function rotateTediAccessKey(
	client: DescopeClient,
	params: {
		slug: string;
		descopeUserId: string;
		oldKeyId?: string;
		tediId: string;
		roles?: string[];
		expireTime?: number;
		deactivateOld?: boolean;
	},
): Promise<{
	descopeKeyId: string;
	cleartext: string;
	oldKeyDeactivated: boolean;
}> {
	const roles = params.roles ?? [TEDI_DEFAULT_ROLE];

	// Create new key first
	const tediAttrs = buildTediAccessKeyClaims({
		tediId: params.tediId,
		descopeUserId: params.descopeUserId,
	});
	const keyResp = await client.management.accessKey.create(
		`tedi:${params.slug}`,
		// Bounded absolute expiry (epoch seconds) — rotation must not re-mint a
		// non-expiring key, or the first expiry-triggered rotation would defeat
		// the bounded-lifetime default from createTediIdentity.
		params.expireTime ?? defaultTediAccessKeyExpireTime(),
		roles,
		undefined,
		params.descopeUserId,
		tediAttrs, // customClaims
		undefined, // description
		undefined, // permittedIps
		tediAttrs, // customAttributes (v1.10.0+)
	);

	if (!keyResp.ok || !keyResp.data) {
		throw new Error(
			`Failed to create new access key: ${JSON.stringify(keyResp)}`,
		);
	}

	let oldKeyDeactivated = false;

	// Deactivate old key (don't delete — audit trail)
	if (params.oldKeyId && params.deactivateOld !== false) {
		try {
			const response = await client.management.accessKey.deactivate(
				params.oldKeyId,
			);
			oldKeyDeactivated = response.ok;
		} catch {
			// Non-fatal — old key might already be deactivated
		}
	}

	return {
		descopeKeyId: keyResp.data.key.id,
		cleartext: keyResp.data.cleartext ?? "",
		oldKeyDeactivated,
	};
}
