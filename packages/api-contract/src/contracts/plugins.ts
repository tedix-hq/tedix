import "@orpc/openapi/extensions/route";
/**
 * Plugins Contract
 * oRPC contract for plugin marketplace, installation, and event management
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { PaginationMetaSchema, SuccessResponseSchema } from "../schemas/common";
import {
	ActivatePluginInputSchema,
	ConfigurePluginInputSchema,
	DeactivatePluginInputSchema,
	EmitPluginEventInputSchema,
	InstallPluginInputSchema,
	ListPluginEventsInputSchema,
	ListPluginsInputSchema,
	PluginEventSchema,
	PluginIdParamSchema,
	PluginInstallSchema,
	PluginSchema,
} from "../schemas/plugins";

// =============================================================================
// EVENTS SUB-ROUTER
// =============================================================================

const pluginEventsContract = oc.route({ prefix: "/events" }).router({
	emit: oc
		.route({
			method: "POST",
			path: "" as `/${string}`,
			summary: "Emit plugin event",
			description:
				"Emit an event for plugin processing (queued in D1, CF Queues later)",
		})
		.input(EmitPluginEventInputSchema)
		.output(PluginEventSchema),

	list: oc
		.route({
			method: "GET",
			path: "" as `/${string}`,
			summary: "List plugin events",
			description: "Query plugin event history with filters",
		})
		.input(ListPluginEventsInputSchema)
		.output(
			z.object({
				data: z.array(PluginEventSchema),
				pagination: PaginationMetaSchema,
			}),
		),
});

// =============================================================================
// PLUGINS CONTRACT
// =============================================================================

export const pluginsContract = oc
	.route({ tags: ["plugins"], prefix: "/plugins" })
	.router({
		/** Browse available plugins (marketplace) */
		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List plugins",
				description: "Browse available plugins in the marketplace",
			})
			.input(ListPluginsInputSchema)
			.output(
				z.object({
					data: z.array(PluginSchema),
					pagination: PaginationMetaSchema,
				}),
			),

		/** Get single plugin detail */
		get: oc
			.route({
				method: "GET",
				path: "/{pluginId}",
				summary: "Get plugin",
				description: "Get plugin details including manifest",
			})
			.input(PluginIdParamSchema)
			.output(PluginSchema),

		/** Install plugin to org/tedi with permission approval */
		install: oc
			.route({
				method: "POST",
				path: "/install",
				summary: "Install plugin",
				description:
					"Install a plugin to an organization, optionally for a specific tedi",
			})
			.input(InstallPluginInputSchema)
			.output(PluginInstallSchema),

		/** Uninstall plugin */
		uninstall: oc
			.route({
				method: "DELETE",
				path: "/installs/{installId}",
				summary: "Uninstall plugin",
				description: "Remove a plugin installation",
			})
			.input(z.object({ installId: z.string().min(1) }))
			.output(SuccessResponseSchema),

		/** Update plugin config/secrets */
		configure: oc
			.route({
				method: "PATCH",
				path: "/installs/configure",
				summary: "Configure plugin",
				description: "Update plugin configuration and secrets",
			})
			.input(ConfigurePluginInputSchema)
			.output(PluginInstallSchema),

		/** Activate plugin for a specific tedi */
		activate: oc
			.route({
				method: "POST",
				path: "/installs/activate",
				summary: "Activate plugin",
				description: "Activate an installed plugin for a specific tedi",
			})
			.input(ActivatePluginInputSchema)
			.output(PluginInstallSchema),

		/** Deactivate plugin for a specific tedi */
		deactivate: oc
			.route({
				method: "POST",
				path: "/installs/deactivate",
				summary: "Deactivate plugin",
				description: "Deactivate a plugin for a specific tedi",
			})
			.input(DeactivatePluginInputSchema)
			.output(PluginInstallSchema),

		/** Plugin events sub-router */
		events: pluginEventsContract,
	});
