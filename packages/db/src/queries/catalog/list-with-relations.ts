/**
 * App Catalog Queries — List with store listings (relations).
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import type {
	appCatalogMcpPrompts,
	appCatalogMcpResources,
	appCatalogMcpResourceTemplates,
	appCatalogMcpSkills,
	CatalogApp,
	CatalogMcpTool,
	CatalogStoreListing,
} from "../../schema/catalog";
import type { Database } from "./tool-source-policy";

// =============================================================================
// LIST WITH STORE LISTINGS (RELATIONS)
// =============================================================================

/**
 * Get catalog app by slug with store listings and tools
 * Uses Drizzle RQB `with:` to load relations in a single query.
 */
export async function getCatalogAppBySlugWithRelations(
	db: Database,
	slug: string,
): Promise<
	| (CatalogApp & {
			storeListings: CatalogStoreListing[];
			tools: CatalogMcpTool[];
			resources: (typeof appCatalogMcpResources.$inferSelect)[];
			resourceTemplates: (typeof appCatalogMcpResourceTemplates.$inferSelect)[];
			prompts: (typeof appCatalogMcpPrompts.$inferSelect)[];
			skills: (typeof appCatalogMcpSkills.$inferSelect)[];
	  })
	| null
> {
	const result = await db.query.appCatalog.findFirst({
		where: { slug },
		with: {
			storeListings: {
				orderBy: { lastSyncedAt: "desc" },
			},
			mcpTools: {
				where: { removedAt: { isNull: true } },
				orderBy: { toolName: "asc" },
			},
			mcpResources: {
				where: { removedAt: { isNull: true } },
				orderBy: { uri: "asc" },
			},
			mcpResourceTemplates: {
				where: { removedAt: { isNull: true } },
				orderBy: { name: "asc" },
			},
			mcpPrompts: {
				where: { removedAt: { isNull: true } },
				orderBy: { promptName: "asc" },
			},
			mcpSkills: {
				orderBy: { skillUri: "asc" },
			},
		},
	});
	if (!result) return null;

	// Rename mcpTools → tools to preserve the return type
	const {
		mcpTools,
		mcpResources,
		mcpResourceTemplates,
		mcpPrompts,
		mcpSkills,
		storeListings,
		...app
	} = result;
	return {
		...app,
		storeListings,
		tools: mcpTools,
		resources: mcpResources,
		resourceTemplates: mcpResourceTemplates,
		prompts: mcpPrompts,
		skills: mcpSkills,
	};
}
