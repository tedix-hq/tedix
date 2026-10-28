/** API key list/create/revoke/delete/rotate/expiring procedures. */
import { PLATFORM_ONLY_API_KEY_SCOPES } from "@tedix/api-contract/schemas/organization";
import type { JWTPayload } from "@tedix/auth/types";
import { isPlatformPrincipal } from "@tedix/auth/types";
import {
	createApiKey as createApiKeyDb,
	deleteApiKey as deleteApiKeyDb,
	getApiKeyById,
	getExpiringKeys as getExpiringKeysDb,
	listApiKeysPage,
	revokeApiKey as revokeApiKeyDb,
	rotateApiKey as rotateApiKeyDb,
} from "@tedix/db/queries/api-keys";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { parseJsonField } from "@tedix/db/utils/json";
import { AUTHZ, type BaseContext, createError, ErrorCodes } from "../orpc";
import { requireStepUp } from "../step-up";
import {
	requireOrganizationAccess,
	requireAdminOrOwner,
} from "./organizations-base";
import { authedOrganizationsOs } from "./organizations-base";

/**
 * Contract-based listApiKeys procedure implementation
 */
export const listApiKeysContract = authedOrganizationsOs.listApiKeys
	.use(AUTHZ.apiKeysAdmin)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, status, environment, limit, offset } = input;

		requireOrganizationAccess(context, organizationId);

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		const { data: keys, total } = await listApiKeysPage(db, organizationId, {
			status: status as "active" | "revoked" | "expired" | undefined,
			environment: environment as "test" | "live" | undefined,
			limit,
			offset,
		});

		// Valid scopes from the contract schema
		const validScopes = [
			"apps:read",
			"apps:write",
			"apps:delete",
			"tools:read",
			"tools:write",
			"analytics:read",
			"adapters:read",
			"adapters:write",
			"billing:read",
			"team:read",
			"*",
		] as const;
		type ValidScope = (typeof validScopes)[number];

		// Helper to filter scopes to only valid values
		// Handles both parsed arrays and JSON strings (D1 sometimes returns text)
		const filterScopes = (scopes: unknown): ValidScope[] | null => {
			let parsed: unknown[] | null = null;

			if (Array.isArray(scopes)) {
				parsed = scopes;
			} else if (typeof scopes === "string") {
				const result = parseJsonField<unknown[]>(scopes);
				if (Array.isArray(result)) parsed = result;
				else return null;
			}

			if (!parsed) return null;
			const filtered = parsed.filter((s): s is ValidScope =>
				validScopes.includes(s as ValidScope),
			);
			return filtered.length > 0 ? filtered : null;
		};

		// Helper to convert string to valid enum or null
		const toValidEnvironment = (
			env: string | null | undefined,
		): "test" | "live" | null => {
			if (env === "test" || env === "live") return env;
			return null;
		};

		const toValidStatus = (
			s: string | null | undefined,
		): "active" | "revoked" | "expired" | null => {
			if (s === "active" || s === "revoked" || s === "expired") return s;
			return null;
		};

		// Helper to ensure string or null (not undefined), serializing Date objects
		const toStringOrNull = (v: unknown): string | null => {
			if (typeof v === "string") return v;
			if (v instanceof Date) return v.toISOString();
			return null;
		};

		// Helper to ensure number or null (not undefined)
		const toNumberOrNull = (v: unknown): number | null => {
			if (typeof v === "number") return v;
			return null;
		};

		// Helper to parse array from JSON string or return array directly
		const toStringArrayOrNull = (v: unknown): string[] | null => {
			if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
			if (typeof v === "string") {
				const result = parseJsonField<unknown[]>(v);
				if (Array.isArray(result))
					return result.filter((x) => typeof x === "string");
				return null;
			}
			return null;
		};

		// Helper to parse object from JSON string or return object directly
		const toRecordOrNull = (v: unknown): Record<string, unknown> | null => {
			if (v && typeof v === "object" && !Array.isArray(v))
				return v as Record<string, unknown>;
			if (typeof v === "string") {
				const result = parseJsonField<Record<string, unknown>>(v);
				if (result && typeof result === "object" && !Array.isArray(result))
					return result;
				return null;
			}
			return null;
		};

		const mappedKeys = keys.map((key) => ({
			id: key.id,
			organizationId: key.organizationId,
			name: key.name,
			description: toStringOrNull(key.description),
			keyPreview: key.keyPreview,
			purpose: key.purpose,
			scopes: filterScopes(key.scopes),
			descopeClientId: null as string | null,
			environment: toValidEnvironment(key.environment),
			lastUsedAt: toStringOrNull(key.lastUsedAt),
			requestsThisMonth: toNumberOrNull(key.requestsThisMonth),
			totalRequests: toNumberOrNull(key.totalRequests),
			ipAllowlist: toStringArrayOrNull(key.ipAllowlist),
			expiresAt: toStringOrNull(key.expiresAt),
			status: toValidStatus(key.status),
			rotatedAt: toStringOrNull(key.rotatedAt),
			rotationScheduleDays: toNumberOrNull(key.rotationScheduleDays),
			previousKeyExpiresAt: toStringOrNull(key.previousKeyExpiresAt),
			revokedAt: toStringOrNull(key.revokedAt),
			revokedBy: toStringOrNull(key.revokedBy),
			revokeReason: toStringOrNull(key.revokeReason),
			metadata: toRecordOrNull(key.metadata),
			createdBy: toStringOrNull(key.createdBy),
			createdAt: toStringOrNull(key.createdAt),
			updatedAt: toStringOrNull(key.updatedAt),
		}));

		return {
			data: mappedKeys,
			pagination: {
				limit,
				offset,
				total,
				hasMore: offset + mappedKeys.length < total,
			},
		};
	});

