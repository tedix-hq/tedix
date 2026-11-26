import { and, desc, eq, gt, sql } from "drizzle-orm";
import { coreTable } from "../core-store/client";
import type { DbQueryClient } from "../query-client";
import { userConfigs as schemaUserConfigs } from "../schema/user-configs";
import { upsertUserConfig } from "./user-configs";
import { anyIds, likeText } from "../core-store/dialect";
import type { JsonValue } from "@tedix/api-contract/schemas/common";

const pushNamespace = (organizationId: string) => `os.push:${organizationId}`;
export async function savePushConfig(
	db: DbQueryClient,
	scope: { organizationId: string; userId: string },
	key: string,
	value: Record<string, JsonValue>,
) {
	return upsertUserConfig(db, {
		userId: scope.userId,
		namespace: pushNamespace(scope.organizationId),
		key,
		value,
	});
}
export async function listPushConfigs(
	db: DbQueryClient,
	scope: { organizationId: string; userId: string },
	prefix: string,
) {
	const userConfigs = coreTable(db, schemaUserConfigs);
	return db
		.select()
		.from(userConfigs)
		.where(
			and(
				eq(userConfigs.userId, scope.userId),
				eq(userConfigs.namespace, pushNamespace(scope.organizationId)),
				likeText(db, userConfigs.key, `${prefix}%`),
			),
		)
		.limit(100);
}
// Newest first, so a caller can keep the most recently registered devices.
export async function listPushSubscriptionKeys(
	db: DbQueryClient,
	scope: { organizationId: string; userId: string },
) {
	const userConfigs = coreTable(db, schemaUserConfigs);
	return db
		.select({
			key: userConfigs.key,
			createdAt: userConfigs.createdAt,
			updatedAt: userConfigs.updatedAt,
		})
		.from(userConfigs)
		.where(
			and(
				eq(userConfigs.userId, scope.userId),
				eq(userConfigs.namespace, pushNamespace(scope.organizationId)),
				likeText(db, userConfigs.key, "subscription:%"),
			),
		)
		.orderBy(
			sql`${userConfigs.updatedAt} DESC NULLS LAST`,
			desc(userConfigs.key),
		)
		.limit(100);
}
export async function deletePushConfigs(
	db: DbQueryClient,
	scope: { organizationId: string; userId: string },
	keys: string[],
) {
	if (!keys.length) return;
	const userConfigs = coreTable(db, schemaUserConfigs);
	await db
		.delete(userConfigs)
		.where(
			and(
				eq(userConfigs.userId, scope.userId),
				eq(userConfigs.namespace, pushNamespace(scope.organizationId)),
				anyIds(db, userConfigs.key, keys),
			),
		);
}
export async function deletePushConfig(
	db: DbQueryClient,
	scope: { organizationId: string; userId: string },
	key: string,
) {
	const userConfigs = coreTable(db, schemaUserConfigs);
	await db
		.delete(userConfigs)
		.where(
			and(
				eq(userConfigs.userId, scope.userId),
				eq(userConfigs.namespace, pushNamespace(scope.organizationId)),
				eq(userConfigs.key, key),
			),
		);
}
export async function hasVisiblePushConversation(
	db: DbQueryClient,
	scope: { organizationId: string; userId: string },
	conversationId: string,
	now: number,
) {
	const userConfigs = coreTable(db, schemaUserConfigs);
	const rows = await db
		.select({ value: userConfigs.value })
		.from(userConfigs)
		.where(
			and(
				eq(userConfigs.userId, scope.userId),
				eq(userConfigs.namespace, pushNamespace(scope.organizationId)),
				likeText(db, userConfigs.key, "visible:%"),
				gt(userConfigs.updatedAt, new Date(now - 60_000).toISOString()),
			),
		)
		.limit(100);
	return rows.some((row) => row.value.conversationId === conversationId);
}
