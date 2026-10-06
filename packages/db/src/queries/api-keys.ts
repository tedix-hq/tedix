/**
 * API Key Query Helpers
 * Database queries for API key management
 *
 * API keys are organization-scoped and can have different environments and scopes.
 * Keys are hashed for security - the raw key is only shown once at creation.
 */

import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import type {
	ApiKey,
	ApiKeyEnvironment,
	ApiKeyMetadata,
	ApiKeyScope,
	ApiKeyStatus,
} from "../schema/api-keys";
import { apiKeys, generateApiKey, hashApiKey } from "../schema/api-keys";

// ============================================================================
// Read Operations
// ============================================================================

/**
 * Get API key by ID
 *
 * @param db - Database client
 * @param id - API key ID
 */
export async function getApiKeyById(
	db: DbClient,
	id: string,
): Promise<ApiKey | undefined> {
	return db.query.apiKeys.findFirst({ where: { id } });
}

/**
 * Get API key by hash
 * Used for authenticating requests
 *
 * @param db - Database client
 * @param keyHash - SHA-256 hash of the API key
 */
export async function getApiKeyByHash(
	db: DbClient,
	keyHash: string,
): Promise<ApiKey | undefined> {
	return db.query.apiKeys.findFirst({ where: { keyHash } });
}

/**
 * Get all API keys for an organization
 *
 * @param db - Database client
 * @param organizationId - Organization ID
 * @param opts - Filter options
 */
export async function getApiKeysByOrganization(
	db: DbClient,
	organizationId: string,
	opts?: {
		status?: ApiKeyStatus;
		environment?: ApiKeyEnvironment;
		limit?: number;
		offset?: number;
	},
): Promise<ApiKey[]> {
	const conditions = [eq(apiKeys.organizationId, organizationId)];
	if (opts?.status) conditions.push(eq(apiKeys.status, opts.status));
	if (opts?.environment)
		conditions.push(eq(apiKeys.environment, opts.environment));

	return db
		.select()
		.from(apiKeys)
		.where(and(...conditions))
		.orderBy(sql`${apiKeys.createdAt} DESC`)
		.limit(opts?.limit ?? 50)
		.offset(opts?.offset ?? 0);
}

// ============================================================================
// Write Operations
// ============================================================================

/**
 * Create a new API key
 * Returns the raw key (show to user once) and the stored key object
 *
 * @param db - Database client
 * @param data - API key data
 * @returns Object with raw key (show once) and stored key
 */
export async function createApiKey(
	db: DbClient,
	data: {
		organizationId: string;
		name: string;
		description?: string;
		scopes?: ApiKeyScope[];
		environment?: ApiKeyEnvironment;
		ipAllowlist?: string[];
		expiresAt?: string;
		rotationScheduleDays?: number;
		createdBy?: string;
	},
): Promise<{ rawKey: string; apiKey: ApiKey }> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const environment = data.environment ?? "test";

	// Generate key
	const { key, preview } = generateApiKey(environment);
	const keyHash = await hashApiKey(key);

	await db.insert(apiKeys).values({
		id,
		organizationId: data.organizationId,
		name: data.name,
		description: data.description,
		keyHash,
		keyPreview: preview,
		scopes: data.scopes ?? ["apps:read"],
		environment,
		ipAllowlist: data.ipAllowlist,
		expiresAt: data.expiresAt,
		rotationScheduleDays: data.rotationScheduleDays,
		createdBy: data.createdBy,
		createdAt: now,
		updatedAt: now,
	});

	const created = await getApiKeyById(db, id);
	if (!created) {
		throw new Error(`Failed to create API key: ${id}`);
	}

	return { rawKey: key, apiKey: created };
}

/**
 * Revoke an API key
 * Note: This only updates D1 status. Caller is responsible for deleting Descope M2M client.
 *
 * @param db - Database client
 * @param id - API key ID
 * @param revokedBy - Descope user ID who revoked
 * @param reason - Optional reason for revocation
 */
export async function revokeApiKey(
	db: DbClient,
	id: string,
	revokedBy?: string,
	reason?: string,
): Promise<ApiKey> {
	const now = new Date().toISOString();

	const [updated] = await db
		.update(apiKeys)
		.set({
			status: "revoked",
			revokedAt: now,
			revokedBy,
			revokeReason: reason,
			updatedAt: now,
		})
		.where(eq(apiKeys.id, id))
		.returning();

	if (!updated) {
		throw new Error(`API key not found: ${id}`);
	}
	return updated;
}

/**
 * Delete an API key (hard delete)
 * Consider revokeApiKey for audit trail
 * Note: This only deletes from D1. Caller is responsible for deleting Descope M2M client.
 *
 * @param db - Database client
 * @param id - API key ID
 */
export async function deleteApiKey(db: DbClient, id: string): Promise<void> {
	await db.delete(apiKeys).where(eq(apiKeys.id, id));
}

// ============================================================================
// Rotation
// ============================================================================

