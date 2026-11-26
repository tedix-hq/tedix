/**
 * App Secrets Query Functions
 * CRUD operations for encrypted app-level API keys and credentials
 */

import { eq } from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import {
	type AppSecret,
	appSecrets as schemaAppSecrets,
	type NewAppSecret,
} from "../schema/app-secrets";

// =============================================================================
// LIST / GET QUERIES
// =============================================================================

/**
 * List all secrets for an app (metadata only, no encrypted values)
 * Safe to return to operator UIs - does not include actual secret values
 */
export async function listAppSecrets(
	db: DbClient,
	appId: string,
): Promise<
	Array<{
		id: string;
		name: string;
		hint: string | null;
		keyVersion: number;
		createdBy: string | null;
		createdAt: string;
		updatedAt: string;
	}>
> {
	const appSecrets = coreTable(db, schemaAppSecrets);
	const results = await db
		.select({
			id: appSecrets.id,
			name: appSecrets.name,
			hint: appSecrets.hint,
			keyVersion: appSecrets.keyVersion,
			createdBy: appSecrets.createdBy,
			createdAt: appSecrets.createdAt,
			updatedAt: appSecrets.updatedAt,
		})
		.from(appSecrets)
		.where(eq(appSecrets.appId, appId));

	return results;
}

/**
 * Get a secret by app ID and name
 * Returns full record including encrypted_value for decryption
 */
export async function getAppSecret(
	db: DbClient,
	appId: string,
	name: string,
): Promise<AppSecret | undefined> {
	return db.query.appSecrets.findFirst({ where: { appId, name } });
}

/**
 * Get a secret by ID
 * Returns full record including encrypted_value
 */
export async function getAppSecretById(
	db: DbClient,
	secretId: string,
): Promise<AppSecret | undefined> {
	return db.query.appSecrets.findFirst({ where: { id: secretId } });
}

// =============================================================================
// CREATE / UPDATE / DELETE
// =============================================================================

/**
 * Create a new app secret
 * Note: encrypted_value should already be encrypted before calling this
 */
export async function createAppSecret(
	db: DbClient,
	data: Omit<NewAppSecret, "id" | "createdAt" | "updatedAt">,
): Promise<AppSecret> {
	const appSecrets = coreTable(db, schemaAppSecrets);
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	const [created] = await db
		.insert(appSecrets)
		.values({
			id,
			...data,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	if (!created) {
		throw new Error("Failed to create app secret");
	}

	return created;
}

/**
 * Update a secret (for rotation - new encrypted value)
 */
export async function updateAppSecret(
	db: DbClient,
	secretId: string,
	updates: {
		encryptedValue?: string;
		hint?: string;
		keyVersion?: number;
	},
): Promise<AppSecret | undefined> {
	const appSecrets = coreTable(db, schemaAppSecrets);

	const now = new Date().toISOString();

	const [updated] = await db
		.update(appSecrets)
		.set({
			...updates,
			updatedAt: now,
		})
		.where(eq(appSecrets.id, secretId))
		.returning();

	return updated;
}

/**
 * Delete a secret
 */
export async function deleteAppSecret(
	db: DbClient,
	secretId: string,
): Promise<boolean> {
	const appSecrets = coreTable(db, schemaAppSecrets);
	const deleted = await db
		.delete(appSecrets)
		.where(eq(appSecrets.id, secretId))
		.returning({ id: appSecrets.id });
	return deleted.length > 0;
}
