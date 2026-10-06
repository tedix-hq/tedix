/**
 * User Query Helpers
 * Canonical users plus provider profile-cache updates.
 */

import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import type { NewUser, User } from "../schema/users";
import { users } from "../schema/users";
import type { ExternalIdentity } from "./principal-identities";
import {
	bindPrincipalIdentity,
	resolvePrincipalIdentity,
} from "./principal-identities";

// ============================================================================
// Read Operations
// ============================================================================

export async function getUserById(
	db: DbClient,
	id: string,
): Promise<User | undefined> {
	return db.query.users.findFirst({ where: { id } });
}

export async function updateUserProfile(
	db: DbClient,
	input: {
		userId: string;
		expectedRevision: number;
		name?: string;
		avatarUrl?: string | null;
	},
): Promise<User | undefined> {
	const now = new Date().toISOString();
	const [updated] = await db
		.update(users)
		.set({
			...(input.name !== undefined ? { name: input.name } : {}),
			...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
			profileRevision: sql`${users.profileRevision} + 1`,
			updatedAt: now,
		})
		.where(
			and(
				eq(users.id, input.userId),
				eq(users.profileRevision, input.expectedRevision),
			),
		)
		.returning();
	return updated;
}

// ============================================================================
// Write Operations
// ============================================================================

export async function upsertUser(
	db: DbClient,
	data: Omit<NewUser, "createdAt" | "updatedAt">,
): Promise<User> {
	const now = new Date().toISOString();
	const email = data.email.toLowerCase();

	const update: Partial<NewUser> = {
		email,
		updatedAt: now,
	};

	if (data.name !== undefined && data.name !== null) update.name = data.name;
	if (data.avatarUrl !== undefined && data.avatarUrl !== null)
		update.avatarUrl = data.avatarUrl;
	if (data.metadata !== undefined && data.metadata !== null)
		update.metadata = data.metadata;
	if (data.lastLoginAt !== undefined && data.lastLoginAt !== null)
		update.lastLoginAt = data.lastLoginAt;

	const insertValues: NewUser = {
		id: data.id,
		email,
		createdAt: now,
		updatedAt: now,
	};

	if (data.name !== undefined && data.name !== null) {
		insertValues.name = data.name;
	}
	if (data.avatarUrl !== undefined && data.avatarUrl !== null) {
		insertValues.avatarUrl = data.avatarUrl;
	}
	if (data.metadata !== undefined && data.metadata !== null) {
		insertValues.metadata = data.metadata;
	}
	if (data.lastLoginAt !== undefined && data.lastLoginAt !== null) {
		insertValues.lastLoginAt = data.lastLoginAt;
	}

	await db.insert(users).values(insertValues).onConflictDoUpdate({
		target: users.id,
		set: update,
	});

	const saved = await getUserById(db, data.id);
	if (!saved) {
		throw new Error(`Failed to upsert user: ${data.id}`);
	}
	return saved;
}

/**
 * Upsert a user through an exact provider identity.
 *
 * Existing rows whose ids were historically Descope subjects keep that stable
 * Tedix id; new users receive UUIDs. Once bound, changing providers never
 * changes the canonical id.
 */
export async function upsertUserForExternalIdentity(
	db: DbClient,
	input: {
		identity: ExternalIdentity;
		email: string;
		name?: string | null;
		avatarUrl?: string | null;
		metadata?: NewUser["metadata"];
		lastLoginAt?: string | null;
	},
): Promise<User> {
	const mapping = await resolvePrincipalIdentity(db, input.identity, {
		principalType: "user",
	});
	const userId = mapping?.principalId ?? crypto.randomUUID();
	const existing = mapping ? await getUserById(db, userId) : undefined;
	// Provider claims bootstrap missing fields only. Once D1 has a display name
	// or avatar, later JWT/webhook sync must not overwrite that canonical value.
	const user = await upsertUser(db, {
		id: userId,
		email: input.email,
		name: existing?.name ?? input.name,
		avatarUrl: existing?.avatarUrl ?? input.avatarUrl,
		metadata: input.metadata,
		lastLoginAt: input.lastLoginAt,
	});
	await bindPrincipalIdentity(db, {
		principalType: "user",
		principalId: user.id,
		organizationId: null,
		...input.identity,
		verifiedAt: input.lastLoginAt ?? undefined,
	});
	return user;
}
