import { and, eq, inArray, or } from "drizzle-orm";
import type { DbClient } from "../client";
import { apps } from "../schema/apps";
import { organizationMembers } from "../schema/organization-members";
import { tedis } from "../schema/tedis";
import { appTools } from "../schema/tools";
import { users } from "../schema/users";
import { chunkForBoundParams } from "../utils/batch";

const D1_IN_LIST_CHUNK = 50;
const D1_COMBINED_IN_LIST_THRESHOLD = 50;

export interface AnalyticsAppRow {
	id: string;
	name: string;
	slug: string;
}

export interface AnalyticsNamespaceAppRow extends AnalyticsAppRow {
	sourceAppId: string | null;
}

export interface AnalyticsToolRow {
	appId: string;
	toolId: string;
	title: string | null;
}

export interface AnalyticsMemberRow {
	descopeUserId: string;
	email: string | null;
	name: string | null;
	avatarUrl: string | null;
	role: string;
}

export interface AnalyticsUserRow {
	id: string;
	email: string | null;
	name: string | null;
	avatarUrl: string | null;
}

export interface AnalyticsTediRow {
	id: string;
	descopeUserId: string | null;
	name: string;
	displayName: string | null;
	slug: string;
	avatar: string | null;
}

export async function listAnalyticsAppsByIds(
	db: DbClient,
	ids: string[],
): Promise<AnalyticsAppRow[]> {
	const rows: AnalyticsAppRow[] = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(ids)],
		D1_IN_LIST_CHUNK,
	)) {
		rows.push(
			...(await db
				.select({ id: apps.id, name: apps.name, slug: apps.slug })
				.from(apps)
				.where(inArray(apps.id, chunk))),
		);
	}
	return rows;
}

export async function listAnalyticsAppsBySlugs(
	db: DbClient,
	slugs: string[],
): Promise<AnalyticsNamespaceAppRow[]> {
	const rows: AnalyticsNamespaceAppRow[] = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(slugs)],
		D1_IN_LIST_CHUNK,
	)) {
		rows.push(
			...(await db
				.select({
					id: apps.id,
					name: apps.name,
					slug: apps.slug,
					sourceAppId: apps.sourceAppId,
				})
				.from(apps)
				.where(inArray(apps.slug, chunk))),
		);
	}
	return rows;
}

export async function listAnalyticsTools(
	db: DbClient,
	input: { appIds: string[]; toolIds: string[] },
): Promise<AnalyticsToolRow[]> {
	const rows: AnalyticsToolRow[] = [];
	const appIdChunks = chunkForBoundParams([...new Set(input.appIds)], 25);
	const toolIdChunks = chunkForBoundParams(
		[...new Set(input.toolIds)],
		D1_IN_LIST_CHUNK,
	);
	for (const appIds of appIdChunks) {
		for (const toolIds of toolIdChunks) {
			rows.push(
				...(await db
					.select({
						appId: appTools.appId,
						toolId: appTools.toolId,
						title: appTools.title,
					})
					.from(appTools)
					.where(
						and(
							inArray(appTools.appId, appIds),
							inArray(appTools.toolId, toolIds),
						),
					)),
			);
		}
	}
	return rows;
}

export async function listAnalyticsOrganizationMembers(
	db: DbClient,
	input: { userIds: string[]; organizationId?: string },
): Promise<AnalyticsMemberRow[]> {
	const rows: AnalyticsMemberRow[] = [];
	for (const userIds of chunkForBoundParams(
		[...new Set(input.userIds)],
		D1_IN_LIST_CHUNK,
	)) {
		const userCondition = inArray(organizationMembers.descopeUserId, userIds);
		rows.push(
			...(await db
				.select({
					descopeUserId: organizationMembers.descopeUserId,
					email: organizationMembers.email,
					name: organizationMembers.name,
					avatarUrl: organizationMembers.avatarUrl,
					role: organizationMembers.role,
				})
				.from(organizationMembers)
				.where(
					input.organizationId
						? and(
								userCondition,
								eq(organizationMembers.organizationId, input.organizationId),
							)
						: userCondition,
				)),
		);
	}
	return rows;
}

export async function listAnalyticsUsers(
	db: DbClient,
	ids: string[],
): Promise<AnalyticsUserRow[]> {
	const rows: AnalyticsUserRow[] = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(ids)],
		D1_IN_LIST_CHUNK,
	)) {
		rows.push(
			...(await db
				.select({
					id: users.id,
					email: users.email,
					name: users.name,
					avatarUrl: users.avatarUrl,
				})
				.from(users)
				.where(inArray(users.id, chunk))),
		);
	}
	return rows;
}

function analyticsTediProjection() {
	return {
		id: tedis.id,
		descopeUserId: tedis.descopeUserId,
		name: tedis.name,
		displayName: tedis.displayName,
		slug: tedis.slug,
		avatar: tedis.avatar,
	};
}

export async function listAnalyticsTedis(
	db: DbClient,
	input: {
		principalIds: string[];
		tediIds: string[];
		slugs: string[];
		organizationId?: string;
	},
): Promise<AnalyticsTediRow[]> {
	const principalIds = [...new Set(input.principalIds)];
	const tediIds = [...new Set(input.tediIds)];
	const slugs = [...new Set(input.slugs)];
	const totalParams = principalIds.length + tediIds.length + slugs.length;
	if (totalParams === 0) return [];

	const applyOrg = (condition: ReturnType<typeof inArray>) =>
		input.organizationId
			? and(condition, eq(tedis.organizationId, input.organizationId))
			: condition;

	if (totalParams <= D1_COMBINED_IN_LIST_THRESHOLD) {
		const conditions = [];
		if (principalIds.length > 0)
			conditions.push(inArray(tedis.descopeUserId, principalIds));
		if (tediIds.length > 0) conditions.push(inArray(tedis.id, tediIds));
		if (slugs.length > 0) conditions.push(inArray(tedis.slug, slugs));
		const condition = or(...conditions);
		if (!condition) return [];
		return db
			.select(analyticsTediProjection())
			.from(tedis)
			.where(
				input.organizationId
					? and(condition, eq(tedis.organizationId, input.organizationId))
					: condition,
			);
	}

	const rows = new Map<string, AnalyticsTediRow>();
	const queries = [
		...chunkForBoundParams(principalIds, D1_IN_LIST_CHUNK).map((ids) =>
			applyOrg(inArray(tedis.descopeUserId, ids)),
		),
		...chunkForBoundParams(tediIds, D1_IN_LIST_CHUNK).map((ids) =>
			applyOrg(inArray(tedis.id, ids)),
		),
		...chunkForBoundParams(slugs, D1_IN_LIST_CHUNK).map((ids) =>
			applyOrg(inArray(tedis.slug, ids)),
		),
	];
	for (const condition of queries) {
		for (const row of await db
			.select(analyticsTediProjection())
			.from(tedis)
			.where(condition)) {
			rows.set(row.id, row);
		}
	}
	return [...rows.values()];
}
