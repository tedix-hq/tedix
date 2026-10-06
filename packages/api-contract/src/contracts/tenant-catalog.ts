import "@orpc/openapi/extensions/route";

import { oc } from "@orpc/contract";
import * as z from "zod";
import {
	InstallTenantMcpAppInputSchema,
	InstallTenantMcpAppOutputSchema,
	InstallTenantMcpAppsInputSchema,
	InstallTenantMcpAppsOutputSchema,
	OpenApiImportInputSchema,
	OpenApiImportResultSchema,
	UninstallTenantMcpAppInputSchema,
	UninstallTenantMcpAppOutputSchema,
} from "../schemas/catalog";

/** Tenant-owned catalog utilities that do not exercise fleet curation. */
export const tenantCatalogContract = oc
	// Preserve the stable public REST paths while moving RPC ownership to a
	// structurally tenant-product namespace.
	.route({ tags: ["tenant-catalog"], prefix: "/catalog" })
	.router({
		/**
		 * Tenant-safe one-shot install: prepared catalog app → org proxy →
		 * caller-owned aggregator attachment. Shared base-app preparation and fleet
		 * catalog curation remain in the catalog namespace.
		 */
		installTenantMcpApp: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "/install-tenant-mcp-app",
				summary: "Install catalog app into tenant MCP aggregator",
				description:
					"Create or reuse an org-owned zero-tool proxy for a prepared catalog app, then attach the proxy to a caller-owned aggregator app. Shared base-app preparation remains platform-owned; listing-only, unprepared, and missing-endpoint entries are blocked.",
			})
			.input(InstallTenantMcpAppInputSchema)
			.output(InstallTenantMcpAppOutputSchema),

		installTenantMcpApps: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "/install-tenant-mcp-apps",
				summary: "Install catalog apps into tenant MCP aggregator",
				description:
					"Resolve up to ten catalog product names or slugs, install every prepared app, and return an explicit per-app blocker for entries that are not tenant-installable.",
			})
			.input(InstallTenantMcpAppsInputSchema)
			.output(InstallTenantMcpAppsOutputSchema),

		uninstallTenantMcpApp: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "/uninstall-tenant-mcp-app",
				summary: "Detach tenant MCP app from aggregator",
				description:
					"Detach an installed tenant proxy namespace from a caller-owned aggregator app. The base app, catalog entry, generated tools, proxy app, and credentials remain intact for later reinstall.",
			})
			.input(UninstallTenantMcpAppInputSchema)
			.output(UninstallTenantMcpAppOutputSchema),

		previewOpenApiImport: oc
			.route({
				method: "POST",
				path: "/openapi-import/preview",
				summary: "Preview OpenAPI tool import",
				description:
					"Preview external app_tools generated from an OpenAPI JSON specification without mutating tenant or fleet state.",
				tags: ["service", "internal"],
			})
			.input(
				OpenApiImportInputSchema.omit({ dryRun: true }).extend({
					dryRun: z.literal(true).optional(),
				}),
			)
			.output(OpenApiImportResultSchema),
	});

export type TenantCatalogContract = typeof tenantCatalogContract;
