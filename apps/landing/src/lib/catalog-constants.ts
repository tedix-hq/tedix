/**
 * Shared catalog constants used across CatalogGrid, AppCard, and detail pages.
 * Single source of truth for display labels, colors, and config.
 */
import { CATALOG_CATEGORY_LABELS } from "@tedix/api-contract/utils/catalog-categories";

// ============================================================
// Category
// ============================================================

export const CATEGORY_LABELS: Record<string, string> = CATALOG_CATEGORY_LABELS;

export const CATEGORY_COLORS: Record<string, string> = {
	PRODUCTIVITY:
		"bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
	DEVELOPER_TOOLS:
		"bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30",
	LIFESTYLE:
		"bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30",
	FINANCE:
		"bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
	TRAVEL:
		"bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30",
	DESIGN: "bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/30",
	EDUCATION:
		"bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
	ENTERTAINMENT:
		"bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
	SOCIAL:
		"bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30",
	BUSINESS:
		"bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/30",
	HEALTH: "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30",
	NEWS: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
	SHOPPING:
		"bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-400 border-fuchsia-500/30",
	UTILITIES:
		"bg-gray-500/10 text-gray-600 dark:text-gray-400 border-gray-500/30",
	COLLABORATION:
		"bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/30",
	FOOD: "bg-lime-500/10 text-lime-600 dark:text-lime-400 border-lime-500/30",
	BUSINESS_AND_ANALYTICS:
		"bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/30",
	MESSAGING_AND_SOCIAL:
		"bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30",
};

// Short labels for AppCard (space-constrained)
export const CATEGORY_LABELS_SHORT: Record<string, string> = {
	...CATEGORY_LABELS,
	DEVELOPER_TOOLS: "Dev Tools",
	BUSINESS_AND_ANALYTICS: "Analytics",
	MESSAGING_AND_SOCIAL: "Social",
};

// ============================================================
// App Type / Connector Type
// ============================================================

export const CONNECTOR_TYPE_LABELS: Record<string, string> = {
	MCP: "AI-Powered App",
	SERVICE: "Integration",
	FIRST_PARTY_ECOSYSTEM: "Built-in",
};

export const APP_TYPE_LABELS: Record<string, string> = {
	MCP: "AI App",
	SERVICE: "Integration",
	FIRST_PARTY_ECOSYSTEM: "Built-in",
};

// ============================================================
// Developer Type
// ============================================================

export const DEVELOPER_TYPE_LABELS: Record<string, string> = {
	TRUSTED_PARTNER: "Verified Partner",
	OAI: "OpenAI",
	THIRD_PARTY: "Community",
	UNTRUSTED: "Unverified",
};

// ============================================================
// Health Status
// ============================================================

export interface HealthStatusConfig {
	color: string;
	bgColor: string;
	dotColor: string;
	borderColor: string;
	label: string;
	icon: string;
}

export const HEALTH_STATUS_CONFIG: Record<string, HealthStatusConfig> = {
	healthy: {
		color: "text-green-600 dark:text-green-400",
		bgColor: "bg-green-500/10",
		dotColor: "bg-green-500",
		borderColor: "border-green-500/30",
		label: "Connected",
		icon: "check-circle",
	},
	degraded: {
		color: "text-yellow-600 dark:text-yellow-400",
		bgColor: "bg-yellow-500/10",
		dotColor: "bg-yellow-500",
		borderColor: "border-yellow-500/30",
		label: "Intermittent",
		icon: "alert-triangle",
	},
	unhealthy: {
		color: "text-red-600 dark:text-red-400",
		bgColor: "bg-red-500/10",
		dotColor: "bg-red-500",
		borderColor: "border-red-500/30",
		label: "Not Responding",
		icon: "x-circle",
	},
	requires_auth: {
		color: "text-blue-600 dark:text-blue-400",
		bgColor: "bg-blue-500/10",
		dotColor: "bg-blue-500",
		borderColor: "border-blue-500/30",
		label: "Login Required",
		icon: "lock",
	},
	unsupported: {
		color: "text-gray-600 dark:text-gray-400",
		bgColor: "bg-gray-500/10",
		dotColor: "bg-gray-400",
		borderColor: "border-gray-500/30",
		label: "Not Supported",
		icon: "minus-circle",
	},
	unknown: {
		color: "text-gray-500 dark:text-gray-500",
		bgColor: "bg-gray-500/10",
		dotColor: "bg-gray-400",
		borderColor: "border-gray-500/30",
		label: "Not Checked",
		icon: "help-circle",
	},
};

