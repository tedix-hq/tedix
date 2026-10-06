/**
 * oRPC Plugins Router
 * Plugin marketplace, installation, configuration, and event management
 *
 * REST Endpoints:
 * GET    /plugins                          - List/browse plugins
 * GET    /plugins/{pluginId}               - Get plugin detail
 * POST   /plugins/install                  - Install plugin
 * DELETE /plugins/installs/{installId}     - Uninstall plugin
 * PATCH  /plugins/installs/configure       - Configure plugin
 * POST   /plugins/installs/activate        - Activate plugin
 * POST   /plugins/installs/deactivate      - Deactivate plugin
 * POST   /plugins/events                   - Emit plugin event
 * GET    /plugins/events                   - List plugin events
 */

import { implement } from "@orpc/server";
import { pluginsContract } from "@tedix/api-contract/contracts/plugins";
import {
	createPluginEvent,
	createPluginInstall,
	deletePluginInstall,
	getPluginById,
	getPluginInstall,
	listPluginEvents,
	listPlugins,
	updatePluginInstall,
} from "@tedix/db/queries/plugins";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import type {
	TediPlugin,
	TediPluginEvent,
	TediPluginInstall,
} from "@tedix/db/schema/plugins";
import { toJsonRecord } from "@tedix/db/utils/json";
import { nanoid } from "../../utils/id";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	withAuthorization,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

const pluginsOs = implement(pluginsContract).$context<BaseContext>();
const authedOs = pluginsOs.use(withAuth);

// =============================================================================
// HELPERS
// =============================================================================

function mapPluginRecord(plugin: TediPlugin) {
	return {
		id: plugin.id,
		slug: plugin.slug,
		name: plugin.name,
		description: plugin.description,
		type: plugin.type,
		version: plugin.version,
		manifest: plugin.manifest ?? null,
		status: plugin.status,
		authorOrgId: plugin.authorOrgId,
		createdAt: plugin.createdAt,
		updatedAt: plugin.updatedAt,
	};
}

function mapPluginInstallRecord(install: TediPluginInstall) {
	return {
		id: install.id,
		orgId: install.orgId,
		pluginId: install.pluginId,
		tediId: install.tediId,
		config: install.config ?? null,
		permissionsGranted: install.permissionsGranted ?? null,
		status: install.status,
		installedAt: install.installedAt,
		updatedAt: install.updatedAt,
	};
}

function mapPluginEventRecord(event: TediPluginEvent) {
	return {
		id: event.id,
		pluginId: event.pluginId,
		tediId: event.tediId,
		eventType: event.eventType,
		payload: event.payload ?? null,
		status: event.status,
		createdAt: event.createdAt,
		processedAt: event.processedAt,
	};
}

// =============================================================================
// PROCEDURES
// =============================================================================

const list = authedOs.list
	.use(withAuthorization("integrations:manage", "adapters:read"))
	.handler(async ({ input, context }) => {
		const { limit = 20, offset = 0 } = input;
		const { data, total } = await listPlugins(context.db, input);

		return {
			data: data.map(mapPluginRecord),
			pagination: {
				total,
				limit,
				offset,
				hasMore: offset + limit < total,
			},
		};
	});

const get = authedOs.get
	.use(withAuthorization("integrations:manage", "adapters:read"))
	.handler(async ({ input, context }) => {
		const plugin = await getPluginById(context.db, input.pluginId);

		if (!plugin) {
			throw createError(ErrorCodes.NOT_FOUND, "Plugin not found");
		}

		return mapPluginRecord(plugin);
	});

const install = authedOs.install
	.use(AUTHZ.adaptersWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		const plugin = await getPluginById(context.db, input.pluginId);
		if (plugin?.status !== "published") {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Plugin not found or not published",
			);
		}
		if (input.tediId) {
			const tedi = await getTediByIdForOrganization(
				context.db,
				input.tediId,
				orgId,
			);
			if (!tedi) {
				throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
			}
		}

		const id = nanoid();
		const now = new Date().toISOString();

		await createPluginInstall(context.db, {
			id,
			orgId,
			pluginId: input.pluginId,
			tediId: input.tediId ?? null,
			config: input.config == null ? null : toJsonRecord(input.config),
			permissionsGranted: input.permissionsGranted ?? null,
			status: "installed",
			installedAt: now,
			updatedAt: now,
		});

		return {
			id,
			orgId,
			pluginId: input.pluginId,
			tediId: input.tediId ?? null,
			config: input.config ?? null,
			permissionsGranted: input.permissionsGranted ?? null,
			status: "installed" as const,
			installedAt: now,
			updatedAt: now,
		};
	});

