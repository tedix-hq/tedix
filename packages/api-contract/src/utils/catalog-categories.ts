export const CATALOG_CATEGORY_LABELS = {
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
} as const;

export type CatalogCategoryKey = keyof typeof CATALOG_CATEGORY_LABELS;

const CATEGORY_ALIASES: Record<string, CatalogCategoryKey> = {
	analytics: "BUSINESS_AND_ANALYTICS",
	"business analytics": "BUSINESS_AND_ANALYTICS",
	"business and analytics": "BUSINESS_AND_ANALYTICS",
	"business-analytics": "BUSINESS_AND_ANALYTICS",
	"business-and-analytics": "BUSINESS_AND_ANALYTICS",
	"business and data": "BUSINESS_AND_ANALYTICS",
	"business-and-data": "BUSINESS_AND_ANALYTICS",
	"business & analytics": "BUSINESS_AND_ANALYTICS",
	"data analytics": "BUSINESS_AND_ANALYTICS",
	"dev tools": "DEVELOPER_TOOLS",
	"developer-tools": "DEVELOPER_TOOLS",
	"developer tools": "DEVELOPER_TOOLS",
	"developer and tools": "DEVELOPER_TOOLS",
	developertools: "DEVELOPER_TOOLS",
	development: "DEVELOPER_TOOLS",
	"e commerce": "SHOPPING",
	"e-commerce": "SHOPPING",
	ecommerce: "SHOPPING",
	"e-commerce retail": "SHOPPING",
	"e-commerce & retail": "SHOPPING",
	"ecommerce retail": "SHOPPING",
	"ecommerce and retail": "SHOPPING",
	"shopping retail": "SHOPPING",
	"travel hospitality": "TRAVEL",
	"travel and hospitality": "TRAVEL",
	healthcare: "HEALTH",
	"health and fitness": "HEALTH",
	"messaging social": "MESSAGING_AND_SOCIAL",
	"messaging-and-social": "MESSAGING_AND_SOCIAL",
	"messaging and social": "MESSAGING_AND_SOCIAL",
	"messaging & social": "MESSAGING_AND_SOCIAL",
	retail: "SHOPPING",
	"social media": "SOCIAL",
};

function normalizeCategoryToken(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/&/g, " and ")
		.replace(/[_/|]+/g, " ")
		.replace(/[-]+/g, " ")
		.replace(/[^a-zA-Z0-9\s]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

export function normalizeCatalogCategory(
	category: string | null | undefined,
): CatalogCategoryKey | null {
	if (!category) return null;
	const trimmed = category.trim();
	if (!trimmed) return null;
	const upper = trimmed.toUpperCase().replace(/[\s-]+/g, "_");
	if (upper in CATALOG_CATEGORY_LABELS) {
		return upper as CatalogCategoryKey;
	}
	const token = normalizeCategoryToken(trimmed);
	if (!token) return null;
	if (token in CATEGORY_ALIASES) {
		const alias = CATEGORY_ALIASES[token];
		return alias ?? null;
	}
	const snake = token.toUpperCase().replace(/\s+/g, "_");
	if (snake in CATALOG_CATEGORY_LABELS) {
		return snake as CatalogCategoryKey;
	}
	return null;
}

export function formatCatalogCategory(
	category: string | null | undefined,
): string {
	const normalized = normalizeCatalogCategory(category);
	if (normalized) return CATALOG_CATEGORY_LABELS[normalized];
	if (!category) return "Other";
	return category
		.replace(/[_-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getCatalogCategoryAliases(
	category: string | null | undefined,
): string[] {
	const normalized = normalizeCatalogCategory(category);
	if (!normalized) return category ? [category] : [];
	const label = CATALOG_CATEGORY_LABELS[normalized];
	const candidates = new Set<string>([
		normalized,
		normalized.toLowerCase(),
		normalized.replace(/_/g, "-").toLowerCase(),
		normalized.replace(/_/g, " "),
		label,
		label.toLowerCase(),
		label.replace(/\s*&\s*/g, " and "),
		label
			.replace(/\s*&\s*/g, "-")
			.replace(/\s+/g, "-")
			.toLowerCase(),
	]);
	for (const [alias, key] of Object.entries(CATEGORY_ALIASES)) {
		if (key === normalized) candidates.add(alias);
	}
	return [...candidates].filter(Boolean);
}

export function mergeCatalogCategoryCounts(
	categories: Array<{ name: string | null; count: number }>,
): Array<{ name: string; label: string; count: number }> {
	const counts = new Map<
		string,
		{ name: CatalogCategoryKey; label: string; count: number }
	>();
	for (const category of categories) {
		const normalized = normalizeCatalogCategory(category.name);
		if (!normalized) continue;
		const existing = counts.get(normalized);
		if (existing) {
			existing.count += category.count;
		} else {
			counts.set(normalized, {
				name: normalized,
				label: CATALOG_CATEGORY_LABELS[normalized],
				count: category.count,
			});
		}
	}
	return [...counts.values()].sort(
		(a, b) => b.count - a.count || a.label.localeCompare(b.label),
	);
}