export const HEALTH_STATUS_LABELS: Record<string, string> = {
	healthy: "Connected",
	degraded: "Intermittent",
	unhealthy: "Not Responding",
	requires_auth: "Login Required",
};

/** Consumer-friendly health status labels for the app overview zone */
export const HEALTH_STATUS_LABELS_FRIENDLY: Record<string, string> = {
	healthy: "Connected",
	degraded: "Intermittent",
	unhealthy: "Not Responding",
	requires_auth: "Login Required",
	unsupported: "Not Supported",
	unknown: "Not Checked",
};

/** Consumer-friendly connector type labels */
export const CONNECTOR_TYPE_LABELS_FRIENDLY: Record<string, string> = {
	MCP: "AI-Powered App",
	SERVICE: "Integration",
	FIRST_PARTY_ECOSYSTEM: "Built-in App",
};

// ============================================================
// Logo Fallback Gradients (category-based)
// ============================================================

/** Gradient classes for letter-avatar fallbacks, keyed by category */
export const CATEGORY_GRADIENTS: Record<string, string> = {
	PRODUCTIVITY: "from-blue-500 to-indigo-600",
	DEVELOPER_TOOLS: "from-violet-500 to-purple-600",
	LIFESTYLE: "from-emerald-400 to-teal-600",
	FINANCE: "from-emerald-500 to-green-700",
	TRAVEL: "from-orange-400 to-amber-600",
	DESIGN: "from-pink-400 to-rose-600",
	EDUCATION: "from-cyan-400 to-blue-600",
	ENTERTAINMENT: "from-red-400 to-pink-600",
	SOCIAL: "from-indigo-400 to-blue-600",
	BUSINESS: "from-slate-500 to-gray-700",
	HEALTH: "from-rose-400 to-red-500",
	NEWS: "from-amber-400 to-orange-600",
	SHOPPING: "from-fuchsia-400 to-purple-600",
	UTILITIES: "from-gray-400 to-slate-600",
	COLLABORATION: "from-violet-400 to-indigo-600",
	FOOD: "from-lime-400 to-green-600",
	BUSINESS_AND_ANALYTICS: "from-slate-500 to-gray-700",
	MESSAGING_AND_SOCIAL: "from-indigo-400 to-blue-600",
};

/** Default gradient when category is unknown */
export const DEFAULT_GRADIENT = "from-gray-400 to-slate-600";

// ============================================================
// Region
// ============================================================

// ============================================================
// Authentication Type Labels
// ============================================================

export const AUTH_TYPE_LABELS: Record<string, string> = {
	OAUTH: "Requires Login",
	API_KEY: "API Key Required",
	NONE: "Open Access",
};

// ============================================================
// Capability Labels
// ============================================================

export const CAPABILITY_LABELS: Record<
	string,
	{ label: string; description: string }
> = {
	hasWrites: {
		label: "Can Modify Data",
		description: "This app can create, update, or delete data",
	},
	hasInteractive: {
		label: "Works in Conversation",
		description: "Interactive back-and-forth experience",
	},
	hasFileSearch: {
		label: "Can Search Files",
		description: "Search through uploaded documents",
	},
	hasDeepResearch: {
		label: "In-Depth Research",
		description: "Deep analysis and research capabilities",
	},
	hasSync: {
		label: "Data Sync",
		description: "Keeps data synchronized across services",
	},
};

export const REGION_LABELS: Record<string, string> = {
	DE: "DE",
	US: "US",
	GB: "GB",
	FR: "FR",
	IT: "IT",
	ES: "ES",
	NL: "NL",
	AT: "AT",
	CH: "CH",
	AU: "AU",
	CA: "CA",
	JP: "JP",
	KR: "KR",
	BR: "BR",
	MX: "MX",
};
