import type { SyncCatalogAppInput } from "@tedix/db/queries/catalog/upsert-sync";
import type {
	AppStatus,
	AuthType,
	Category,
	ConnectorType,
	DeveloperType,
	DistributionChannel,
	ReviewStatus,
	Source,
} from "@tedix/db/schema/catalog";

/** Raw connector format from source API */
export interface RawConnector {
	id: string;
	canonical_connector_id: string | null;
	created_at: string | null;
	connector_type: string;
	name: string;
	description: string | null;
	model_description: string | null;
	service: string | null;
	base_url: string | null;
	supported_auth: Array<{ type: string }> | null;
	labels: Record<string, string> | null;
	status: string;
	branding: {
		category: string | null;
		developer: string;
		website: string | null;
		privacy_policy: string | null;
		terms_of_service: string | null;
		is_discoverable_app: boolean;
	} | null;
	conformance: {
		implements_retrievable: boolean;
		reason_if_not_retrievable: string | null;
	} | null;
	policy_info: {
		safety_status: string | null;
	} | null;
	keywords_for_discovery: string[] | null;
	keywords_for_triggering: string[] | null;
	developer_type: string | null;
	distribution_channel: string | null;
	supports_full_actions: boolean;
	app_metadata: {
		review: { status: string } | null;
		categories: string[] | null;
		sub_categories: string[] | null;
		seo_description: string | null;
		screenshots: string[] | null;
		developer: string | null;
		version: string | null;
		version_id: string | null;
		version_notes: string | null;
	} | null;
	logo_url: string | null;
	logo_url_dark: string | null;
	tier_level: string | null;
	actions: Array<{
		id: string;
		name?: string;
		description?: string;
	}> | null;
}

interface LiveAppsData {
	connectors: RawConnector[];
}

/** Claude extension/server format */
interface RawClaudeEntry {
	id: string;
	icon_url: string | null;
	upload_date: string | null;
	manifest: {
		name: string;
		display_name?: string;
		description?: string;
		version?: string;
		homepage?: string;
		author?: {
			name?: string;
			url?: string;
		};
		tools?: Array<{
			name: string;
			description?: string;
		}>;
		server?: {
			type?: string;
			mcp_config?: Record<string, unknown>;
			transport?: Array<{ type: string; url?: string }>;
		};
		privacy_policies?: string[];
	};
	download_count?: number;
	is_allowlisted?: boolean;
	is_internal?: boolean;
}

interface ClaudeEntriesData {
	entries: RawClaudeEntry[];
}

interface ChatGPTAppsListEntry {
	id: string;
	name: string;
	description?: string | null;
	branding?: {
		developer?: string | null;
		website?: string | null;
		privacy_policy?: string | null;
		terms_of_service?: string | null;
		category?: string | null;
		is_discoverable_app?: boolean | null;
	} | null;
	app_metadata?: {
		review?: { status?: string | null } | null;
		categories?: string[] | null;
		sub_categories?: string[] | null;
		seo_description?: string | null;
		screenshots?: string[] | null;
		developer?: string | null;
		version?: string | null;
		version_id?: string | null;
		version_notes?: string | null;
	} | null;
	distribution_channel?: string | null;
	connector_type?: string | null;
	labels?: Record<string, string> | null;
	logo_url?: string | null;
	logo_url_dark?: string | null;
}

interface ChatGPTAppsListData {
	apps: ChatGPTAppsListEntry[];
}

interface ChatGPTActionsLink {
	id: string;
	created_at?: string | null;
	connector_id: string;
	name?: string | null;
	actions?: string[] | null;
	auth_type?: string | null;
	auth_status?: string | null;
	visibility?: string | null;
	connector_status?: string | null;
	connector_type?: string | null;
	connector_name?: string | null;
	connector_description?: string | null;
	connector_keywords_for_triggering?: string[] | null;
	connector_distribution_channel?: string | null;
	connector_supports_full_actions?: boolean | null;
}

interface ChatGPTActionsData {
	links: ChatGPTActionsLink[];
}

