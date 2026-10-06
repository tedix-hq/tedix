/**
 * App Adapter Secret Bindings Query Functions
 *
 * CRUD operations and hydration queries for adapter-secret bindings.
 * Provides batch fetching for efficient hydration of multiple adapters.
 *
 * @module @tedix/db/queries/app-adapter-secret-bindings
 */

import { and, eq, inArray } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type AppAdapterSecretBinding,
	appAdapterSecretBindings,
	type SafeBindingMetadata,
	type SecretScope,
} from "../schema/app-adapter-secret-bindings";
import { appSecrets } from "../schema/app-secrets";
import { organizationSecrets } from "../schema/organization-secrets";
import { chunkForBoundParams } from "../utils/batch";
import { prefixedColumns } from "../utils/select";

/** D1 caps bound parameters at 100 per statement; keep IN() lists ≤50. */
const D1_IN_LIST_CHUNK = 50;

// =============================================================================
// READ OPERATIONS
// =============================================================================

/**
 * List all bindings for an adapter
 * Returns safe metadata without decrypted values
 *
 * @param db - Database client
 * @param adapterId - Adapter ID to get bindings for
 */
export async function listBindingsForAdapter(
	db: DbClient,
	adapterId: string,
): Promise<SafeBindingMetadata[]> {
	// Query bindings with left joins to get secret metadata.
	//
	// The two secrets tables both have `name` and `hint`, and an unaliased
	// projection emits each name twice — D1 collapses the pair, so the org side
	// (NULL for an app-scoped binding) overwrote the app secret's values and
	// every field after it shifted. App-scoped bindings came back with
	// secretName/secretHint null, which is the operator UI's whole secret label.
	const appSecret = prefixedColumns(appSecrets, "appSecret");
	const orgSecret = prefixedColumns(organizationSecrets, "orgSecret");

	const results = await db
		.select({
			id: appAdapterSecretBindings.id,
			adapterId: appAdapterSecretBindings.adapterId,
			appId: appAdapterSecretBindings.appId,
			configPath: appAdapterSecretBindings.configPath,
			secretId: appAdapterSecretBindings.secretId,
			secretScope: appAdapterSecretBindings.secretScope,
			createdAt: appAdapterSecretBindings.createdAt,
			updatedAt: appAdapterSecretBindings.updatedAt,
			// App secret metadata (may be null)
			appSecretName: appSecret.name,
			appSecretHint: appSecret.hint,
			// Org secret metadata (may be null)
			orgSecretName: orgSecret.name,
			orgSecretHint: orgSecret.hint,
		})
		.from(appAdapterSecretBindings)
		.leftJoin(
			appSecrets,
			and(
				eq(appAdapterSecretBindings.secretScope, "app"),
				eq(appAdapterSecretBindings.secretId, appSecrets.id),
			),
		)
		.leftJoin(
			organizationSecrets,
			and(
				eq(appAdapterSecretBindings.secretScope, "organization"),
				eq(appAdapterSecretBindings.secretId, organizationSecrets.id),
			),
		)
		.where(eq(appAdapterSecretBindings.adapterId, adapterId));

	return results.map((row) => ({
		id: row.id,
		adapterId: row.adapterId,
		appId: row.appId,
		configPath: row.configPath,
		secretId: row.secretId,
		secretScope: row.secretScope,
		secretName: row.appSecretName || row.orgSecretName || null,
		secretHint: row.appSecretHint || row.orgSecretHint || null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}));
}

/**
 * List all bindings for an app (across all adapters)
 * Useful for app-level secret audit
 *
 * @param db - Database client
 * @param appId - App ID to get bindings for
 */
export async function listBindingsForApp(
	db: DbClient,
	appId: string,
): Promise<SafeBindingMetadata[]> {
	// Prefixed, not bare: `app_secrets` and `organization_secrets` both expose
	// `name` and `hint`, so the select list emitted each of those names twice, D1
	// collapsed the pairs, and an app-scoped binding decoded the org join's NULLs
	// — every app-scoped secret in this audit came back with no name and no hint.
	const appSecretColumns = prefixedColumns(appSecrets, "appSecret");
	const orgSecretColumns = prefixedColumns(organizationSecrets, "orgSecret");

	const results = await db
		.select({
			id: appAdapterSecretBindings.id,
			adapterId: appAdapterSecretBindings.adapterId,
			appId: appAdapterSecretBindings.appId,
			configPath: appAdapterSecretBindings.configPath,
			secretId: appAdapterSecretBindings.secretId,
			secretScope: appAdapterSecretBindings.secretScope,
			createdAt: appAdapterSecretBindings.createdAt,
			updatedAt: appAdapterSecretBindings.updatedAt,
			appSecretName: appSecretColumns.name,
			appSecretHint: appSecretColumns.hint,
			orgSecretName: orgSecretColumns.name,
			orgSecretHint: orgSecretColumns.hint,
		})
		.from(appAdapterSecretBindings)
		.leftJoin(
			appSecrets,
			and(
				eq(appAdapterSecretBindings.secretScope, "app"),
				eq(appAdapterSecretBindings.secretId, appSecrets.id),
			),
		)
		.leftJoin(
			organizationSecrets,
			and(
				eq(appAdapterSecretBindings.secretScope, "organization"),
				eq(appAdapterSecretBindings.secretId, organizationSecrets.id),
			),
		)
		.where(eq(appAdapterSecretBindings.appId, appId));

	return results.map((row) => ({
		id: row.id,
		adapterId: row.adapterId,
		appId: row.appId,
		configPath: row.configPath,
		secretId: row.secretId,
		secretScope: row.secretScope,
		secretName: row.appSecretName || row.orgSecretName || null,
		secretHint: row.appSecretHint || row.orgSecretHint || null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}));
}