/**
 * Contract-based createApiKey procedure implementation
 */
export const createApiKeyContract = authedOrganizationsOs.createApiKey
	.use(AUTHZ.apiKeysAdmin)
	.handler(async ({ input, context }) => {
		const { db, user } = context as BaseContext & {
			user?: JWTPayload;
		};
		const { organizationId, ...keyData } = input;

		requireOrganizationAccess(context, organizationId);
		requireAdminOrOwner(context);
		// Creation follows the Cloudflare-style dashboard boundary: the active
		// authenticated admin session, explicit least-privilege scope selection,
		// and a client-side review step authorize issuance. Rotation remains
		// step-up gated because it replaces an already-deployed credential.

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		const bootstrap = keyData.purpose === "external_agent_bootstrap";
		if (
			bootstrap &&
			(!keyData.expiresAt || Date.parse(keyData.expiresAt) <= Date.now())
		)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Bootstrap credentials require a future expiresAt",
			);
		const scopes = bootstrap ? [] : keyData.scopes;
		assertDelegatableApiKeyScopes(context, scopes ?? []);

		// API keys are pure D1 — no external provider integration needed
		const result = await createApiKeyDb(db, {
			organizationId,
			name: keyData.name,
			description: keyData.description,
			purpose: keyData.purpose,
			scopes,
			environment: keyData.environment as "test" | "live" | undefined,
			ipAllowlist: keyData.ipAllowlist,
			expiresAt: keyData.expiresAt,
			rotationScheduleDays: keyData.rotationScheduleDays,
			createdBy: user?.sub,
		});

		return {
			rawKey: result.rawKey,
			apiKey: {
				id: result.apiKey.id,
				organizationId: result.apiKey.organizationId,
				name: result.apiKey.name,
				description: result.apiKey.description,
				keyPreview: result.apiKey.keyPreview,
				purpose: result.apiKey.purpose,
				scopes: result.apiKey.scopes,
				descopeClientId: null,
				environment: result.apiKey.environment,
				lastUsedAt: result.apiKey.lastUsedAt,
				requestsThisMonth: result.apiKey.requestsThisMonth,
				totalRequests: result.apiKey.totalRequests,
				ipAllowlist: result.apiKey.ipAllowlist,
				expiresAt: result.apiKey.expiresAt,
				status: result.apiKey.status,
				rotatedAt: result.apiKey.rotatedAt ?? null,
				rotationScheduleDays: result.apiKey.rotationScheduleDays ?? null,
				previousKeyExpiresAt: result.apiKey.previousKeyExpiresAt ?? null,
				revokedAt: result.apiKey.revokedAt,
				revokedBy: result.apiKey.revokedBy,
				revokeReason: result.apiKey.revokeReason,
				metadata: result.apiKey.metadata as Record<string, unknown> | null,
				createdBy: result.apiKey.createdBy,
				createdAt: result.apiKey.createdAt,
				updatedAt: result.apiKey.updatedAt,
			},
		};
	});