export interface RawClaudeServerEntry {
	server: {
		name?: string;
		title?: string;
		description?: string | null;
		version?: string;
		remotes?: Array<{
			type?: string;
			url?: string;
		}>;
	};
	_meta?: {
		"io.modelcontextprotocol.registry/official"?: {
			status?: string;
			updatedAt?: string;
			publishedAt?: string;
		};
		"com.anthropic.api/mcp-registry"?: {
			uuid?: string;
			type?: string;
			displayName?: string;
			oneLiner?: string;
			iconUrl?: string;
			documentation?: string;
			support?: string;
			privacyPolicy?: string;
			url?: string;
			author?: { name?: string; url?: string };
			slug?: string;
			directoryUrl?: string;
			permissions?: string;
			isAuthless?: boolean;
			toolNames?: string[];
			promptNames?: string[];
			useCases?: string[];
			worksWith?: string[];
			visibility?: string[];
			popularityScore?: number;
			trendingScore?: number;
			rank?: number;
			publishedOn?: string;
			createdOn?: string;
			updatedOn?: string;
			added_at?: string;
			htmlContent?: string;
			heroVideoId?: string;
			heroVideoPreviewLink?: string;
			serverLabel?: string;
			backgroundPattern?: string;
			claudeCodeCopyText?: string;
		};
	};
}

interface ClaudeServersData {
	servers: RawClaudeServerEntry[];
}

// ============================================================================
// Mapping Functions
// ============================================================================

export function mapCategory(category: string | null): Category | null {
	if (!category) return null;
	const categoryMap: Record<string, Category> = {
		PRODUCTIVITY: "PRODUCTIVITY",
		DEVELOPER_TOOLS: "DEVELOPER_TOOLS",
		LIFESTYLE: "LIFESTYLE",
		FINANCE: "FINANCE",
		TRAVEL: "TRAVEL",
		DESIGN: "DESIGN",
		EDUCATION: "EDUCATION",
		ENTERTAINMENT: "ENTERTAINMENT",
		SOCIAL: "SOCIAL",
		BUSINESS: "BUSINESS",
		HEALTH: "HEALTH",
		NEWS: "NEWS",
		SHOPPING: "SHOPPING",
		UTILITIES: "UTILITIES",
		COLLABORATION: "COLLABORATION",
		FOOD: "FOOD",
		BUSINESS_AND_ANALYTICS: "BUSINESS_AND_ANALYTICS",
		MESSAGING_AND_SOCIAL: "MESSAGING_AND_SOCIAL",
	};
	return categoryMap[category] || null;
}

export function mapConnectorType(type: string): ConnectorType {
	const typeMap: Record<string, ConnectorType> = {
		MCP: "MCP",
		SERVICE: "SERVICE",
		FIRST_PARTY_ECOSYSTEM: "FIRST_PARTY_ECOSYSTEM",
	};
	return typeMap[type] || "MCP";
}

export function mapDistributionChannel(
	channel: string | null,
): DistributionChannel | null {
	if (!channel) return null;
	const channelMap: Record<string, DistributionChannel> = {
		ECOSYSTEM_DIRECTORY: "ECOSYSTEM_DIRECTORY",
		DEFAULT_OAI_CATALOG: "DEFAULT_OAI_CATALOG",
		INDIVIDUAL: "INDIVIDUAL",
	};
	return channelMap[channel] || null;
}

export function mapDeveloperType(type: string | null): DeveloperType | null {
	if (!type) return null;
	const typeMap: Record<string, DeveloperType> = {
		TRUSTED_PARTNER: "TRUSTED_PARTNER",
		OAI: "OAI",
		THIRD_PARTY: "THIRD_PARTY",
	};
	return typeMap[type] || null;
}

export function mapReviewStatus(status: string | null): ReviewStatus | null {
	if (!status) return null;
	const statusMap: Record<string, ReviewStatus> = {
		RELEASED: "RELEASED",
		PENDING: "PENDING",
		REJECTED: "REJECTED",
	};
	return statusMap[status] || null;
}