/**
 * Rotate an API key
 * Generates a new key, stores the old hash in previousKeyHash with a 24-hour grace period.
 *
 * @param db - Database client
 * @param id - API key ID
 * @returns Object with new raw key (show once) and updated key record
 */
export async function rotateApiKey(
	db: DbClient,
	id: string,
): Promise<{ rawKey: string; apiKey: ApiKey }> {
	const existing = await getApiKeyById(db, id);
	if (!existing) {
		throw new Error(`API key not found: ${id}`);
	}

	if (existing.status !== "active") {
		throw new Error(`Cannot rotate a ${existing.status} API key`);
	}

	const environment = (existing.environment ?? "test") as ApiKeyEnvironment;
	const { key, preview } = generateApiKey(environment);
	const newKeyHash = await hashApiKey(key);

	const now = new Date();
	const gracePeriodEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours

	const [updated] = await db
		.update(apiKeys)
		.set({
			keyHash: newKeyHash,
			keyPreview: preview,
			previousKeyHash: existing.keyHash,
			previousKeyExpiresAt: gracePeriodEnd.toISOString(),
			rotatedAt: now.toISOString(),
			updatedAt: now.toISOString(),
		})
		.where(eq(apiKeys.id, id))
		.returning();

	if (!updated) {
		throw new Error(`Failed to rotate API key: ${id}`);
	}

	return { rawKey: key, apiKey: updated };
}

/**
 * Find API key by its previous (rotated) key hash
 * Only returns if the previous key hasn't expired its grace period
 *
 * @param db - Database client
 * @param keyHash - SHA-256 hash of the previous API key
 */
export async function getApiKeyByPreviousHash(
	db: DbClient,
	keyHash: string,
): Promise<ApiKey | undefined> {
	const now = new Date().toISOString();

	const [result] = await db
		.select()
		.from(apiKeys)
		.where(
			and(
				eq(apiKeys.previousKeyHash, keyHash),
				eq(apiKeys.status, "active"),
				sql`${apiKeys.previousKeyExpiresAt} IS NOT NULL`,
				sql`${apiKeys.previousKeyExpiresAt} > ${now}`,
			),
		)
		.limit(1);
	return result;
}

/**
 * Get API keys that are approaching expiry or overdue for rotation
 * Returns keys expiring within `withinDays` days, or keys overdue for rotation
 * based on their `rotationScheduleDays` setting.
 *
 * @param db - Database client
 * @param organizationId - Organization ID
 * @param withinDays - Number of days to look ahead for expiry (default: 7)
 */
export async function getExpiringKeys(
	db: DbClient,
	organizationId: string,
	withinDays = 7,
): Promise<Array<ApiKey & { warningType: "expiring" | "rotation_overdue" }>> {
	const now = new Date();
	const futureDate = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

	// Get active keys for this org
	const activeKeys = await db
		.select()
		.from(apiKeys)
		.where(
			and(
				eq(apiKeys.organizationId, organizationId),
				eq(apiKeys.status, "active"),
			),
		);

	const results: Array<
		ApiKey & { warningType: "expiring" | "rotation_overdue" }
	> = [];

	for (const key of activeKeys) {
		// Check expiry
		if (key.expiresAt) {
			const expiresAt = new Date(key.expiresAt);
			if (expiresAt <= futureDate) {
				results.push({ ...key, warningType: "expiring" });
				continue;
			}
		}

		// Check rotation schedule
		if (key.rotationScheduleDays) {
			const lastRotated = key.rotatedAt
				? new Date(key.rotatedAt)
				: new Date(key.createdAt ?? now.toISOString());
			const nextRotation = new Date(
				lastRotated.getTime() + key.rotationScheduleDays * 24 * 60 * 60 * 1000,
			);
			if (nextRotation <= futureDate) {
				results.push({ ...key, warningType: "rotation_overdue" });
			}
		}
	}

	return results;
}

// ============================================================================
// Usage Tracking
// ============================================================================

/**
 * Record API key usage
 * Updates lastUsedAt and increments request counters
 *
 * @param db - Database client
 * @param id - API key ID
 * @param metadata - Optional metadata about the request
 */
export async function recordUsage(
	db: DbClient,
	id: string,
	metadata?: { userAgent?: string; ipAddress?: string },
): Promise<void> {
	const now = new Date().toISOString();

	const updateData: Record<string, unknown> = {
		lastUsedAt: now,
		requestsThisMonth: sql`${apiKeys.requestsThisMonth} + 1`,
		totalRequests: sql`${apiKeys.totalRequests} + 1`,
		updatedAt: now,
	};

	// Update metadata if provided
	if (metadata) {
		const key = await getApiKeyById(db, id);
		if (key) {
			const newMetadata: ApiKeyMetadata = {
				...key.metadata,
				...(metadata.userAgent && { lastUserAgent: metadata.userAgent }),
				...(metadata.ipAddress && { lastIpAddress: metadata.ipAddress }),
			};
			updateData.metadata = newMetadata;
		}
	}

	await db.update(apiKeys).set(updateData).where(eq(apiKeys.id, id));
}