/**
 * Contract-based revokeApiKey procedure implementation
 */
export const revokeApiKeyContract = authedOrganizationsOs.revokeApiKey
	.use(AUTHZ.apiKeysAdmin)
	.handler(async ({ input, context }) => {
		const { db, user } = context as BaseContext & {
			user?: JWTPayload;
		};
		const { organizationId, keyId, reason } = input;

		requireOrganizationAccess(context, organizationId);
		requireAdminOrOwner(context);

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		const apiKey = await getApiKeyById(db, keyId);
		if (!apiKey) {
			throw createError(ErrorCodes.NOT_FOUND, "API key not found");
		}

		if (apiKey.organizationId !== organizationId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"API key does not belong to this organization",
			);
		}

		const revoked = await revokeApiKeyDb(db, keyId, user?.sub, reason);

		return {
			id: revoked.id,
			organizationId: revoked.organizationId,
			name: revoked.name,
			description: revoked.description,
			keyPreview: revoked.keyPreview,
			purpose: revoked.purpose,
			scopes: revoked.scopes,
			descopeClientId: null,
			environment: revoked.environment,
			lastUsedAt: revoked.lastUsedAt,
			requestsThisMonth: revoked.requestsThisMonth,
			totalRequests: revoked.totalRequests,
			ipAllowlist: revoked.ipAllowlist,
			expiresAt: revoked.expiresAt,
			status: revoked.status,
			rotatedAt: revoked.rotatedAt ?? null,
			rotationScheduleDays: revoked.rotationScheduleDays ?? null,
			previousKeyExpiresAt: revoked.previousKeyExpiresAt ?? null,
			revokedAt: revoked.revokedAt,
			revokedBy: revoked.revokedBy,
			revokeReason: revoked.revokeReason,
			metadata: revoked.metadata as Record<string, unknown> | null,
			createdBy: revoked.createdBy,
			createdAt: revoked.createdAt,
			updatedAt: revoked.updatedAt,
		};
	});

/**
 * Contract-based deleteApiKey procedure implementation
 */
export const deleteApiKeyContract = authedOrganizationsOs.deleteApiKey
	.use(AUTHZ.apiKeysAdmin)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, keyId } = input;

		requireOrganizationAccess(context, organizationId);

		// Require owner for hard delete
		const role = context.userRole;
		if (role !== "owner") {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only organization owners can delete API keys. Use revoke instead.",
			);
		}

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		const apiKey = await getApiKeyById(db, keyId);
		if (!apiKey) {
			throw createError(ErrorCodes.NOT_FOUND, "API key not found");
		}

		if (apiKey.organizationId !== organizationId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"API key does not belong to this organization",
			);
		}

		await deleteApiKeyDb(db, keyId);

		return { success: true as const };
	});

/**
 * Contract-based rotateApiKey procedure implementation
 * Generates a new key with 24-hour grace period for the old key
 *
 * Step-up gated. Rotation mints a live credential for the organization, so a
 * hijacked session can use it to issue itself a key the real owner never sees
 * — the grace period on the old key limits the disruption, not the theft.
 */
