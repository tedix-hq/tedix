/**
 * Organization Secrets Query Functions
 * CRUD operations for encrypted customer API keys and credentials
 */

import { and, eq } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type NewOrganizationSecret,
	type OrganizationSecret,
	organizationSecrets,
} from "../schema/organization-secrets";

// =============================================================================
// LIST / GET QUERIES
// =============================================================================

/**
 * List all secrets for an organization (metadata only, no encrypted values)
 * Safe to return to operator UIs - does not include actual secret values
 */
export async function listOrgSecrets(
	db: DbClient,
	organizationId: string,
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
	const results = await db
		.select({
			id: organizationSecrets.id,
			name: organizationSecrets.name,
			hint: organizationSecrets.hint,
			keyVersion: organizationSecrets.keyVersion,
			createdBy: organizationSecrets.createdBy,
			createdAt: organizationSecrets.createdAt,
			updatedAt: organizationSecrets.updatedAt,
		})
		.from(organizationSecrets)
		.where(eq(organizationSecrets.organizationId, organizationId));

	return results;
}

/**
 * Get a secret by organization ID and name
 * Returns full record including encrypted_value for decryption
 */
export async function getOrgSecret(
	db: DbClient,
	organizationId: string,
	name: string,
): Promise<OrganizationSecret | undefined> {
	return db.query.organizationSecrets.findFirst({
		where: { organizationId, name },
	});
}

/**
 * Get a secret by ID
 * Returns full record including encrypted_value
 */
export async function getOrgSecretById(
	db: DbClient,
	secretId: string,
): Promise<OrganizationSecret | undefined> {
	return db.query.organizationSecrets.findFirst({ where: { id: secretId } });
}

// =============================================================================
// CREATE / UPDATE / DELETE
// =============================================================================

/**
 * Create a new secret
 * Note: encrypted_value should already be encrypted before calling this
 */
export async function createOrgSecret(
	db: DbClient,
	data: Omit<NewOrganizationSecret, "id" | "createdAt" | "updatedAt">,
): Promise<OrganizationSecret> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	await db.insert(organizationSecrets).values({
		id,
		...data,
		createdAt: now,
		updatedAt: now,
	});

	const created = await getOrgSecretById(db, id);
	if (!created) {
		throw new Error("Failed to create organization secret");
	}

	return created;
}

/**
 * Update a secret (for rotation - new encrypted value)
 */
export async function updateOrgSecret(
	db: DbClient,
	secretId: string,
	updates: {
		encryptedValue?: string;
		hint?: string;
		keyVersion?: number;
	},
): Promise<OrganizationSecret | undefined> {
	const existing = await getOrgSecretById(db, secretId);
	if (!existing) {
		return undefined;
	}

	const now = new Date().toISOString();

	await db
		.update(organizationSecrets)
		.set({
			...updates,
			updatedAt: now,
		})
		.where(eq(organizationSecrets.id, secretId));

	return getOrgSecretById(db, secretId);
}

/**
 * Delete a secret
 */
export async function deleteOrgSecret(
	db: DbClient,
	secretId: string,
): Promise<boolean> {
	const existing = await getOrgSecretById(db, secretId);
	if (!existing) {
		return false;
	}

	await db
		.delete(organizationSecrets)
		.where(eq(organizationSecrets.id, secretId));

	return true;
}