/**
 * Get all bindings for multiple adapters (batch query)
 * Returns map: adapterId → bindings[]
 *
 * Used for efficient hydration of multiple adapters at once.
 *
 * @param db - Database client
 * @param adapterIds - Array of adapter IDs to get bindings for
 */
export async function getBindingsBatch(
	db: DbClient,
	adapterIds: string[],
): Promise<Map<string, AppAdapterSecretBinding[]>> {
	if (adapterIds.length === 0) return new Map();

	// Group by adapter ID
	const map = new Map<string, AppAdapterSecretBinding[]>();
	for (const chunk of chunkForBoundParams(
		[...new Set(adapterIds)],
		D1_IN_LIST_CHUNK,
	)) {
		const bindings = await db
			.select()
			.from(appAdapterSecretBindings)
			.where(inArray(appAdapterSecretBindings.adapterId, chunk));
		for (const binding of bindings) {
			const existing = map.get(binding.adapterId) || [];
			existing.push(binding);
			map.set(binding.adapterId, existing);
		}
	}

	return map;
}

/**
 * Get a single binding by ID
 *
 * @param db - Database client
 * @param bindingId - Binding ID
 */
export async function getBindingById(
	db: DbClient,
	bindingId: string,
): Promise<AppAdapterSecretBinding | undefined> {
	const rows = await db
		.select()
		.from(appAdapterSecretBindings)
		.where(eq(appAdapterSecretBindings.id, bindingId))
		.limit(1);
	return rows[0];
}

/**
 * Get a single binding by adapter and config path
 *
 * @param db - Database client
 * @param adapterId - Adapter ID
 * @param configPath - Config path in dot notation
 */
async function getBindingByPath(
	db: DbClient,
	adapterId: string,
	configPath: string,
): Promise<AppAdapterSecretBinding | undefined> {
	const rows = await db
		.select()
		.from(appAdapterSecretBindings)
		.where(
			and(
				eq(appAdapterSecretBindings.adapterId, adapterId),
				eq(appAdapterSecretBindings.configPath, configPath),
			),
		)
		.limit(1);
	return rows[0];
}

// =============================================================================
// WRITE OPERATIONS
// =============================================================================

/**
 * Set a binding (upsert)
 * Creates new binding or updates existing if config path already bound
 *
 * @param db - Database client
 * @param adapterId - Adapter ID
 * @param appId - App ID (for denormalized queries)
 * @param configPath - Config path in dot notation
 * @param secretId - Secret ID (app_secrets.id or organization_secrets.id)
 * @param secretScope - Secret scope discriminator
 */
export async function setBinding(
	db: DbClient,
	adapterId: string,
	appId: string,
	configPath: string,
	secretId: string,
	secretScope: SecretScope,
): Promise<AppAdapterSecretBinding> {
	const now = new Date().toISOString();

	// Check if binding already exists for this config path
	const existing = await getBindingByPath(db, adapterId, configPath);

	if (existing) {
		// Update existing binding
		await db
			.update(appAdapterSecretBindings)
			.set({
				secretId,
				secretScope,
				updatedAt: now,
			})
			.where(eq(appAdapterSecretBindings.id, existing.id));

		const updated = await getBindingById(db, existing.id);
		if (!updated) {
			throw new Error(`Failed to update binding: ${existing.id}`);
		}
		return updated;
	}

	// Create new binding
	const id = crypto.randomUUID();

	await db.insert(appAdapterSecretBindings).values({
		id,
		adapterId,
		appId,
		configPath,
		secretId,
		secretScope,
		createdAt: now,
		updatedAt: now,
	});

	const created = await getBindingById(db, id);
	if (!created) {
		throw new Error(`Failed to create binding: ${id}`);
	}
	return created;
}

/**
 * Delete a binding by ID
 *
 * @param db - Database client
 * @param bindingId - Binding ID to delete
 * @returns true if deleted, false if not found
 */
export async function deleteBinding(
	db: DbClient,
	bindingId: string,
): Promise<boolean> {
	const existing = await getBindingById(db, bindingId);
	if (!existing) {
		return false;
	}

	await db
		.delete(appAdapterSecretBindings)
		.where(eq(appAdapterSecretBindings.id, bindingId));

	return true;
}