export const rotateApiKeyContract = authedOrganizationsOs.rotateApiKey
	.use(AUTHZ.apiKeysAdmin)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, keyId } = input;

		requireOrganizationAccess(context, organizationId);
		requireAdminOrOwner(context);
		requireStepUp(context, "Rotating an API key");

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		const apiKey = await getApiKeyById(db, keyId);
		if (!apiKey) {
			throw createError(ErrorCodes.NOT_FOUND, "API key not found");
		}

		if (apiKey.organizationId !== organizationId) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"API key does not belong to this organization",
			);
		}

		if (apiKey.status !== "active") {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Cannot rotate a ${apiKey.status} API key`,
			);
		}

		const result = await rotateApiKeyDb(db, keyId);

		return {
			rawKey: result.rawKey,
			apiKey: {
				id: result.apiKey.id,
				organizationId: result.apiKey.organizationId,
				name: result.apiKey.name,
				description: result.apiKey.description ?? null,
				keyPreview: result.apiKey.keyPreview,
				purpose: result.apiKey.purpose,
				scopes: result.apiKey.scopes,
				descopeClientId: null,
				environment: result.apiKey.environment,
				lastUsedAt: result.apiKey.lastUsedAt ?? null,
				requestsThisMonth: result.apiKey.requestsThisMonth ?? null,
				totalRequests: result.apiKey.totalRequests ?? null,
				ipAllowlist: result.apiKey.ipAllowlist ?? null,
				expiresAt: result.apiKey.expiresAt ?? null,
				status: result.apiKey.status,
				rotatedAt: result.apiKey.rotatedAt ?? null,
				rotationScheduleDays: result.apiKey.rotationScheduleDays ?? null,
				previousKeyExpiresAt: result.apiKey.previousKeyExpiresAt ?? null,
				revokedAt: result.apiKey.revokedAt ?? null,
				revokedBy: result.apiKey.revokedBy ?? null,
				revokeReason: result.apiKey.revokeReason ?? null,
				metadata: (result.apiKey.metadata as Record<string, unknown>) ?? null,
				createdBy: result.apiKey.createdBy ?? null,
				createdAt: result.apiKey.createdAt ?? null,
				updatedAt: result.apiKey.updatedAt ?? null,
			},
		};
	});

/**
 * Contract-based getExpiringKeys procedure implementation
 * Returns keys approaching expiry or overdue for rotation
 */
export const getExpiringKeysContract = authedOrganizationsOs.getExpiringKeys
	.use(AUTHZ.apiKeysAdmin)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, withinDays } = input;

		requireOrganizationAccess(context, organizationId);

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		const keys = await getExpiringKeysDb(db, organizationId, withinDays);

		return {
			data: keys.map((key) => ({
				id: key.id,
				organizationId: key.organizationId,
				name: key.name,
				description: key.description ?? null,
				keyPreview: key.keyPreview,
				purpose: key.purpose,
				scopes: key.scopes,
				descopeClientId: null as string | null,
				environment: key.environment,
				lastUsedAt: key.lastUsedAt ?? null,
				requestsThisMonth: key.requestsThisMonth ?? null,
				totalRequests: key.totalRequests ?? null,
				ipAllowlist: key.ipAllowlist ?? null,
				expiresAt: key.expiresAt ?? null,
				status: key.status,
				rotatedAt: key.rotatedAt ?? null,
				rotationScheduleDays: key.rotationScheduleDays ?? null,
				previousKeyExpiresAt: key.previousKeyExpiresAt ?? null,
				revokedAt: key.revokedAt ?? null,
				revokedBy: key.revokedBy ?? null,
				revokeReason: key.revokeReason ?? null,
				metadata: (key.metadata as Record<string, unknown>) ?? null,
				createdBy: key.createdBy ?? null,
				createdAt: key.createdAt ?? null,
				updatedAt: key.updatedAt ?? null,
				warningType: key.warningType,
			})),
		};
	});

/**
 * Reject a key that would carry more authority than the caller may delegate.
 *
 * The deny-list is `PLATFORM_ONLY_API_KEY_SCOPES` in the contract, NOT a local
 * literal, because the OS admin scope picker builds itself by subtracting
 * the same constant. When the two were written separately the picker offered
 * `["*"]` unconditionally and this guard refused it, so an ordinary tenant
 * admin could not create an API key at all.
 */
export function assertDelegatableApiKeyScopes(
	context: BaseContext,
	scopes: readonly string[],
): void {
	if (isPlatformPrincipal(context)) return;
	const forbidden = scopes.filter((scope) =>
		(PLATFORM_ONLY_API_KEY_SCOPES as readonly string[]).includes(scope),
	);
	if (forbidden.length > 0) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			`Platform authority is required to mint a key with: ${forbidden.join(", ")}`,
		);
	}
}