export function mapAppStatus(
	status: string | null | undefined,
): AppStatus | null {
	if (!status) return null;
	const normalized = status.trim().toUpperCase();
	if (normalized === "ENABLED") return "ENABLED";
	if (normalized === "DISABLED") return "DISABLED";
	if (normalized === "PENDING") return "PENDING";
	// Private/limited visibility values from source APIs should not be public.
	if (normalized === "ONLY_ME") return "DISABLED";
	return null;
}

export function mapAuthTypes(
	supportedAuth: Array<{ type: string }> | null,
): AuthType[] {
	if (!supportedAuth) return [];
	const result: AuthType[] = [];
	for (const auth of supportedAuth) {
		const typeMap: Record<string, AuthType> = {
			OAUTH: "OAUTH",
			NONE: "NONE",
			API_KEY: "API_KEY",
		};
		const mapped = typeMap[auth.type];
		if (mapped) {
			result.push(mapped);
		}
	}
	return result;
}

/**
 * Check if data is ChatGPT format (has connectors array)
 */
export function isChatGPTFormat(data: unknown): data is LiveAppsData {
	return (
		typeof data === "object" &&
		data !== null &&
		"connectors" in data &&
		Array.isArray((data as LiveAppsData).connectors)
	);
}

/**
 * Check if data is Claude format (has entries array)
 */
export function isClaudeFormat(data: unknown): data is ClaudeEntriesData {
	return (
		typeof data === "object" &&
		data !== null &&
		"entries" in data &&
		Array.isArray((data as ClaudeEntriesData).entries)
	);
}

/**
 * Check if data is ChatGPT apps list format (has apps array)
 */
export function isChatGPTAppsListFormat(
	data: unknown,
): data is ChatGPTAppsListData {
	return (
		typeof data === "object" &&
		data !== null &&
		"apps" in data &&
		Array.isArray((data as ChatGPTAppsListData).apps)
	);
}

/**
 * Check if data is ChatGPT actions list format (has links array)
 */
export function isChatGPTActionsFormat(
	data: unknown,
): data is ChatGPTActionsData {
	return (
		typeof data === "object" &&
		data !== null &&
		"links" in data &&
		Array.isArray((data as ChatGPTActionsData).links)
	);
}

/**
 * Check if data is system hints format (has hints array)
 */
/**
 * Check if data is Claude servers format (has servers array)
 */
export function isClaudeServersFormat(
	data: unknown,
): data is ClaudeServersData {
	return (
		typeof data === "object" &&
		data !== null &&
		"servers" in data &&
		Array.isArray((data as ClaudeServersData).servers)
	);
}

export function transformClaudeEntry(
	entry: RawClaudeEntry,
): SyncCatalogAppInput {
	const manifest = entry.manifest;

	// Try to extract MCP endpoint URL from server config
	let baseUrl: string | null = null;
	if (manifest.server?.transport) {
		const httpTransport = manifest.server.transport.find(
			(t) => t.type === "streamable-http" || t.type === "sse",
		);
		if (httpTransport?.url) {
			baseUrl = httpTransport.url;
		}
	}

	return {
		source: "claude" as Source,
		sourceAppId: entry.id,
		name: manifest.display_name || manifest.name,
		description: manifest.description || null,
		baseUrl,
		connectorType: "MCP" as ConnectorType,
		developerType: entry.is_allowlisted
			? ("TRUSTED_PARTNER" as DeveloperType)
			: ("THIRD_PARTY" as DeveloperType),
		developer: manifest.author?.name || null,
		website: manifest.homepage || manifest.author?.url || null,
		privacyPolicy: manifest.privacy_policies?.[0] || null,
		logoUrl: entry.icon_url,
		hasWrites: false, // Claude doesn't provide this
		hasInteractive: false,
		reviewStatus: entry.is_allowlisted
			? ("RELEASED" as ReviewStatus)
			: ("PENDING" as ReviewStatus),
		// Omit rawData to avoid D1 size limits
		rawData: null,
	};
}

