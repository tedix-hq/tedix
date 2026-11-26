/**
 * App Adapter Secret Bindings Query Functions
 *
 * CRUD operations and hydration queries for adapter-secret bindings.
 * Provides batch fetching for efficient hydration of multiple adapters.
 *
 * @module @tedix/db/queries/app-adapter-secret-bindings
 */

import { and, eq } from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { anyIds } from "../core-store/dialect";
import {
	type AppAdapterSecretBinding,
	appAdapterSecretBindings as schemaAppAdapterSecretBindings,
	type SafeBindingMetadata,
	type SecretScope,
} from "../schema/app-adapter-secret-bindings";
import { appSecrets as schemaAppSecrets } from "../schema/app-secrets";
import { organizationSecrets as schemaOrganizationSecrets } from "../schema/organization-secrets";
import { prefixedColumns } from "../utils/select";

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
	const appAdapterSecretBindings = coreTable(
		db,
		schemaAppAdapterSecretBindings,
	);
	const appSecrets = coreTable(db, schemaAppSecrets);
	const organizationSecrets = coreTable(db, schemaOrganizationSecrets);
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
	const appAdapterSecretBindings = coreTable(
		db,
		schemaAppAdapterSecretBindings,
	);
	const appSecrets = coreTable(db, schemaAppSecrets);
	const organizationSecrets = coreTable(db, schemaOrganizationSecrets);
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
	const appAdapterSecretBindings = coreTable(
		db,
		schemaAppAdapterSecretBindings,
	);
	if (adapterIds.length === 0) return new Map();

	// Group by adapter ID
	const map = new Map<string, AppAdapterSecretBinding[]>();
	const bindings = await db
		.select()
		.from(appAdapterSecretBindings)
		.where(
			anyIds(db, appAdapterSecretBindings.adapterId, [...new Set(adapterIds)]),
		);
	for (const binding of bindings) {
		const existing = map.get(binding.adapterId) || [];
		existing.push(binding);
		map.set(binding.adapterId, existing);
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
	const appAdapterSecretBindings = coreTable(
		db,
		schemaAppAdapterSecretBindings,
	);
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
	const appAdapterSecretBindings = coreTable(
		db,
		schemaAppAdapterSecretBindings,
	);
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
	const appAdapterSecretBindings = coreTable(
		db,
		schemaAppAdapterSecretBindings,
	);
	const now = new Date().toISOString();

	const [binding] = await db
		.insert(appAdapterSecretBindings)
		.values({
			id: crypto.randomUUID(),
			adapterId,
			appId,
			configPath,
			secretId,
			secretScope,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [
				appAdapterSecretBindings.adapterId,
				appAdapterSecretBindings.configPath,
			],
			set: { secretId, secretScope, updatedAt: now },
		})
		.returning();

	if (!binding) {
		throw new Error(`Failed to set binding: ${adapterId}/${configPath}`);
	}
	return binding;
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
	const appAdapterSecretBindings = coreTable(
		db,
		schemaAppAdapterSecretBindings,
	);
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
	const appAdapterSecretBindings = coreTable(
		db,
		schemaAppAdapterSecretBindings,
	);
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
	const appAdapterSecretBindings = coreTable(
		db,
		schemaAppAdapterSecretBindings,
	);
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
	const appAdapterSecretBindings = coreTable(
		db,
		schemaAppAdapterSecretBindings,
	);
	if (adapterIds.length === 0) {
		return { appSecretIds: [], orgSecretIds: [] };
	}

	const appSecretIds = new Set<string>();
	const orgSecretIds = new Set<string>();

	const bindings = await db
		.select({
			secretId: appAdapterSecretBindings.secretId,
			secretScope: appAdapterSecretBindings.secretScope,
		})
		.from(appAdapterSecretBindings)
		.where(
			anyIds(db, appAdapterSecretBindings.adapterId, [...new Set(adapterIds)]),
		);

	for (const binding of bindings) {
		if (binding.secretScope === "app") {
			appSecretIds.add(binding.secretId);
		} else if (binding.secretScope === "organization") {
			orgSecretIds.add(binding.secretId);
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
	const appSecrets = coreTable(db, schemaAppSecrets);
	if (secretIds.length === 0) return [];

	return db
		.select({ id: appSecrets.id, encryptedValue: appSecrets.encryptedValue })
		.from(appSecrets)
		.where(
			and(
				eq(appSecrets.appId, appId),
				anyIds(db, appSecrets.id, [...new Set(secretIds)]),
			),
		);
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
	const organizationSecrets = coreTable(db, schemaOrganizationSecrets);
	if (secretIds.length === 0) return [];

	return db
		.select({
			id: organizationSecrets.id,
			encryptedValue: organizationSecrets.encryptedValue,
		})
		.from(organizationSecrets)
		.where(
			and(
				eq(organizationSecrets.organizationId, orgId),
				anyIds(db, organizationSecrets.id, [...new Set(secretIds)]),
			),
		);
}