/**
 * Delete binding by adapter and config path
 * More ergonomic than deleteBinding for API endpoints
 *
 * @param db - Database client
 * @param adapterId - Adapter ID
 * @param configPath - Config path in dot notation
 * @returns true if deleted, false if not found
 */
export async function deleteBindingByPath(
	db: DbClient,
	adapterId: string,
	configPath: string,
): Promise<boolean> {
	const existing = await getBindingByPath(db, adapterId, configPath);
	if (!existing) {
		return false;
	}

	await db
		.delete(appAdapterSecretBindings)
		.where(eq(appAdapterSecretBindings.id, existing.id));

	return true;
}

// =============================================================================
// VALIDATION HELPERS
// =============================================================================

/**
 * List all adapters that reference a specific secret
 * Useful for showing "secret in use by X adapters" in an operator UI
 *
 * @param db - Database client
 * @param secretId - Secret ID
 * @param secretScope - Secret scope
 */
export async function listAdaptersUsingSecret(
	db: DbClient,
	secretId: string,
	secretScope: SecretScope,
): Promise<string[]> {
	const results = await db
		.select({ adapterId: appAdapterSecretBindings.adapterId })
		.from(appAdapterSecretBindings)
		.where(
			and(
				eq(appAdapterSecretBindings.secretId, secretId),
				eq(appAdapterSecretBindings.secretScope, secretScope),
			),
		);

	return results.map((r) => r.adapterId);
}

/**
 * Get unique secret IDs used by bindings, grouped by scope
 * Used for batch fetching secrets during hydration
 *
 * @param db - Database client
 * @param adapterIds - Array of adapter IDs
 */
export async function getUniqueSecretIds(
	db: DbClient,
	adapterIds: string[],
): Promise<{ appSecretIds: string[]; orgSecretIds: string[] }> {
	if (adapterIds.length === 0) {
		return { appSecretIds: [], orgSecretIds: [] };
	}

	const appSecretIds = new Set<string>();
	const orgSecretIds = new Set<string>();

	for (const chunk of chunkForBoundParams(
		[...new Set(adapterIds)],
		D1_IN_LIST_CHUNK,
	)) {
		const bindings = await db
			.select({
				secretId: appAdapterSecretBindings.secretId,
				secretScope: appAdapterSecretBindings.secretScope,
			})
			.from(appAdapterSecretBindings)
			.where(inArray(appAdapterSecretBindings.adapterId, chunk));

		for (const binding of bindings) {
			if (binding.secretScope === "app") {
				appSecretIds.add(binding.secretId);
			} else if (binding.secretScope === "organization") {
				orgSecretIds.add(binding.secretId);
			}
		}
	}

	return {
		appSecretIds: Array.from(appSecretIds),
		orgSecretIds: Array.from(orgSecretIds),
	};
}

// =============================================================================
// BATCH FETCH FOR HYDRATION
// =============================================================================

/**
 * Encrypted secret record for batch fetching
 */
export interface EncryptedSecretRecord {
	id: string;
	encryptedValue: string;
}

/**
 * Batch fetch app secrets by IDs (for hydration)
 * Returns encrypted values - caller must decrypt
 *
 * @param db - Database client
 * @param appId - App ID to filter by
 * @param secretIds - Array of secret IDs to fetch
 */
export async function fetchAppSecretsForHydration(
	db: DbClient,
	appId: string,
	secretIds: string[],
): Promise<EncryptedSecretRecord[]> {
	if (secretIds.length === 0) return [];

	const secrets: EncryptedSecretRecord[] = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(secretIds)],
		D1_IN_LIST_CHUNK,
	)) {
		secrets.push(
			...(await db
				.select({
					id: appSecrets.id,
					encryptedValue: appSecrets.encryptedValue,
				})
				.from(appSecrets)
				.where(
					and(eq(appSecrets.appId, appId), inArray(appSecrets.id, chunk)),
				)),
		);
	}

	return secrets;
}

/**
 * Batch fetch organization secrets by IDs (for hydration)
 * Returns encrypted values - caller must decrypt
 *
 * @param db - Database client
 * @param orgId - Organization ID to filter by
 * @param secretIds - Array of secret IDs to fetch
 */
export async function fetchOrgSecretsForHydration(
	db: DbClient,
	orgId: string,
	secretIds: string[],
): Promise<EncryptedSecretRecord[]> {
	if (secretIds.length === 0) return [];

	const secrets: EncryptedSecretRecord[] = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(secretIds)],
		D1_IN_LIST_CHUNK,
	)) {
		secrets.push(
			...(await db
				.select({
					id: organizationSecrets.id,
					encryptedValue: organizationSecrets.encryptedValue,
				})
				.from(organizationSecrets)
				.where(
					and(
						eq(organizationSecrets.organizationId, orgId),
						inArray(organizationSecrets.id, chunk),
					),
				)),
		);
	}

	return secrets;
}
