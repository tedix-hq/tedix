import { assetsBaseUrl as resolveAssetsBaseUrl } from "./assets-base-url";
import { CatalogSnapshotSchema } from "@tedix/api-contract/schemas/catalog-snapshot";
/**
 * CatalogSyncWorkflow - Cloudflare Workflow for syncing Catalog
 *
 * Sync modes:
 * - r2: Read JSON files from R2 bucket (recommended for production)
 * - upload: Accept pre-fetched JSON data in request body (for small datasets)
 * - full: Fetch all apps from a live source directory API
 * - incremental: Fetch only changed apps (not implemented)
 *
 * Supported sources:
 * - Supplier snapshots: normalized inputs captured by private executable skills
 * - Claude: official Anthropic MCP Registry snapshots (supplemental metadata)
 *
 * Flow:
 * 1. Create sync log entry
 * 2. List/read JSON files from R2 or request body
 * 3. Auto-detect source from filename pattern
 * 4. Transform source format to common SyncCatalogAppInput
 * 5. Batch upsert (50 apps per batch for D1 compatibility)
 * 6. Detect removed apps (full sync only)
 * 7. Finalize sync log
 *
 * @see https://developers.cloudflare.com/workflows/
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createDbClient } from "@tedix/db/client";
import { syncCatalogMcpTools } from "@tedix/db/queries/catalog/mcp-tools";
import {
	getCatalogSnapshotStats,
	listEnabledCatalogAppsForVectorSync,
} from "@tedix/db/queries/catalog/scheduled-maintenance";
import { getCatalogStoreListingBySourceId } from "@tedix/db/queries/catalog/store-listings";
import {
	disableOrphanedCatalogApps,
	markStaleFeedStoreListingsAsRemoved,
	markStoreListingsAsRemoved,
	updateAppCatalogSyncLog,
} from "@tedix/db/queries/catalog/sync-logs";
import {
	bulkSyncCatalogAppsFromStore,
	type SyncCatalogAppInput,
} from "@tedix/db/queries/catalog/upsert-sync";
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
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	bulkUpsertCatalogApps,
	type CatalogAppVectorInput,
	getOrCreateCatalogVectorClient,
} from "@tedix/db/vector/catalog";
import { runCatalogSyncBatch } from "./catalog-sync-batch";
import { isSupportedCatalogR2Path } from "../lib/catalog-sync-source";
import {
	type DetectedSource,
	detectSourceFromFilename,
	isCatalogSyncDeployReset,
	planCatalogFileBatchOffsets,
	planCatalogVectorPageOffsets,
} from "./catalog-sync-files";

// ============================================================================
// Types
// ============================================================================

export type SyncType = "full" | "incremental" | "upload" | "r2";

const CATALOG_VECTOR_PAGE_SIZE = 100;

export interface CatalogSyncWorkflowParams {
	/** Sync mode */
	syncType: SyncType;
	searchOnly?: boolean;
	/** R2 path to JSON file or folder (for r2 mode) */
	r2Path?: string;
	/** Live source dispatch for full syncs */
	source?: "claude" | "snapshot";
	snapshotKey?: string;
	snapshotFeed?: string;
	snapshotUpstreamUrl?: string;
	snapshotProvenanceKey?: string;
	snapshotRemovalSources?: Source[];
	snapshotOwner?: string;
	snapshotInputHash?: string;
	/** For upload mode: pre-fetched JSON data */
	data?: Record<string, unknown>;
	/** Sync log ID (created before workflow starts) */
	syncLogId: string;
}

interface R2FileBatchResult {
	filename: string;
	source: Source;
	appsCount: number;
	workItemsCount: number;
	inserted: number;
	updated: number;
	failed: number;
	errors: string[];
	sourceAppIds: string[];
}

