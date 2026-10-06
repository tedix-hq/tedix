/**
 * Tedi Secrets Query Functions
 * CRUD operations for encrypted tedi API keys and credentials
 *
 * Follows the same pattern as organization-secrets.ts and app-secrets.ts.
 * Encryption/decryption happens at the API layer using SECRETS_MASTER_KEY + HKDF.
 */

import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { type TediSecret, tediSecrets } from "../schema/tedi-secrets";
import { tedis } from "../schema/tedis";

// =============================================================================
// LIST / GET QUERIES
// =============================================================================

/**
 * List all secrets for a tedi (metadata only, no encrypted values)
 * Safe to return to operator UIs
 */
export async function listTediSecrets(
	db: DbClient,
	tediId: string,
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
	return db
		.select({
			id: tediSecrets.id,
			name: tediSecrets.name,
			hint: tediSecrets.hint,
			keyVersion: tediSecrets.keyVersion,
			createdBy: tediSecrets.createdBy,
			createdAt: tediSecrets.createdAt,
			updatedAt: tediSecrets.updatedAt,
		})
		.from(tediSecrets)
		.where(eq(tediSecrets.tediId, tediId));
}

/**
 * Get a secret by tedi ID and name
 * Returns full record including encrypted_value for decryption
 */
export async function getTediSecret(
	db: DbClient,
	tediId: string,
	name: string,
): Promise<TediSecret | undefined> {
	const rows = await db
		.select()
		.from(tediSecrets)
		.where(and(eq(tediSecrets.tediId, tediId), eq(tediSecrets.name, name)))
		.limit(1);

	return rows[0];
}

/**
 * Get a secret by ID
 */
export async function getTediSecretById(
	db: DbClient,
	secretId: string,
): Promise<TediSecret | undefined> {
	const rows = await db
		.select()
		.from(tediSecrets)
		.where(eq(tediSecrets.id, secretId))
		.limit(1);

	return rows[0];
}

/**
 * Get all secrets for a tedi (including encrypted values)
 * Used by tedi Worker to decrypt and pass to container as env vars
 */
export async function getAllTediSecrets(
	db: DbClient,
	tediId: string,
): Promise<TediSecret[]> {
	return db.select().from(tediSecrets).where(eq(tediSecrets.tediId, tediId));
}

/**
 * List live, identity-backed tedis whose bounded Descope access key is old
 * enough for proactive rotation. The caller takes a per-tedi D1 lease before
 * touching Descope; this query is deliberately only bounded discovery.
 */
export async function listTediAccessKeysDueForRotation(
	db: DbClient,
	params: { updatedBefore: string; limit: number },
) {
	return db
		.select({
			tediId: sql<string>`${tedis.id}`.as("rotation_tedi_id"),
			organizationId: sql<string>`${tedis.organizationId}`.as(
				"rotation_organization_id",
			),
			slug: sql<string | null>`${tedis.slug}`.as("rotation_tedi_slug"),
			descopeUserId: sql<string>`${tedis.descopeUserId}`.as(
				"rotation_descope_user_id",
			),
			accessKeySecretId: sql<string>`${tediSecrets.id}`.as(
				"rotation_access_key_secret_id",
			),
			accessKeyUpdatedAt: sql<string>`${tediSecrets.updatedAt}`.as(
				"rotation_access_key_updated_at",
			),
		})
		.from(tediSecrets)
		.innerJoin(tedis, eq(tediSecrets.tediId, tedis.id))
		.where(
			and(
				eq(tediSecrets.name, "DESCOPE_ACCESS_KEY"),
				lte(tediSecrets.updatedAt, params.updatedBefore),
				isNull(tedis.retiredAt),
				isNotNull(tedis.descopeUserId),
			),
		)
		.orderBy(asc(tediSecrets.updatedAt), asc(tedis.id))
		.limit(Math.min(Math.max(params.limit, 1), 100));
}

/** Atomically persist both halves of one replacement Descope access key. */
export async function replaceTediAccessKeySecrets(
	db: DbClient,
	params: {
		accessKeySecretId: string;
		accessKeyIdSecretId: string;
		encryptedAccessKey: string;
		encryptedAccessKeyId: string;
		updatedAt: string;
	},
): Promise<void> {
	await db.batch([
		db
			.update(tediSecrets)
			.set({
				encryptedValue: params.encryptedAccessKey,
				keyVersion: sql`${tediSecrets.keyVersion} + 1`,
				updatedAt: params.updatedAt,
			})
			.where(eq(tediSecrets.id, params.accessKeySecretId)),
		db
			.update(tediSecrets)
			.set({
				encryptedValue: params.encryptedAccessKeyId,
				keyVersion: sql`${tediSecrets.keyVersion} + 1`,
				updatedAt: params.updatedAt,
			})
			.where(eq(tediSecrets.id, params.accessKeyIdSecretId)),
	]);
}

// =============================================================================
// CREATE / UPDATE / DELETE
// =============================================================================

/**
 * Create a new tedi secret
 */
async function createTediSecret(
	db: DbClient,
	input: {
		tediId: string;
		name: string;
		encryptedValue: string;
		hint: string | null;
		keyVersion: number;
		createdBy: string | null;
	},
): Promise<TediSecret> {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	await db.insert(tediSecrets).values({
		id,
		tediId: input.tediId,
		name: input.name,
		encryptedValue: input.encryptedValue,
		hint: input.hint,
		keyVersion: input.keyVersion,
		createdBy: input.createdBy,
		createdAt: now,
		updatedAt: now,
	});

	const created = await getTediSecretById(db, id);
	if (!created) throw new Error(`Failed to create tedi secret: ${id}`);
	return created;
}

/**
 * Upsert a tedi secret (create or update by name)
 */
export async function upsertTediSecret(
	db: DbClient,
	tediId: string,
	name: string,
	encryptedValue: string,
	hint: string | null,
	createdBy: string | null,
): Promise<TediSecret> {
	const existing = await getTediSecret(db, tediId, name);

	if (existing) {
		const now = new Date().toISOString();
		await db
			.update(tediSecrets)
			.set({ encryptedValue, hint, updatedAt: now })
			.where(eq(tediSecrets.id, existing.id));
		return (await getTediSecretById(db, existing.id))!;
	}

	return createTediSecret(db, {
		tediId,
		name,
		encryptedValue,
		hint,
		keyVersion: 1,
		createdBy,
	});
}

/**
 * Delete a tedi secret
 */
export async function deleteTediSecret(
	db: DbClient,
	secretId: string,
): Promise<boolean> {
	const existing = await getTediSecretById(db, secretId);
	if (!existing) return false;

	await db.delete(tediSecrets).where(eq(tediSecrets.id, secretId));
	return true;
}

/** Persist both halves together, including recovery when only one half exists. */
export async function upsertTediAccessKeySecrets(
	db: DbClient,
	input: {
		tediId: string;
		encryptedAccessKey: string;
		encryptedAccessKeyId: string;
	},
): Promise<void> {
	const now = new Date().toISOString();
	const statement = (name: string, encryptedValue: string) =>
		db
			.insert(tediSecrets)
			.values({
				id: crypto.randomUUID(),
				tediId: input.tediId,
				name,
				encryptedValue,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [tediSecrets.tediId, tediSecrets.name],
				set: { encryptedValue, updatedAt: now },
			});
	await db.batch([
		statement("DESCOPE_ACCESS_KEY", input.encryptedAccessKey),
		statement("DESCOPE_ACCESS_KEY_ID", input.encryptedAccessKeyId),
	]);
}
