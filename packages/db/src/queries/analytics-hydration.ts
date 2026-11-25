import { and, eq, or } from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { anyIds } from "../core-store/dialect";
import { apps } from "../schema/apps";
import { organizationMembers } from "../schema/organization-members";
import { tedis } from "../schema/tedis";
import { appTools } from "../schema/tools";
import { users } from "../schema/users";

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
	if (!ids.length) return [];
	const table = coreTable(db, apps);
	return db
		.select({ id: table.id, name: table.name, slug: table.slug })
		.from(table)
		.where(anyIds(db, table.id, ids));
}

export async function listAnalyticsAppsBySlugs(
	db: DbClient,
	slugs: string[],
): Promise<AnalyticsNamespaceAppRow[]> {
	if (!slugs.length) return [];
	const table = coreTable(db, apps);
	return db
		.select({
			id: table.id,
			name: table.name,
			slug: table.slug,
			sourceAppId: table.sourceAppId,
		})
		.from(table)
		.where(anyIds(db, table.slug, slugs));
}

export async function listAnalyticsTools(
	db: DbClient,
	input: { appIds: string[]; toolIds: string[] },
): Promise<AnalyticsToolRow[]> {
	if (!input.appIds.length || !input.toolIds.length) return [];
	const table = coreTable(db, appTools);
	return db
		.select({
			appId: table.appId,
			toolId: table.toolId,
			title: table.title,
		})
		.from(table)
		.where(
			and(
				anyIds(db, table.appId, input.appIds),
				anyIds(db, table.toolId, input.toolIds),
			),
		);
}

export async function listAnalyticsOrganizationMembers(
	db: DbClient,
	input: { userIds: string[]; organizationId?: string },
): Promise<AnalyticsMemberRow[]> {
	if (!input.userIds.length) return [];
	const table = coreTable(db, organizationMembers);
	return db
		.select({
			descopeUserId: table.descopeUserId,
			email: table.email,
			name: table.name,
			avatarUrl: table.avatarUrl,
			role: table.role,
		})
		.from(table)
		.where(
			and(
				anyIds(db, table.descopeUserId, input.userIds),
				input.organizationId
					? eq(table.organizationId, input.organizationId)
					: undefined,
			),
		);
}

export async function listAnalyticsUsers(
	db: DbClient,
	ids: string[],
): Promise<AnalyticsUserRow[]> {
	if (!ids.length) return [];
	const table = coreTable(db, users);
	return db
		.select({
			id: table.id,
			email: table.email,
			name: table.name,
			avatarUrl: table.avatarUrl,
		})
		.from(table)
		.where(anyIds(db, table.id, ids));
}

function analyticsTediProjection(table: typeof tedis) {
	return {
		id: table.id,
		descopeUserId: table.descopeUserId,
		name: table.name,
		displayName: table.displayName,
		slug: table.slug,
		avatar: table.avatar,
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
	if (
		!input.principalIds.length &&
		!input.tediIds.length &&
		!input.slugs.length
	)
		return [];
	const table = coreTable(db, tedis);
	return db
		.select(analyticsTediProjection(table))
		.from(table)
		.where(
			and(
				or(
					anyIds(db, table.descopeUserId, input.principalIds),
					anyIds(db, table.id, input.tediIds),
					anyIds(db, table.slug, input.slugs),
				),
				input.organizationId
					? eq(table.organizationId, input.organizationId)
					: undefined,
			),
		);
}