/** Raw connector format from source API */
interface RawConnector {
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

interface RawClaudeServerEntry {
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

type NormalizedCatalogAsset = {
	url: string | null;
	normalized: boolean;
	status:
		| "normalized"
		| "already_normalized"
		| "missing"
		| "fetch_failed"
		| "invalid";
};

// ============================================================================
// Mapping Functions
// ============================================================================

function mapCategory(category: string | null): Category | null {
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

function mapConnectorType(type: string): ConnectorType {
	const typeMap: Record<string, ConnectorType> = {
		MCP: "MCP",
		SERVICE: "SERVICE",
		FIRST_PARTY_ECOSYSTEM: "FIRST_PARTY_ECOSYSTEM",
	};
	return typeMap[type] || "MCP";
}

function mapDistributionChannel(
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

function mapDeveloperType(type: string | null): DeveloperType | null {
	if (!type) return null;
	const typeMap: Record<string, DeveloperType> = {
		TRUSTED_PARTNER: "TRUSTED_PARTNER",
		OAI: "OAI",
		THIRD_PARTY: "THIRD_PARTY",
	};
	return typeMap[type] || null;
}

function mapReviewStatus(status: string | null): ReviewStatus | null {
	if (!status) return null;
	const statusMap: Record<string, ReviewStatus> = {
		RELEASED: "RELEASED",
		PENDING: "PENDING",
		REJECTED: "REJECTED",
	};
	return statusMap[status] || null;
}

function mapAppStatus(status: string | null | undefined): AppStatus | null {
	if (!status) return null;
	const normalized = status.trim().toUpperCase();
	if (normalized === "ENABLED") return "ENABLED";
	if (normalized === "DISABLED") return "DISABLED";
	if (normalized === "PENDING") return "PENDING";
	// Private/limited visibility values from source APIs should not be public.
	if (normalized === "ONLY_ME") return "DISABLED";
	return null;
}

function mapAuthTypes(
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
function isChatGPTFormat(data: unknown): data is LiveAppsData {
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
function isClaudeFormat(data: unknown): data is ClaudeEntriesData {
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
function isChatGPTAppsListFormat(data: unknown): data is ChatGPTAppsListData {
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
function isChatGPTActionsFormat(data: unknown): data is ChatGPTActionsData {
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
function isClaudeServersFormat(data: unknown): data is ClaudeServersData {
	return (
		typeof data === "object" &&
		data !== null &&
		"servers" in data &&
		Array.isArray((data as ClaudeServersData).servers)
	);
}

function transformClaudeEntry(entry: RawClaudeEntry): SyncCatalogAppInput {
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
function transformChatGPTAppsListEntry(
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
function transformChatGPTActionsEntry(
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
function transformClaudeServerEntry(
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

// ============================================================================
// Workflow Implementation
// ============================================================================

export class CatalogSyncWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	CatalogSyncWorkflowParams
> {
	private readonly BATCH_SIZE = 50;
	private readonly R2_BATCH_SIZE = 25;
	private readonly CATALOG_ASSET_FETCH_TIMEOUT_MS = 10_000;

	/**
	 * Detect the sync source from an R2 path prefix.
	 * e.g. "catalog/claude/" → "claude"
	 */
	private detectSourceFromR2Path(r2Path?: string): Source | null {
		if (!r2Path) return null;
		if (r2Path.includes("catalog/claude")) return "claude" as Source;
		return null;
	}

	async run(
		event: WorkflowEvent<CatalogSyncWorkflowParams>,
		step: WorkflowStep,
	) {
		const {
			syncType,
			r2Path,
			data,
			syncLogId,
			source: liveSource,
			searchOnly = false,
		} = event.payload;

		console.log(
			`[App Catalog Sync] Starting ${syncType} sync, logId: ${syncLogId}`,
		);

		const db = createDbClient(this.env.DB);

		// Detect source early from R2 path so sync log has it from the start
		const detectedSource = this.detectSourceFromR2Path(r2Path);
		if (detectedSource) {
			await updateAppCatalogSyncLog(db, syncLogId, {
				source: detectedSource,
			});
		}

		// Track results across files (store minimal data, not full apps array)
		let totalAppsDiscovered = 0;
		let totalInserted = 0;
		let totalUpdated = 0;
		let totalFailed = 0;
		const filesProcessed: string[] = [];
		const sourcesProcessed: Source[] = [];
		const allErrors: string[] = [];
		const sourceAppIds: Map<Source, string[]> = new Map();

		try {
			// Step 0: Capture catalog state before sync for changelog diff
			const beforeStats = (await step.do(
				"capture-before-stats",
				{ retries: { limit: 2, delay: "1 second" }, timeout: "30 seconds" },
				async () => {
					return getCatalogSnapshotStats(db);
				},
			)) as { total: number; mcpCount: number; enabledCount: number };

			if (searchOnly) {
				// Existing catalog is the input. No supplier capture or catalog writes.
			} else if (syncType === "r2") {
				// R2 mode: list and process files from R2 bucket
				if (!r2Path) {
					await this.failSync(
						db,
						syncLogId,
						"R2 mode requires r2Path parameter",
					);
					return {
						success: false,
						error: "R2 mode requires r2Path parameter",
						syncLogId,
					};
				}

				if (!isSupportedCatalogR2Path(r2Path)) {
					await this.failSync(
						db,
						syncLogId,
						"R2 sync supports only the Claude registry namespace.",
					);
					return {
						success: false,
						error: "R2 sync supports only the Claude registry namespace.",
						syncLogId,
					};
				}

				// Step 1: List files in R2
				const fileListJson = await step.do(
					"list-r2-files",
					{
						retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
						timeout: "1 minute",
					},
					async () => {
						const files = await this.listR2Files(r2Path);
						return JSON.stringify(files);
					},
				);

				const r2Files = JSON.parse(fileListJson as string) as string[];
				console.log(
					`[App Catalog Sync] Found ${r2Files.length} files in R2: ${r2Files.join(", ")}`,
				);

				if (r2Files.length === 0) {
					await this.failSync(
						db,
						syncLogId,
						`No JSON files found at R2 path: ${r2Path}`,
					);
					return { success: false, error: "No JSON files found", syncLogId };
				}

				// Step 2: Process official registry files in bounded durable batches.
				// A registry file can contain hundreds of servers, and tool projection
				// performs multiple D1 operations per server. Keeping the whole file in
				// one step exceeded Cloudflare's five-minute attempt window.
				for (const filePath of r2Files) {
					const detectedSource = detectSourceFromFilename(filePath);
					if (!detectedSource) {
						console.log(
							`[App Catalog Sync] Skipping file (not a main data file): ${filePath}`,
						);
						continue;
					}

					const stableFileName = filePath.replace(/[^a-zA-Z0-9]/g, "_");
					const firstResult = (await step.do(
						`sync-file-${stableFileName}-batch-0`,
						{
							retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
							timeout: "5 minutes",
						},
						async () => {
							return await this.processAndCheckpointR2FileBatch(
								db,
								syncLogId,
								filePath,
								detectedSource,
								0,
								this.R2_BATCH_SIZE,
								{
									appsDiscovered: totalAppsDiscovered,
									appsUpdated: totalInserted + totalUpdated,
									appsFailed: totalFailed,
								},
							);
						},
					)) as R2FileBatchResult;

					let fileInserted = firstResult.inserted;
					let fileUpdated = firstResult.updated;
					let fileFailed = firstResult.failed;
					const fileErrors = [...firstResult.errors];
					const batchOffsets = planCatalogFileBatchOffsets(
						firstResult.workItemsCount,
						this.R2_BATCH_SIZE,
					);

					for (const offset of batchOffsets.slice(1)) {
						const priorFileInserted = fileInserted;
						const priorFileUpdated = fileUpdated;
						const priorFileFailed = fileFailed;
						const batchResult = (await step.do(
							`sync-file-${stableFileName}-batch-${offset}`,
							{
								retries: {
									limit: 2,
									delay: "5 seconds",
									backoff: "exponential",
								},
								timeout: "5 minutes",
							},
							async () => {
								return await this.processAndCheckpointR2FileBatch(
									db,
									syncLogId,
									filePath,
									detectedSource,
									offset,
									this.R2_BATCH_SIZE,
									{
										appsDiscovered: totalAppsDiscovered + firstResult.appsCount,
										appsUpdated:
											totalInserted +
											totalUpdated +
											priorFileInserted +
											priorFileUpdated,
										appsFailed: totalFailed + priorFileFailed,
									},
								);
							},
						)) as R2FileBatchResult;
						fileInserted += batchResult.inserted;
						fileUpdated += batchResult.updated;
						fileFailed += batchResult.failed;
						fileErrors.push(...batchResult.errors);
					}

					console.log(
						`[App Catalog Sync] Synced ${firstResult.filename}: ${firstResult.appsCount} apps in ${batchOffsets.length} batches (${fileInserted} inserted, ${fileUpdated} updated, ${fileFailed} failed)`,
					);

					totalAppsDiscovered += firstResult.appsCount;
					totalInserted += fileInserted;
					totalUpdated += fileUpdated;
					totalFailed += fileFailed;
					filesProcessed.push(firstResult.filename);
					if (!sourcesProcessed.includes(firstResult.source)) {
						sourcesProcessed.push(firstResult.source);
					}
					allErrors.push(...fileErrors.slice(0, 10));

					// Track source app IDs for removal detection
					const existingIds = sourceAppIds.get(firstResult.source) || [];
					sourceAppIds.set(firstResult.source, [
						...existingIds,
						...firstResult.sourceAppIds,
					]);
				}
			} else if (syncType === "full" && liveSource === "snapshot") {
				if (!event.payload.snapshotKey || !event.payload.snapshotProvenanceKey)
					throw new NonRetryableError(
						"Snapshot archive and provenance are required",
					);
				const archived = await this.readR2Json(event.payload.snapshotKey);
				if (archived.inputHash !== event.payload.snapshotInputHash)
					throw new NonRetryableError("Snapshot input identity mismatch");
				const snapshot = CatalogSnapshotSchema.parse(archived.snapshot);
				totalAppsDiscovered = snapshot.items.length;
				const batches = this.splitIntoBatches(snapshot.items, 10);
				for (const [index, batch] of batches.entries()) {
					const result = await step.do(
						`sync-snapshot-batch-${index}`,
						{
							retries: { limit: 2, delay: "10 seconds" },
							timeout: "5 minutes",
						},
						async () => {
							const outcome = await runCatalogSyncBatch(batch, {
								normalize: (items) => this.normalizeCatalogAssets(items),
								sync: (items) =>
									bulkSyncCatalogAppsFromStore(db, items, {
										allowCreate: true,
									}),
							});
							if (outcome.failed)
								throw new Error(
									`Snapshot batch ${index} failed: ${outcome.errors.join("; ")}`,
								);
							return outcome;
						},
					);
					totalInserted += result.inserted;
					totalUpdated += result.updated;
				}
				for (const item of snapshot.items) {
					if (!sourcesProcessed.includes(item.source))
						sourcesProcessed.push(item.source);
					if (event.payload.snapshotRemovalSources?.includes(item.source)) {
						const ids = sourceAppIds.get(item.source) ?? [];
						ids.push(item.sourceAppId);
						sourceAppIds.set(item.source, ids);
					}
				}
				filesProcessed.push(event.payload.snapshotKey);
			} else if (syncType === "upload") {
				// Upload mode: process data from request body in one step
				if (!data) {
					await this.failSync(
						db,
						syncLogId,
						"Upload mode requires data parameter",
					);
					return {
						success: false,
						error: "Upload mode requires data parameter",
						syncLogId,
					};
				}

				const resultJson = await step.do(
					"sync-upload-data",
					{
						retries: { limit: 2, delay: "5 seconds" },
						timeout: "10 minutes",
					},
					async () => {
						return await this.processAndSyncUploadData(data);
					},
				);

				const result = resultJson as {
					source: Source;
					appsCount: number;
					inserted: number;
					updated: number;
					failed: number;
					errors: string[];
					sourceAppIds: string[];
				};

				totalAppsDiscovered = result.appsCount;
				totalInserted = result.inserted;
				totalUpdated = result.updated;
				totalFailed = result.failed;
				filesProcessed.push("upload");
				sourcesProcessed.push(result.source);
				allErrors.push(...result.errors);
				sourceAppIds.set(result.source, result.sourceAppIds);
			} else {
				await this.failSync(
					db,
					syncLogId,
					`Sync type "${syncType}" not supported. Use "r2", "upload", or the supplier snapshot import API.`,
				);
				return { success: false, error: "Unsupported sync type", syncLogId };
			}

			console.log(
				`[App Catalog Sync] Total: ${totalAppsDiscovered} apps discovered, ${totalInserted} inserted, ${totalUpdated} updated`,
			);

			if (!searchOnly && totalAppsDiscovered === 0) {
				await this.failSync(db, syncLogId, "No apps found in data sources");
				return { success: false, error: "No apps found", syncLogId };
			}

			// Update sync log with discovered count and sources
			const sourceSummary =
				sourcesProcessed.length === 1
					? sourcesProcessed[0]
					: (detectedSource ?? null);
			await updateAppCatalogSyncLog(db, syncLogId, {
				appsDiscovered: totalAppsDiscovered,
				source: sourceSummary as Source | null,
			});

			// Step 3: Detect removed apps per source
			let totalListingsRemoved = 0;
			let totalAppsDisabled = 0;

			for (const [source, ids] of sourceAppIds) {
				if (ids.length > 0) {
					const removedResult = await step.do(
						`detect-removals-${source}`,
						{
							retries: { limit: 2, delay: "2 seconds" },
							timeout: "2 minutes",
						},
						async () => {
							const removed =
								liveSource === "snapshot"
									? await markStaleFeedStoreListingsAsRemoved(
											db,
											source,
											event.payload.snapshotProvenanceKey!,
											ids,
										)
									: await markStoreListingsAsRemoved(db, source, ids);
							return { listingsRemoved: removed };
						},
					);

					const result = removedResult as { listingsRemoved: number };
					totalListingsRemoved += result.listingsRemoved;
					console.log(
						`[App Catalog Sync] Removed ${result.listingsRemoved} store listings for ${source}`,
					);
				}
			}

			// Disable orphaned apps (apps with no store listings)
			if (searchOnly || liveSource === "snapshot") {
				console.log(
					"[App Catalog Sync] Skipping orphan-disable pass for snapshot or search-only refresh",
				);
			} else {
				const orphanResult = await step.do(
					"disable-orphaned-apps",
					{
						retries: { limit: 2, delay: "2 seconds" },
						timeout: "1 minute",
					},
					async () => {
						const disabled = await disableOrphanedCatalogApps(db);
						return { appsDisabled: disabled };
					},
				);

				totalAppsDisabled = (orphanResult as { appsDisabled: number })
					.appsDisabled;
			}

			// Step 4: Compute changelog diff (before vs after)
			const changelog = (await step.do(
				"compute-changelog",
				{ retries: { limit: 2, delay: "1 second" }, timeout: "30 seconds" },
				async () => {
					const after = await getCatalogSnapshotStats(db);

					return {
						before: beforeStats,
						after,
						netNewApps: after.total - beforeStats.total,
						netNewMcp: after.mcpCount - beforeStats.mcpCount,
						netNewEnabled: after.enabledCount - beforeStats.enabledCount,
						inserted: totalInserted,
						updated: totalUpdated,
						removed: totalAppsDisabled,
						listingsRemoved: totalListingsRemoved,
						failed: totalFailed,
						syncedAt: new Date().toISOString(),
					};
				},
			)) as {
				before: { total: number; mcpCount: number; enabledCount: number };
				after: { total: number; mcpCount: number; enabledCount: number };
				netNewApps: number;
				netNewMcp: number;
				netNewEnabled: number;
				inserted: number;
				updated: number;
				removed: number;
				listingsRemoved: number;
				failed: number;
				syncedAt: string;
			};

			console.log(
				`[CatalogSync] Changelog: ${changelog.netNewApps >= 0 ? "+" : ""}${changelog.netNewApps} net apps (${changelog.inserted} new, ${changelog.updated} updated, ${changelog.removed} removed), ` +
					`MCP: ${changelog.netNewMcp >= 0 ? "+" : ""}${changelog.netNewMcp}, total: ${changelog.after.total}`,
			);

			// Step 5: Reconcile the enabled catalog into AI Search in bounded,
			// durable pages. The former all-catalog step exceeded Cloudflare's
			// five-minute attempt window once the catalog reached 2,722 apps.
			let vectorReady = false;
			let vectorSynced = 0;
			let vectorFailed = 0;
			let vectorSkipped = false;
			const vectorErrors: string[] = [];
			try {
				vectorReady = (await step.do(
					"vector-index-ready",
					{
						retries: { limit: 1, delay: "2 seconds" },
						timeout: "30 seconds",
					},
					async () => {
						const vectorClient = await getOrCreateCatalogVectorClient(this.env);
						return vectorClient !== null;
					},
				)) as boolean;
				vectorSkipped = !vectorReady;
				if (!vectorReady) {
					console.log(
						"[App Catalog Sync] Catalog vector index not configured — skipping vector sync",
					);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error("[App Catalog Sync] Vector index setup failed", error);
				vectorSkipped = true;
				vectorErrors.push(message);
			}

			if (vectorReady) {
				const vectorOffsets = planCatalogVectorPageOffsets(
					changelog.after.enabledCount,
					CATALOG_VECTOR_PAGE_SIZE,
				);
				for (const offset of vectorOffsets) {
					try {
						const result = (await step.do(
							`vector-index-sync-${offset}`,
							{
								retries: { limit: 1, delay: "2 seconds" },
								timeout: "5 minutes",
							},
							async () => {
								const vectorClient = await getOrCreateCatalogVectorClient(
									this.env,
								);
								if (!vectorClient) {
									return { vectorSynced: 0, vectorFailed: 0, skipped: true };
								}
								const apps = await listEnabledCatalogAppsForVectorSync(db, {
									limit: CATALOG_VECTOR_PAGE_SIZE,
									offset,
								});
								const vectorApps: CatalogAppVectorInput[] = apps.map((app) => ({
									id: app.id,
									slug: app.slug,
									name: app.name,
									description: app.description,
									modelDescription: app.modelDescription,
									developer: app.developer,
									category: app.category,
									categories: app.categories as string[] | null,
									keywordsForDiscovery: app.keywordsForDiscovery as
										| string[]
										| null,
									keywordsForTriggering: app.keywordsForTriggering as
										| string[]
										| null,
									seoDescription: app.seoDescription,
									healthStatus: app.healthStatus,
									mcpToolCount: app.mcpToolCount,
									mcpEndpointNormalized: app.mcpEndpointNormalized,
									connectorType: app.connectorType,
									hasWrites: app.hasWrites,
									hasInteractive: app.hasInteractive,
								}));
								const result = await bulkUpsertCatalogApps(
									vectorClient,
									vectorApps,
								);
								console.log(
									`[App Catalog Sync] Vector page ${offset}: ${result.upserted} upserted, ${result.failed} failed`,
								);
								return {
									vectorSynced: result.upserted,
									vectorFailed: result.failed,
									skipped: false,
								};
							},
						)) as {
							vectorSynced: number;
							vectorFailed: number;
							skipped: boolean;
						};
						vectorSynced += result.vectorSynced;
						vectorFailed += result.vectorFailed;
						vectorSkipped ||= result.skipped;
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						console.error(
							`[App Catalog Sync] Vector page ${offset} failed after retries`,
							error,
						);
						vectorFailed += Math.min(
							CATALOG_VECTOR_PAGE_SIZE,
							changelog.after.enabledCount - offset,
						);
						vectorErrors.push(`offset ${offset}: ${message}`);
					}
				}
			}

			const search = {
				synced: vectorSynced,
				failed: vectorFailed,
				skipped: vectorSkipped,
				complete:
					!vectorSkipped &&
					vectorFailed === 0 &&
					vectorSynced === changelog.after.enabledCount,
				errors: vectorErrors.slice(0, 10),
			};
			const success = !searchOnly || search.complete;
			// Step 6: Finalize sync log with changelog
			await step.do(
				"finalize-sync-log",
				{ retries: { limit: 2, delay: "1 second" }, timeout: "30 seconds" },
				async () => {
					await updateAppCatalogSyncLog(db, syncLogId, {
						status: success ? "completed" : "failed",
						error: success
							? null
							: "AI Search refresh incomplete; retry searchOnly sync",
						completedAt: new Date().toISOString(),
						appsUpdated: totalInserted + totalUpdated,
						appsRemoved: totalAppsDisabled,
						appsFailed: totalFailed,
						details: {
							...(liveSource === "snapshot"
								? {
										source: event.payload.snapshotFeed ?? "snapshot",
										upstreamUrl: event.payload.snapshotUpstreamUrl ?? "",
										snapshotOwner: event.payload.snapshotOwner ?? "",
										inputHash: event.payload.snapshotInputHash ?? "",
										snapshotKey: event.payload.snapshotKey ?? "",
									}
								: {}),
							syncType,
							searchOnly,
							filesProcessed,
							sources: sourcesProcessed,
							changelog: {
								before: changelog.before,
								after: changelog.after,
								netNewApps: changelog.netNewApps,
								netNewMcp: changelog.netNewMcp,
								netNewEnabled: changelog.netNewEnabled,
							},
							inserted: totalInserted,
							updated: totalUpdated,
							listingsRemoved: totalListingsRemoved,
							appsDisabled: totalAppsDisabled,
							vector: search,
							errors: allErrors.slice(0, 10),
						},
					});
					return { success: true };
				},
			);

			console.log(
				`[App Catalog Sync] Sync complete: ${totalInserted} inserted, ${totalUpdated} updated, ${totalAppsDisabled} disabled, ${totalFailed} failed`,
			);

			return {
				success,
				search,
				syncLogId,
				appsDiscovered: totalAppsDiscovered,
				appsInserted: totalInserted,
				appsUpdated: totalUpdated,
				appsRemoved: totalAppsDisabled,
				appsFailed: totalFailed,
				filesProcessed,
				changelog: {
					before: changelog.before,
					after: changelog.after,
					netNewApps: changelog.netNewApps,
					netNewMcp: changelog.netNewMcp,
					netNewEnabled: changelog.netNewEnabled,
				},
			};
		} catch (error) {
			if (isCatalogSyncDeployReset(error)) {
				console.warn(
					"[App Catalog Sync] Deployment reset interrupted this attempt; allowing Workflow replay",
				);
				throw error;
			}

			// Ensure sync log is always finalized, even on unexpected errors
			console.error(`[App Catalog Sync] Unexpected error:`, error);
			try {
				await updateAppCatalogSyncLog(db, syncLogId, {
					status: "failed",
					completedAt: new Date().toISOString(),
					appsUpdated: totalInserted + totalUpdated,
					appsFailed: totalFailed,
					error: error instanceof Error ? error.message : String(error),
				});
			} catch (logError) {
				console.error(
					`[App Catalog Sync] Failed to update sync log:`,
					logError,
				);
			}
			return {
				success: false,
				syncLogId,
				error: error instanceof Error ? error.message : String(error),
				appsDiscovered: totalAppsDiscovered,
				appsInserted: totalInserted,
				appsUpdated: totalUpdated,
				appsFailed: totalFailed,
				filesProcessed,
			};
		}
	}

	/**
	 * Helper to fail sync with error
	 */
	private async failSync(
		db: ReturnType<typeof createDbClient>,
		syncLogId: string,
		error: string,
	) {
		await updateAppCatalogSyncLog(db, syncLogId, {
			status: "failed",
			completedAt: new Date().toISOString(),
			error,
		});
	}

	/**
	 * List JSON files in R2 path
	 */
	private async listR2Files(r2Path: string): Promise<string[]> {
		const files: string[] = [];

		// Check if path is a single file or folder
		if (r2Path.endsWith(".json")) {
			// Single file
			const obj = await this.env.R2_BUCKET.head(r2Path);
			if (obj) {
				files.push(r2Path);
			}
		} else {
			// Folder - list all JSON files
			const prefix = r2Path.endsWith("/") ? r2Path : `${r2Path}/`;
			const listed = await this.env.R2_BUCKET.list({ prefix });

			for (const obj of listed.objects) {
				if (obj.key.endsWith(".json")) {
					files.push(obj.key);
				}
			}
		}

		return files;
	}

	/**
	 * Process and sync one bounded slice of an R2 file. Re-reading the source in
	 * each step is intentional: Workflow state receives only a compact summary,
	 * while stable upserts keep retries idempotent.
	 */
	private async processAndSyncFileBatch(
		filePath: string,
		detectedSource: DetectedSource,
		batchOffset: number,
		batchSize: number,
	): Promise<R2FileBatchResult> {
		const db = createDbClient(this.env.DB);
		const { source, filename } = detectedSource;
		const allowCreate = detectedSource.allowCreate ?? true;

		const data = await this.readR2Json(filePath);

		// Transform to apps
		const apps: SyncCatalogAppInput[] = [];
		const transformErrors: string[] = [];
		let workItemsCount = 0;

		if (source === "claude" && isClaudeFormat(data)) {
			workItemsCount = data.entries.length;
			for (const entry of data.entries) {
				try {
					const app = transformClaudeEntry(entry);
					apps.push(app);
				} catch (error) {
					transformErrors.push(`Transform failed for ${entry.id}: ${error}`);
				}
			}
		} else if (source === "claude" && isClaudeServersFormat(data)) {
			workItemsCount = data.servers.length;
			for (const entry of data.servers) {
				try {
					const app = transformClaudeServerEntry(entry);
					apps.push(app);
				} catch (error) {
					const name = entry.server?.name || entry.server?.title || "unknown";
					transformErrors.push(`Transform failed for ${name}: ${error}`);
				}
			}
		} else {
			throw new NonRetryableError(
				`Cannot process ${filename}: format doesn't match detected source ${source}`,
			);
		}

		console.log(
			`[App Catalog Sync] Transformed ${apps.length} apps from ${filename}`,
		);

		// Batch insert directly (don't return apps array)
		const batchApps = apps.slice(batchOffset, batchOffset + batchSize);
		const batches = this.splitIntoBatches(batchApps);
		let totalInserted = 0;
		let totalUpdated = 0;
		const syncErrors: string[] = [];

		for (const batch of batches) {
			try {
				const result = await bulkSyncCatalogAppsFromStore(db, batch, {
					allowCreate,
				});
				totalInserted += result.inserted;
				totalUpdated += result.updated;
				syncErrors.push(...result.errors);
			} catch (error) {
				syncErrors.push(`Batch sync failed: ${error}`);
			}
		}

		// Pre-populate tools from Claude Registry toolNames
		if (source === "claude" && isClaudeServersFormat(data)) {
			const toolsResult = await this.prePopulateToolsFromClaudeRegistry(
				data.servers.slice(batchOffset, batchOffset + batchSize),
			);
			if (toolsResult.errors.length > 0) {
				syncErrors.push(...toolsResult.errors);
			}
		}

		// Return only summary, not the apps array
		return {
			filename,
			source,
			appsCount: apps.length,
			workItemsCount: Math.max(workItemsCount, apps.length),
			inserted: totalInserted,
			updated: totalUpdated,
			failed:
				(batchOffset === 0 ? transformErrors.length : 0) + syncErrors.length,
			errors: [
				...(batchOffset === 0 ? transformErrors : []),
				...syncErrors,
			].slice(0, 10),
			sourceAppIds: batchOffset === 0 ? apps.map((app) => app.sourceAppId) : [],
		};
	}

	private async processAndCheckpointR2FileBatch(
		db: ReturnType<typeof createDbClient>,
		syncLogId: string,
		filePath: string,
		detectedSource: DetectedSource,
		batchOffset: number,
		batchSize: number,
		prior: {
			appsDiscovered: number;
			appsUpdated: number;
			appsFailed: number;
		},
	): Promise<R2FileBatchResult> {
		const result = await this.processAndSyncFileBatch(
			filePath,
			detectedSource,
			batchOffset,
			batchSize,
		);
		const processedOffset = Math.min(
			batchOffset + batchSize,
			result.workItemsCount,
		);

		await updateAppCatalogSyncLog(db, syncLogId, {
			status: "running",
			completedAt: null,
			error: null,
			appsDiscovered:
				batchOffset === 0
					? prior.appsDiscovered + result.appsCount
					: prior.appsDiscovered,
			appsUpdated: prior.appsUpdated + result.inserted + result.updated,
			appsFailed: prior.appsFailed + result.failed,
			details: {
				status: "running",
				mode: "r2",
				source: result.source,
				filePath,
				total: result.workItemsCount,
				offset: processedOffset,
				batchSize,
			},
		});

		return result;
	}

	private assetsBaseUrl(): string {
		return resolveAssetsBaseUrl(this.env);
	}

	private isTedixCatalogAsset(url: string | null | undefined): boolean {
		if (!url) return false;
		return url.startsWith(`${this.assetsBaseUrl()}/app_catalog/`);
	}

	private safeAssetSegment(value: string): string {
		return (
			value
				.toLowerCase()
				.replace(/[^a-z0-9._-]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 140) || crypto.randomUUID()
		);
	}

	private extensionFromContentType(
		contentType: string,
		url: string,
	): { ext: string; contentType: string } {
		const lowerType = contentType.toLowerCase();
		const lowerUrl = url.toLowerCase().split("?")[0] ?? "";
		if (lowerType.includes("svg") || lowerUrl.endsWith(".svg")) {
			return { ext: "svg", contentType: "image/svg+xml" };
		}
		if (lowerType.includes("webp") || lowerUrl.endsWith(".webp")) {
			return { ext: "webp", contentType: "image/webp" };
		}
		if (lowerType.includes("png") || lowerUrl.endsWith(".png")) {
			return { ext: "png", contentType: "image/png" };
		}
		if (
			lowerType.includes("jpeg") ||
			lowerType.includes("jpg") ||
			lowerUrl.endsWith(".jpg") ||
			lowerUrl.endsWith(".jpeg")
		) {
			return { ext: "jpg", contentType: "image/jpeg" };
		}
		if (lowerType.includes("gif") || lowerUrl.endsWith(".gif")) {
			return { ext: "gif", contentType: "image/gif" };
		}
		return { ext: "png", contentType: "image/png" };
	}

	private async copyCatalogAssetToR2(
		sourceUrl: string | null | undefined,
		keyBase: string,
	): Promise<NormalizedCatalogAsset> {
		if (!sourceUrl) return { url: null, normalized: false, status: "missing" };
		const trimmed = sourceUrl.trim();
		if (!trimmed) return { url: null, normalized: false, status: "missing" };
		if (this.isTedixCatalogAsset(trimmed)) {
			return { url: trimmed, normalized: true, status: "already_normalized" };
		}

		try {
			let bytes: ArrayBuffer;
			let metadata: { ext: string; contentType: string };

			if (trimmed.startsWith("data:image/")) {
				const match = trimmed.match(/^data:([^;,]+)(;base64)?,(.*)$/);
				if (!match) return { url: null, normalized: false, status: "invalid" };
				const contentType = match[1] ?? "image/png";
				const isBase64 = Boolean(match[2]);
				const payload = match[3] ?? "";
				const text = isBase64 ? atob(payload) : decodeURIComponent(payload);
				bytes = Uint8Array.from(text, (char) => char.charCodeAt(0)).buffer;
				metadata = this.extensionFromContentType(contentType, trimmed);
			} else if (
				trimmed.startsWith("http://") ||
				trimmed.startsWith("https://")
			) {
				const response = await fetch(trimmed, {
					headers: {
						accept:
							"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
						"user-agent": "TedixCatalogAssetSync/1.0",
					},
					signal: AbortSignal.timeout(this.CATALOG_ASSET_FETCH_TIMEOUT_MS),
				});
				if (!response.ok) {
					await response.body?.cancel();
					console.warn(
						`[App Catalog Sync] Asset fetch failed ${response.status}: ${trimmed}`,
					);
					return { url: null, normalized: false, status: "fetch_failed" };
				}
				bytes = await response.arrayBuffer();
				metadata = this.extensionFromContentType(
					response.headers.get("content-type") ?? "",
					trimmed,
				);
			} else {
				return { url: null, normalized: false, status: "invalid" };
			}

			if (bytes.byteLength < 64 || bytes.byteLength > 8_000_000) {
				return { url: null, normalized: false, status: "invalid" };
			}

			const key = `${keyBase}.${metadata.ext}`;
			await this.env.R2_BUCKET.put(key, bytes, {
				httpMetadata: {
					contentType: metadata.contentType,
					cacheControl: "public, max-age=31536000, immutable",
				},
				customMetadata: {
					sourceUrl: trimmed.slice(0, 1024),
					normalizedAt: new Date().toISOString(),
				},
			});

			return {
				url: `${this.assetsBaseUrl()}/${key}`,
				normalized: true,
				status: "normalized",
			};
		} catch (error) {
			console.warn(
				`[App Catalog Sync] Failed to normalize catalog asset ${trimmed}:`,
				error,
			);
			return { url: null, normalized: false, status: "fetch_failed" };
		}
	}

	private async normalizeCatalogAssets(
		inputs: SyncCatalogAppInput[],
	): Promise<SyncCatalogAppInput[]> {
		return Promise.all(
			inputs.map((input) => this.normalizeCatalogAssetsForInput(input)),
		);
	}

	private async normalizeCatalogAssetsForInput(
		input: SyncCatalogAppInput,
	): Promise<SyncCatalogAppInput> {
		const source = this.safeAssetSegment(input.source);
		const sourceAppId = this.safeAssetSegment(input.sourceAppId);
		const keyRoot = `app_catalog/${source}/${sourceAppId}`;
		const next: SyncCatalogAppInput = {
			...input,
			logoUrl: null,
			logoUrlDark: null,
			richContent: input.richContent ? { ...input.richContent } : null,
			screenshots: input.screenshots ? [...input.screenshots] : null,
		};

		if (input.logoUrl) {
			const logo = await this.copyCatalogAssetToR2(
				input.logoUrl,
				`${keyRoot}/logo`,
			);
			if (logo.url) {
				next.logoUrl = logo.url;
				next.rawData = this.withCatalogAssetQuality(next.rawData, {
					logoStatus: logo.status,
					logoSourceUrl: input.logoUrl,
				});
			} else {
				const fallbackLogo = await this.copyFallbackFaviconToR2(
					input,
					`${keyRoot}/logo`,
				);
				if (fallbackLogo.url) {
					next.logoUrl = fallbackLogo.url;
				}
				next.rawData = this.withCatalogAssetQuality(next.rawData, {
					logoStatus: fallbackLogo.url ? "fallback_favicon" : logo.status,
					logoSourceUrl: input.logoUrl,
				});
			}
		} else {
			const fallbackLogo = await this.copyFallbackFaviconToR2(
				input,
				`${keyRoot}/logo`,
			);
			if (fallbackLogo.url) {
				next.logoUrl = fallbackLogo.url;
			}
			next.rawData = this.withCatalogAssetQuality(next.rawData, {
				logoStatus: fallbackLogo.url ? "fallback_favicon" : "missing",
				logoSourceUrl: null,
			});
		}

		if (input.logoUrlDark) {
			const logoDark = await this.copyCatalogAssetToR2(
				input.logoUrlDark,
				`${keyRoot}/logo-dark`,
			);
			if (logoDark.url) next.logoUrlDark = logoDark.url;
		}

		const screenshotUrls = input.screenshots ?? [];
		if (screenshotUrls.length > 0) {
			const screenshotAssets = await Promise.all(
				screenshotUrls
					.slice(0, 4)
					.map((screenshot, index) =>
						this.copyCatalogAssetToR2(
							screenshot,
							`${keyRoot}/screenshots/${index + 1}`,
						),
					),
			);
			const r2Screenshots = screenshotAssets.flatMap((asset) =>
				asset.url ? [asset.url] : [],
			);
			if (r2Screenshots.length > 0) {
				next.screenshots = r2Screenshots;
				next.richContent = {
					...next.richContent,
					screenshotUrl: r2Screenshots[0] ?? null,
				};
			}
			next.rawData = this.withCatalogAssetQuality(next.rawData, {
				screenshotStatus:
					r2Screenshots.length === screenshotUrls.length
						? "normalized"
						: r2Screenshots.length > 0
							? "partial"
							: "missing",
				screenshotCount: r2Screenshots.length,
			});
		}

		return next;
	}

	private async copyFallbackFaviconToR2(
		input: SyncCatalogAppInput,
		keyBase: string,
	): Promise<NormalizedCatalogAsset> {
		const domain = this.resolveBrandDomain(input);
		if (!domain) return { url: null, normalized: false, status: "missing" };
		return this.copyCatalogAssetToR2(
			`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=256`,
			keyBase,
		);
	}

	private withCatalogAssetQuality(
		rawData: Record<string, unknown> | null | undefined,
		assetQuality: Record<string, unknown>,
	): ReturnType<typeof toJsonRecord> {
		const base = typeof rawData === "object" && rawData !== null ? rawData : {};
		const currentQuality =
			typeof base.quality === "object" && base.quality !== null
				? (base.quality as Record<string, unknown>)
				: {};
		return toJsonRecord({
			...base,
			quality: {
				...currentQuality,
				...assetQuality,
				lastAssetCheckedAt: new Date().toISOString(),
			},
		});
	}

	private resolveBrandDomain(input: SyncCatalogAppInput): string | null {
		for (const candidate of [input.website, input.baseUrl, input.storeUrl]) {
			if (!candidate) continue;
			try {
				const parsed = new URL(candidate);
				return parsed.hostname.replace(/^www\./, "");
			} catch {}
		}
		return null;
	}

	private async readR2Json(filePath: string): Promise<Record<string, unknown>> {
		const obj = await this.env.R2_BUCKET.get(filePath);
		if (!obj) {
			throw new NonRetryableError(`File not found in R2: ${filePath}`);
		}
		const text = await obj.text();
		return JSON.parse(text);
	}

	/**
	 * Process and sync uploaded data in one step
	 * Returns summary only (no large arrays) to avoid workflow state size limits
	 */
	private async processAndSyncUploadData(
		data: Record<string, unknown>,
	): Promise<{
		source: Source;
		appsCount: number;
		inserted: number;
		updated: number;
		failed: number;
		errors: string[];
		sourceAppIds: string[];
	}> {
		const db = createDbClient(this.env.DB);
		let source: Source;
		const apps: SyncCatalogAppInput[] = [];
		const transformErrors: string[] = [];

		// Detect format and transform
		if (isChatGPTFormat(data)) {
			source = "chatgpt" as Source;
			for (const connector of data.connectors) {
				try {
					const app = this.transformConnector(connector);
					apps.push(app);
				} catch (error) {
					transformErrors.push(
						`Transform failed for ${connector.name}: ${error}`,
					);
				}
			}
		} else if (isChatGPTAppsListFormat(data)) {
			source = "chatgpt" as Source;
			for (const entry of data.apps) {
				try {
					const app = transformChatGPTAppsListEntry(entry);
					apps.push(app);
				} catch (error) {
					transformErrors.push(`Transform failed for ${entry.id}: ${error}`);
				}
			}
		} else if (isChatGPTActionsFormat(data)) {
			source = "chatgpt" as Source;
			for (const entry of data.links) {
				try {
					const app = transformChatGPTActionsEntry(entry);
					apps.push(app);
				} catch (error) {
					transformErrors.push(
						`Transform failed for ${entry.connector_id}: ${error}`,
					);
				}
			}
		} else if (isClaudeFormat(data)) {
			source = "claude" as Source;
			for (const entry of data.entries) {
				try {
					const app = transformClaudeEntry(entry);
					apps.push(app);
				} catch (error) {
					transformErrors.push(`Transform failed for ${entry.id}: ${error}`);
				}
			}
		} else if (isClaudeServersFormat(data)) {
			source = "claude" as Source;
			for (const entry of data.servers) {
				try {
					const app = transformClaudeServerEntry(entry);
					apps.push(app);
				} catch (error) {
					const name = entry.server?.name || entry.server?.title || "unknown";
					transformErrors.push(`Transform failed for ${name}: ${error}`);
				}
			}
		} else {
			throw new NonRetryableError(
				"Unknown data format. Expected { connectors: [...] } or { entries: [...] } or { servers: [...] }",
			);
		}

		console.log(
			`[App Catalog Sync] Transformed ${apps.length} apps from upload`,
		);

		// Batch insert directly
		const batches = this.splitIntoBatches(apps);
		let totalInserted = 0;
		let totalUpdated = 0;
		const syncErrors: string[] = [];

		for (const batch of batches) {
			try {
				const result = await bulkSyncCatalogAppsFromStore(db, batch);
				totalInserted += result.inserted;
				totalUpdated += result.updated;
				syncErrors.push(...result.errors);
			} catch (error) {
				syncErrors.push(`Batch sync failed: ${error}`);
			}
		}

		return {
			source,
			appsCount: apps.length,
			inserted: totalInserted,
			updated: totalUpdated,
			failed: transformErrors.length + syncErrors.length,
			errors: [...transformErrors, ...syncErrors].slice(0, 10),
			sourceAppIds: apps.map((a) => a.sourceAppId),
		};
	}

	/**
	 * Transform a single ChatGPT connector to common format
	 * Note: rawData is omitted to avoid D1 SQLITE_TOOBIG errors
	 */
	private transformConnector(connector: RawConnector): SyncCatalogAppInput {
		const labels = connector.labels || {};

		return {
			source: "chatgpt" as Source,
			sourceAppId: connector.id,
			sourceCreatedAt: connector.created_at ?? null,
			name: connector.name,
			description: connector.description,
			modelDescription: connector.model_description,
			baseUrl: connector.base_url,
			connectorType: mapConnectorType(connector.connector_type),
			distributionChannel: mapDistributionChannel(
				connector.distribution_channel,
			),
			developerType: mapDeveloperType(connector.developer_type),
			status: mapAppStatus(connector.status),
			category: mapCategory(connector.branding?.category || null),
			developer:
				connector.branding?.developer ||
				connector.app_metadata?.developer ||
				null,
			website: connector.branding?.website,
			privacyPolicy: connector.branding?.privacy_policy,
			termsOfService: connector.branding?.terms_of_service,
			logoUrl: connector.logo_url,
			logoUrlDark: connector.logo_url_dark,
			service: connector.service,
			version: connector.app_metadata?.version || null,
			versionId: connector.app_metadata?.version_id || null,
			versionNotes: connector.app_metadata?.version_notes || null,
			seoDescription: connector.app_metadata?.seo_description || null,
			screenshots: connector.app_metadata?.screenshots || null,
			categories: connector.app_metadata?.categories || null,
			subCategories: connector.app_metadata?.sub_categories || null,
			hasWrites: labels.writes === "true" || labels.consequential === "true",
			hasInteractive: labels.interactive === "true",
			hasFileSearch:
				labels.file_search === "true" || labels.retrievable === "true",
			hasDeepResearch: labels.deep_research === "true",
			hasSync: labels.sync === "true",
			authTypes: mapAuthTypes(connector.supported_auth),
			authRequired:
				(connector.supported_auth?.length ?? 0) > 0 &&
				!connector.supported_auth?.some((a) => a.type === "NONE"),
			reviewStatus: mapReviewStatus(
				connector.app_metadata?.review?.status || null,
			),
			supportsFullActions: connector.supports_full_actions,
			scores: {
				implementsRetrievable:
					connector.conformance?.implements_retrievable ?? null,
				retrievableReason:
					connector.conformance?.reason_if_not_retrievable ?? null,
			},
			safetyStatus: connector.policy_info?.safety_status ?? null,
			isDiscoverable: connector.branding?.is_discoverable_app ?? true,
			keywordsForDiscovery: connector.keywords_for_discovery ?? null,
			keywordsForTriggering: connector.keywords_for_triggering ?? null,
			systemHints: {
				tierLevel: connector.tier_level ?? null,
			},
			// Generate ChatGPT store URL: https://chatgpt.com/apps/{slug}/{connectorId}
			storeUrl: connector.id
				? `https://chatgpt.com/apps/${encodeURIComponent(
						(connector.name || "app")
							.toLowerCase()
							.replace(/[^a-z0-9]+/g, "-")
							.replace(/^-|-$/g, ""),
					)}/${connector.id}`
				: null,
			// Omit rawData to avoid D1 size limits
			rawData: null,
		};
	}

	/**
	 * Pre-populate MCP tools from Claude Registry toolNames
	 */
	private async prePopulateToolsFromClaudeRegistry(
		servers: RawClaudeServerEntry[],
	): Promise<{ toolsSynced: number; errors: string[] }> {
		const db = createDbClient(this.env.DB);
		let toolsSynced = 0;
		const errors: string[] = [];

		for (const entry of servers) {
			const registry = entry._meta?.["com.anthropic.api/mcp-registry"];
			if (!registry?.toolNames || registry.toolNames.length === 0) continue;

			const sourceAppId =
				registry.uuid || entry.server?.name || registry.url || "unknown";

			try {
				const listing = await getCatalogStoreListingBySourceId(
					db,
					"claude",
					sourceAppId,
				);

				if (!listing) continue;

				const tools = registry.toolNames.map((name) => ({
					name,
					description: undefined,
				}));

				const result = await syncCatalogMcpTools(
					db,
					listing.catalogAppId,
					tools,
					{ mode: "partial" },
				);
				toolsSynced += result.added + result.updated;
			} catch (error) {
				const name = registry.displayName || entry.server?.name || "unknown";
				errors.push(`Claude tools pre-pop failed for ${name}: ${error}`);
			}
		}

		return { toolsSynced, errors };
	}

	// ==========================================================================
	// Batch Processing
	// ==========================================================================

	/**
	 * Split apps into batches for D1 compatibility
	 */
	private splitIntoBatches(
		apps: SyncCatalogAppInput[],
		batchSize = this.BATCH_SIZE,
	): SyncCatalogAppInput[][] {
		const batches: SyncCatalogAppInput[][] = [];
		for (let i = 0; i < apps.length; i += batchSize) {
			batches.push(apps.slice(i, i + batchSize));
		}
		return batches;
	}
}