/**
 * Transform ChatGPT apps list entry (featured/categorized) to common format
 */
export function transformChatGPTAppsListEntry(
	entry: ChatGPTAppsListEntry,
): SyncCatalogAppInput {
	const labels = entry.labels || {};

	return {
		source: "chatgpt" as Source,
		sourceAppId: entry.id,
		name: entry.name,
		description: entry.description ?? null,
		modelDescription: null,
		baseUrl: null,
		connectorType: mapConnectorType(entry.connector_type || "MCP"),
		distributionChannel: mapDistributionChannel(
			entry.distribution_channel || null,
		),
		developerType: mapDeveloperType(null),
		category: mapCategory(entry.branding?.category || null),
		developer:
			entry.branding?.developer || entry.app_metadata?.developer || null,
		website: entry.branding?.website ?? null,
		privacyPolicy: entry.branding?.privacy_policy ?? null,
		termsOfService: entry.branding?.terms_of_service ?? null,
		logoUrl: entry.logo_url ?? null,
		logoUrlDark: entry.logo_url_dark ?? null,
		version: entry.app_metadata?.version ?? null,
		versionId: entry.app_metadata?.version_id ?? null,
		versionNotes: entry.app_metadata?.version_notes ?? null,
		seoDescription: entry.app_metadata?.seo_description ?? null,
		screenshots: entry.app_metadata?.screenshots ?? null,
		categories: entry.app_metadata?.categories ?? null,
		subCategories: entry.app_metadata?.sub_categories ?? null,
		hasWrites: labels.writes === "true" || labels.consequential === "true",
		hasInteractive: labels.interactive === "true",
		hasFileSearch:
			labels.file_search === "true" || labels.retrievable === "true",
		hasDeepResearch: labels.deep_research === "true",
		hasSync: labels.sync === "true",
		reviewStatus: mapReviewStatus(entry.app_metadata?.review?.status || null),
		rawData: null,
	};
}

/**
 * Transform ChatGPT actions link entry to common format
 */
export function transformChatGPTActionsEntry(
	entry: ChatGPTActionsLink,
): SyncCatalogAppInput {
	const authTypes =
		entry.auth_type === "OAUTH"
			? (["OAUTH"] as AuthType[])
			: entry.auth_type === "API_KEY"
				? (["API_KEY"] as AuthType[])
				: entry.auth_type === "NONE"
					? (["NONE"] as AuthType[])
					: null;

	return {
		source: "chatgpt" as Source,
		sourceAppId: entry.connector_id,
		name: entry.connector_name || entry.name || entry.connector_id,
		description: entry.connector_description ?? null,
		modelDescription: null,
		baseUrl: null,
		connectorType: mapConnectorType(entry.connector_type || "MCP"),
		distributionChannel: mapDistributionChannel(
			entry.connector_distribution_channel || null,
		),
		developerType: mapDeveloperType(null),
		website: null,
		privacyPolicy: null,
		termsOfService: null,
		logoUrl: null,
		logoUrlDark: null,
		hasWrites: (entry.actions?.length ?? 0) > 0,
		hasInteractive: undefined,
		hasFileSearch: undefined,
		hasDeepResearch: undefined,
		hasSync: undefined,
		authTypes,
		authRequired: authTypes ? !authTypes.includes("NONE") : undefined,
		reviewStatus: null,
		supportsFullActions: entry.connector_supports_full_actions ?? null,
		rawData: null,
	};
}

/**
 * Resolve a usable logo URL for Claude registry entries.
 * The registry iconUrl is often a website URL or MCP endpoint, not an image.
 * Falls back to Google favicon service for the author's domain.
 */
