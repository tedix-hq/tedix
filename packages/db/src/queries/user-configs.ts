import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import type { UserConfig } from "../schema/user-configs";
import { userConfigs } from "../schema/user-configs";

export async function getUserConfig(
	db: DbQueryClient,
	input: { userId: string; namespace: string; key: string },
): Promise<UserConfig | null> {
	const rows = await db
		.select()
		.from(userConfigs)
		.where(
			and(
				eq(userConfigs.userId, input.userId),
				eq(userConfigs.namespace, input.namespace),
				eq(userConfigs.key, input.key),
			),
		)
		.limit(1);

	return rows[0] ?? null;
}

/** List one user's values inside a single application-owned namespace. */
export async function listUserConfigs(
	db: DbQueryClient,
	input: { userId: string; namespace: string; limit?: number },
): Promise<UserConfig[]> {
	return db
		.select()
		.from(userConfigs)
		.where(
			and(
				eq(userConfigs.userId, input.userId),
				eq(userConfigs.namespace, input.namespace),
			),
		)
		.orderBy(asc(userConfigs.key))
		.limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
}

export async function upsertUserConfig(
	db: DbQueryClient,
	input: {
		userId: string;
		namespace: string;
		key: string;
		value: Record<string, JsonValue>;
	},
): Promise<UserConfig> {
	const now = new Date().toISOString();
	await db
		.insert(userConfigs)
		.values({
			id: crypto.randomUUID(),
			userId: input.userId,
			namespace: input.namespace,
			key: input.key,
			value: input.value,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [userConfigs.userId, userConfigs.namespace, userConfigs.key],
			set: {
				value: input.value,
				updatedAt: now,
			},
		});

	const saved = await getUserConfig(db, input);
	if (!saved) {
		throw new Error(
			`Failed to upsert user config: ${input.userId}/${input.namespace}/${input.key}`,
		);
	}
	return saved;
}

export interface UserConfigKey {
	userId: string;
	namespace: string;
	key: string;
}

export type PutUserConfigResult =
	| { ok: true; row: UserConfig }
	| { ok: false; reason: "revision_conflict"; currentRevision: number | null };

/**
 * Replace a config value under an optimistic-concurrency guard.
 *
 * `expectedRevision` is the revision the caller read. `0` means "I read no
 * stored row" and is the only value that may create one: any other expectation
 * takes the UPDATE path, which cannot insert. That split is what makes the CAS
 * honest — an unconditional upsert would happily CREATE a row for a caller who
 * claimed to be updating revision 5, silently resurrecting deleted state.
 */
export async function putUserConfig(
	db: DbQueryClient,
	input: UserConfigKey & {
		value: Record<string, JsonValue>;
		expectedRevision: number;
	},
): Promise<PutUserConfigResult> {
	const now = new Date().toISOString();
	const rows =
		input.expectedRevision === 0
			? await db
					.insert(userConfigs)
					.values({
						id: crypto.randomUUID(),
						userId: input.userId,
						namespace: input.namespace,
						key: input.key,
						value: input.value,
						revision: 1,
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: [
							userConfigs.userId,
							userConfigs.namespace,
							userConfigs.key,
						],
						set: {
							value: input.value,
							revision: sql`${userConfigs.revision} + 1`,
							updatedAt: now,
						},
						// A row already at revision 0 is a pre-CAS legacy row; adopting
						// it is the same "no stored revision" case the insert covers.
						setWhere: eq(userConfigs.revision, 0),
					})
					.returning()
			: await db
					.update(userConfigs)
					.set({
						value: input.value,
						revision: sql`${userConfigs.revision} + 1`,
						updatedAt: now,
					})
					.where(
						and(
							eq(userConfigs.userId, input.userId),
							eq(userConfigs.namespace, input.namespace),
							eq(userConfigs.key, input.key),
							eq(userConfigs.revision, input.expectedRevision),
						),
					)
					.returning();

	const row = rows[0];
	if (row) return { ok: true, row };

	const current = await getUserConfig(db, {
		userId: input.userId,
		namespace: input.namespace,
		key: input.key,
	});
	return {
		ok: false,
		reason: "revision_conflict",
		currentRevision: current?.revision ?? null,
	};
}
