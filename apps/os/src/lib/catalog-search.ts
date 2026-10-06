import type { ListCatalogAppsInput } from "@tedix/api-contract/schemas/catalog";

export const CATALOG_PAGE_SIZE = 30;

export interface CatalogRouteSearch {
	search?: string;
	category?: string;
	connectorType?: "MCP" | "SERVICE" | "FIRST_PARTY_ECOSYSTEM" | "NATIVE";
	sortBy?: "sourceCreatedAt" | "updatedAt" | "lastSyncedAt" | "name";
	healthStatus?:
		| "healthy"
		| "degraded"
		| "unhealthy"
		| "requires_auth"
		| "blocked"
		| "unsupported"
		| "unknown";
	offset: number;
}

export function catalogListInput(
	search: CatalogRouteSearch,
): ListCatalogAppsInput {
	return {
		limit: CATALOG_PAGE_SIZE,
		offset: search.offset,
		search: search.search || undefined,
		category: search.category || undefined,
		connectorType: search.connectorType,
		sortBy: search.sortBy,
		healthStatus: search.healthStatus,
	};
}

const CATEGORY_LABELS: Record<string, string> = {
	PRODUCTIVITY: "Productivity",
	DEVELOPER_TOOLS: "Developer Tools",
	LIFESTYLE: "Lifestyle",
	FINANCE: "Finance",
	TRAVEL: "Travel",
	DESIGN: "Design",
	EDUCATION: "Education",
	ENTERTAINMENT: "Entertainment",
	SOCIAL: "Social",
	BUSINESS: "Business",
	HEALTH: "Health",
	NEWS: "News",
	SHOPPING: "Shopping",
	UTILITIES: "Utilities",
	COLLABORATION: "Collaboration",
	FOOD: "Food",
	BUSINESS_AND_ANALYTICS: "Business & Analytics",
	MESSAGING_AND_SOCIAL: "Messaging & Social",
};

export function catalogCategoryLabel(category: string | null): string {
	if (!category) return "Uncategorized";
	return CATEGORY_LABELS[category] ?? category;
}