function resolveClaudeLogo(
	iconUrl?: string,
	authorUrl?: string,
): string | null {
	// Check if iconUrl is an actual image (SVG, PNG, ICO, etc.)
	if (iconUrl) {
		const lower = iconUrl.toLowerCase();
		const imageExts = [
			".svg",
			".png",
			".jpg",
			".jpeg",
			".ico",
			".webp",
			".gif",
		];
		const isImage = imageExts.some(
			(ext) => lower.endsWith(ext) || lower.includes(`${ext}?`),
		);
		const isDataUri = lower.startsWith("data:image/");
		if (isImage || isDataUri) return iconUrl;
	}
	// Fallback: use Google's favicon API from the author's website
	const domain = authorUrl || iconUrl;
	if (domain) {
		try {
			const url = new URL(
				domain.startsWith("http") ? domain : `https://${domain}`,
			);
			return `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=128`;
		} catch {
			// invalid URL
		}
	}
	return null;
}

/**
 * Transform Claude server entry (registry format) to common format
 * Note: rawData is omitted to avoid D1 SQLITE_TOOBIG errors
 */
export function transformClaudeServerEntry(
	entry: RawClaudeServerEntry,
): SyncCatalogAppInput {
	const registry = entry._meta?.["com.anthropic.api/mcp-registry"];
	const official = entry._meta?.["io.modelcontextprotocol.registry/official"];

	let baseUrl: string | null = null;
	if (entry.server?.remotes) {
		const httpRemote = entry.server.remotes.find(
			(r) => r.type === "streamable-http" || r.type === "sse",
		);
		if (httpRemote?.url) {
			baseUrl = httpRemote.url;
		}
	}

	const sourceAppId =
		registry?.uuid ||
		entry.server?.name ||
		registry?.url ||
		baseUrl ||
		"unknown";

	const name =
		registry?.displayName ||
		entry.server?.title ||
		entry.server?.name ||
		"Unknown Server";

	const description = registry?.oneLiner || entry.server?.description || null;

	const isOfficial = official?.status === "active";

	// Map permissions to write capability
	const hasWrites = registry?.permissions
		? registry.permissions.toLowerCase().includes("write")
		: false;

	return {
		source: "claude" as Source,
		sourceAppId,
		name,
		description,
		baseUrl,
		connectorType: "MCP" as ConnectorType,
		developerType: isOfficial
			? ("TRUSTED_PARTNER" as DeveloperType)
			: ("THIRD_PARTY" as DeveloperType),
		developer: registry?.author?.name || null,
		website: registry?.author?.url || registry?.url || null,
		privacyPolicy: registry?.privacyPolicy || null,
		logoUrl:
			resolveClaudeLogo(registry?.iconUrl, registry?.author?.url) || null,
		hasWrites,
		hasInteractive: false,
		authRequired: registry?.isAuthless !== true,
		authTypes: registry?.isAuthless === true ? ["NONE" as AuthType] : null,
		categories: registry?.useCases || null,
		seoDescription: entry.server?.description || null,
		version: entry.server?.version || null,
		storeUrl: registry?.directoryUrl || null,
		// Prefer added_at (clean ISO date), fall back to createdOn/publishedAt (may be JS .toString() format)
		sourceCreatedAt:
			registry?.added_at ||
			registry?.createdOn ||
			official?.publishedAt ||
			null,
		// Documentation & support
		documentationUrl: registry?.documentation || null,
		supportUrl: registry?.support || null,
		// Per-store scoring
		popularityScore: registry?.popularityScore ?? null,
		trendingScore: registry?.trendingScore ?? null,
		rank: registry?.rank ?? null,
		worksWith: registry?.worksWith ?? null,
		reviewStatus: isOfficial
			? ("RELEASED" as ReviewStatus)
			: ("PENDING" as ReviewStatus),
		// Rich content from Claude registry
		richContent: {
			htmlDescription: registry?.htmlContent || null,
			heroVideoId: registry?.heroVideoId || null,
			heroVideoPreviewLink: registry?.heroVideoPreviewLink || null,
			installCommand: registry?.claudeCodeCopyText || null,
			serverLabel: registry?.serverLabel || null,
			publishedAt: registry?.publishedOn || null,
			sourceUpdatedAt: registry?.updatedOn || null,
		},
		rawData: null,
	};
}