const uninstall = authedOs.uninstall
	.use(AUTHZ.adaptersWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		const existing = await getPluginInstall(context.db, input.installId, orgId);
		if (!existing) {
			throw createError(ErrorCodes.NOT_FOUND, "Installation not found");
		}

		await deletePluginInstall(context.db, input.installId);
		return { success: true, message: "Plugin uninstalled" };
	});

const configure = authedOs.configure
	.use(AUTHZ.adaptersWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		const existing = await getPluginInstall(context.db, input.installId, orgId);
		if (!existing) {
			throw createError(ErrorCodes.NOT_FOUND, "Installation not found");
		}

		const now = new Date().toISOString();
		const updates: Record<string, unknown> = { updatedAt: now };
		if (input.config !== undefined) updates.config = input.config ?? undefined;
		if (input.permissionsGranted !== undefined)
			updates.permissionsGranted = input.permissionsGranted ?? undefined;

		const updated = await updatePluginInstall(
			context.db,
			input.installId,
			updates,
		);

		return mapPluginInstallRecord(updated!);
	});

const activate = authedOs.activate
	.use(AUTHZ.adaptersWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		const existing = await getPluginInstall(context.db, input.installId, orgId);
		if (!existing) {
			throw createError(ErrorCodes.NOT_FOUND, "Installation not found");
		}

		const now = new Date().toISOString();
		const updated = await updatePluginInstall(context.db, input.installId, {
			tediId: input.tediId,
			status: "active",
			updatedAt: now,
		});

		return mapPluginInstallRecord(updated!);
	});

const deactivate = authedOs.deactivate
	.use(AUTHZ.adaptersWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		const existing = await getPluginInstall(context.db, input.installId, orgId);
		if (!existing || existing.tediId !== input.tediId) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Installation not found for this tedi",
			);
		}

		const now = new Date().toISOString();
		const updated = await updatePluginInstall(context.db, input.installId, {
			status: "disabled",
			updatedAt: now,
		});

		return mapPluginInstallRecord(updated!);
	});

// =============================================================================
// EVENTS SUB-ROUTER
// =============================================================================

const emitEvent = authedOs.events.emit
	.use(AUTHZ.adaptersWrite)
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);

		const id = nanoid();
		const now = new Date().toISOString();

		await createPluginEvent(context.db, {
			id,
			orgId,
			pluginId: input.pluginId,
			tediId: input.tediId ?? null,
			eventType: input.eventType,
			payload: input.payload == null ? null : toJsonRecord(input.payload),
			status: "pending",
			createdAt: now,
		});

		return {
			id,
			pluginId: input.pluginId,
			tediId: input.tediId ?? null,
			eventType: input.eventType,
			payload: input.payload ?? null,
			status: "pending" as const,
			createdAt: now,
			processedAt: null,
		};
	});

const listEventsHandler = authedOs.events.list
	.use(withAuthorization("integrations:manage", "adapters:read"))
	.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const { limit = 20, offset = 0 } = input;

		const { data, total } = await listPluginEvents(context.db, {
			orgId,
			pluginId: input.pluginId,
			tediId: input.tediId,
			eventType: input.eventType,
			status: input.status,
			limit,
			offset,
		});

		return {
			data: data.map(mapPluginEventRecord),
			pagination: {
				total,
				limit,
				offset,
				hasMore: offset + limit < total,
			},
		};
	});

// =============================================================================
// ROUTER EXPORT
// =============================================================================

export const pluginsContractRouter = authedOs.router({
	list,
	get,
	install,
	uninstall,
	configure,
	activate,
	deactivate,
	events: {
		emit: emitEvent,
		list: listEventsHandler,
	},
});
