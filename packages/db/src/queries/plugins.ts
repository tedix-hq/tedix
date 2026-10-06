/**
 * Plugin Query Helpers
 * CRUD operations for plugins, plugin installs, and plugin events.
 */

import { and, desc, eq, like } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	tediPlugins,
	tediPluginInstalls,
	tediPluginEvents,
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
	const { type, status, query, limit = 20, offset = 0 } = options;

	const conditions = [];
	if (type) conditions.push(eq(tediPlugins.type, type));
	if (status) conditions.push(eq(tediPlugins.status, status));
	if (query) conditions.push(like(tediPlugins.name, `%${query}%`));

	const where = conditions.length > 0 ? and(...conditions) : undefined;

	const data = await db
		.select()
		.from(tediPlugins)
		.where(where)
		.orderBy(desc(tediPlugins.createdAt))
		.limit(limit)
		.offset(offset);

	const total = await db.$count(tediPlugins, where);

	return { data, total };
}

export async function getPluginById(
	db: DbClient,
	pluginId: string,
): Promise<TediPlugin | undefined> {
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
	await db.insert(tediPluginInstalls).values(install);
}

export async function getPluginInstall(
	db: DbClient,
	installId: string,
	orgId: string,
): Promise<TediPluginInstall | undefined> {
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
	await db
		.update(tediPluginInstalls)
		.set(updates)
		.where(eq(tediPluginInstalls.id, installId));

	const [updated] = await db
		.select()
		.from(tediPluginInstalls)
		.where(eq(tediPluginInstalls.id, installId));
	return updated;
}

export async function deletePluginInstall(
	db: DbClient,
	installId: string,
): Promise<void> {
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
): Promise<{ data: (typeof tediPluginEvents.$inferSelect)[]; total: number }> {
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

	const data = await db
		.select()
		.from(tediPluginEvents)
		.where(and(...conditions))
		.orderBy(desc(tediPluginEvents.createdAt))
		.limit(limit)
		.offset(offset);

	const total = await db.$count(tediPluginEvents, and(...conditions));

	return { data, total };
}
