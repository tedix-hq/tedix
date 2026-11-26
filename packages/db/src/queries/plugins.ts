/**
 * Plugin Query Helpers
 * CRUD operations for plugins, plugin installs, and plugin events.
 */

import { and, count, eq, sql } from "drizzle-orm";
import { coreStore } from "../core-store/dialect";
import { coreTable } from "../core-store/client";
import type { DbClient } from "../client";
import {
	tediPlugins as schemaTediPlugins,
	tediPluginInstalls as schemaTediPluginInstalls,
	tediPluginEvents as schemaTediPluginEvents,
	type TediPlugin,
	type PluginType,
	type PluginStatus,
	type PluginEventStatus,
	type NewTediPluginInstall,
	type TediPluginInstall,
	type NewTediPluginEvent,
} from "../schema/plugins";

// ============================================================================
// Plugins
// ============================================================================

export interface ListPluginsOptions {
	type?: PluginType;
	status?: PluginStatus;
	query?: string;
	limit?: number;
	offset?: number;
}

export async function listPlugins(
	db: DbClient,
	options: ListPluginsOptions = {},
): Promise<{ data: TediPlugin[]; total: number }> {
	const tediPlugins = coreTable(db, schemaTediPlugins);
	const { type, status, query, limit = 20, offset = 0 } = options;

	const conditions = [];
	if (type) conditions.push(eq(tediPlugins.type, type));
	if (status) conditions.push(eq(tediPlugins.status, status));
	// `instr`, not LIKE: D1 caps a LIKE/GLOB pattern at 50 bytes, so a 48+
	// character search failed as a D1_ERROR. `lower` on both sides keeps
	// LIKE's ASCII case-insensitivity.
	if (query) {
		conditions.push(
			coreStore(db) === "postgres"
				? sql`strpos(translate(${tediPlugins.name}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), translate(${query}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')) > 0`
				: sql`instr(lower(${tediPlugins.name}), lower(${query})) > 0`,
		);
	}

	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const [data, totals] = await db.batch([
		db
			.select()
			.from(tediPlugins)
			.where(where)
			.orderBy(sql`${tediPlugins.createdAt} DESC NULLS LAST`)
			.limit(limit)
			.offset(offset),
		db.select({ total: count() }).from(tediPlugins).where(where),
	]);
	const total = totals[0]?.total ?? 0;

	return { data, total };
}

export async function getPluginById(
	db: DbClient,
	pluginId: string,
): Promise<TediPlugin | undefined> {
	const tediPlugins = coreTable(db, schemaTediPlugins);
	const [plugin] = await db
		.select()
		.from(tediPlugins)
		.where(eq(tediPlugins.id, pluginId));
	return plugin;
}

// ============================================================================
// Plugin Installs
// ============================================================================

export async function createPluginInstall(
	db: DbClient,
	install: NewTediPluginInstall,
): Promise<void> {
	const tediPluginInstalls = coreTable(db, schemaTediPluginInstalls);
	await db.insert(tediPluginInstalls).values(install);
}

export async function getPluginInstall(
	db: DbClient,
	installId: string,
	orgId: string,
): Promise<TediPluginInstall | undefined> {
	const tediPluginInstalls = coreTable(db, schemaTediPluginInstalls);
	const [existing] = await db
		.select()
		.from(tediPluginInstalls)
		.where(
			and(
				eq(tediPluginInstalls.id, installId),
				eq(tediPluginInstalls.orgId, orgId),
			),
		);
	return existing;
}

export async function updatePluginInstall(
	db: DbClient,
	installId: string,
	updates: Partial<NewTediPluginInstall>,
): Promise<TediPluginInstall | undefined> {
	const tediPluginInstalls = coreTable(db, schemaTediPluginInstalls);
	const [updated] = await db
		.update(tediPluginInstalls)
		.set(updates)
		.where(eq(tediPluginInstalls.id, installId))
		.returning();

	return updated;
}

export async function deletePluginInstall(
	db: DbClient,
	installId: string,
): Promise<void> {
	const tediPluginInstalls = coreTable(db, schemaTediPluginInstalls);
	await db
		.delete(tediPluginInstalls)
		.where(eq(tediPluginInstalls.id, installId));
}

// ============================================================================
// Plugin Events
// ============================================================================

export async function createPluginEvent(
	db: DbClient,
	event: NewTediPluginEvent,
): Promise<void> {
	const tediPluginEvents = coreTable(db, schemaTediPluginEvents);
	await db.insert(tediPluginEvents).values(event);
}

export interface ListPluginEventsOptions {
	orgId: string;
	pluginId?: string;
	tediId?: string;
	eventType?: string;
	status?: PluginEventStatus;
	limit?: number;
	offset?: number;
}

export async function listPluginEvents(
	db: DbClient,
	options: ListPluginEventsOptions,
): Promise<{
	data: (typeof schemaTediPluginEvents.$inferSelect)[];
	total: number;
}> {
	const tediPluginEvents = coreTable(db, schemaTediPluginEvents);
	const {
		orgId,
		pluginId,
		tediId,
		eventType,
		status,
		limit = 20,
		offset = 0,
	} = options;

	const conditions = [eq(tediPluginEvents.orgId, orgId)];
	if (pluginId) conditions.push(eq(tediPluginEvents.pluginId, pluginId));
	if (tediId) conditions.push(eq(tediPluginEvents.tediId, tediId));
	if (eventType) conditions.push(eq(tediPluginEvents.eventType, eventType));
	if (status) conditions.push(eq(tediPluginEvents.status, status));

	const [data, totals] = await db.batch([
		db
			.select()
			.from(tediPluginEvents)
			.where(and(...conditions))
			.orderBy(sql`${tediPluginEvents.createdAt} DESC NULLS LAST`)
			.limit(limit)
			.offset(offset),
		db
			.select({ total: count() })
			.from(tediPluginEvents)
			.where(and(...conditions)),
	]);
	const total = totals[0]?.total ?? 0;

	return { data, total };
}
