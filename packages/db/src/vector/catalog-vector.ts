/**
 * Cloudflare AI Search — Catalog Search
 *
 * Semantic search over the App Catalog. Each catalog app is uploaded as a
 * text document to a Cloudflare AI Search instance with compact metadata
 * for lookup and coarse filtering.
 *
 * AI Search handles embedding, chunking, and hybrid retrieval (vector + keyword)
 * automatically — zero external dependencies, zero-hop from Workers.
 *
 * Flow:
 * 1. Sync catalog apps → D1 (structured data)
 * 2. Upload to AI Search → { filename, content (searchable text), metadata }
 * 3. Query → AI Search hybrid search → Get app IDs + scores
 * 4. Fetch full app details from D1 by ID
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal AI Search instance interface.
 *
 * This module lives in @tedix/db (shared package) so it must NOT import
 * Cloudflare-specific types. Consumers pass the AI Search instance binding
 * directly — it satisfies this interface by duck-typing.
 *
 * Matches the `AiSearchInstance` class from the Workers runtime.
 */
export interface CatalogAiSearchInstance {
	search(params: CatalogAiSearchRequest): Promise<CatalogAiSearchResponse>;
	info(): Promise<{
		custom_metadata?: Array<{ field_name?: string; data_type?: string }>;
	}>;
	update(config: {
		custom_metadata?: Array<{ field_name: string; data_type: "text" }>;
	}): Promise<unknown>;
	items: {
		upload(
			name: string,
			content: string,
			options?: { metadata?: Record<string, string> },
		): Promise<{ id: string; key: string; status: string }>;
		uploadAndPoll(
			name: string,
			content: string,
			options?: {
				metadata?: Record<string, string>;
				pollIntervalMs?: number;
				timeoutMs?: number;
			},
		): Promise<{ id: string; key: string; status: string }>;
		delete(itemId: string): Promise<void>;
		list(params?: {
			page?: number;
			per_page?: number;
			search?: string;
		}): Promise<{
			result: Array<{ id: string; key: string; status: string }>;
			result_info?: { total_count: number };
		}>;
	};
}

/** Search request — accepts either query string or messages array */
type CatalogAiSearchRequest =
	| {
			query: string;
			messages?: never;
			ai_search_options?: CatalogAiSearchOptionsInput;
	  }
	| {
			query?: never;
			messages: Array<{ role: string; content: string | null }>;
			ai_search_options?: CatalogAiSearchOptionsInput;
	  };

/** Subset of AI Search options used by catalog search */
interface CatalogAiSearchOptionsInput {
	retrieval?: {
		max_num_results?: number;
		filters?: Record<string, unknown>;
		retrieval_type?: "vector" | "keyword" | "hybrid";
		[key: string]: unknown;
	};
	reranking?: { enabled?: boolean; [key: string]: unknown };
	[key: string]: unknown;
}

/** Search response shape from AI Search */
interface CatalogAiSearchResponse {
	search_query: string;
	chunks: Array<{
		id: string;
		type: string;
		score: number;
		text: string;
		item: {
			timestamp?: number;
			key: string;
			metadata?: Record<string, unknown>;
		};
	}>;
}

/** Metadata stored with each document in AI Search */
export type CatalogVectorMetadata = Record<string, string> & {
	id: string;
	slug: string;
	name: string;
	source: string;
	connectorType: string;
};

/** Result from a catalog semantic search */
export interface CatalogSearchResult {
	id: string;
	score: number;
	metadata: CatalogVectorMetadata;
}

/** Options for catalog search */
export interface CatalogSearchOptions {
	/** Accepted for compatibility; not pushed into AI Search metadata filters */
	health?: string;
	/** Accepted for compatibility; not pushed into AI Search metadata filters */
	minToolCount?: number;
	/** Filter by source (e.g., "chatgpt", "claude") */
	source?: string;
	/** Filter by connector type */
	connectorType?: string;
	/** Accepted for compatibility; not pushed into AI Search metadata filters */
	category?: string;
	/** Maximum results to return */
	topK?: number;
}

/** Input for upserting a catalog app to the search index */
export interface CatalogAppVectorInput {
	id: string;
	slug?: string | null;
	name: string;
	description?: string | null;
	modelDescription?: string | null;
	developer?: string | null;
	category?: string | null;
	categories?: string[] | null;
	keywordsForDiscovery?: string[] | null;
	keywordsForTriggering?: string[] | null;
	seoDescription?: string | null;
	healthStatus?: string | null;
	mcpToolCount?: number | null;
	mcpEndpointNormalized?: string | null;
	source?: string | null;
	connectorType: string;
	hasWrites?: boolean | null;
	hasInteractive?: boolean | null;
}

// ============================================================================
// Constants
// ============================================================================

const CATALOG_METADATA_FIELDS = [
	"id",
	"slug",
	"name",
	"source",
	"connectorType",
] as const;

// ============================================================================
// Client
// ============================================================================

/**
 * AI Search namespace interface for creating/getting instances.
 * Matches `AiSearchNamespace` from the Workers runtime.
 */
export interface CatalogAiSearchNamespace {
	get(name: string): CatalogAiSearchInstance;
	create(config: {
		id: string;
		custom_metadata?: Array<{ field_name: string; data_type: "text" }>;
		[key: string]: unknown;
	}): Promise<CatalogAiSearchInstance>;
}

/** Instance name within the AI Search namespace */
const AI_SEARCH_INSTANCE_NAME = "catalog";

/**
 * Get the AI Search instance for catalog search.
 * Returns null if the AI_SEARCH binding is not configured (graceful degradation).
 */
export function createCatalogVectorClient(env: {
	AI_SEARCH?: CatalogAiSearchNamespace;
}): CatalogAiSearchInstance | null {
	if (!env.AI_SEARCH) {
		console.warn("[Catalog Vector] Not configured — missing AI_SEARCH binding");
		return null;
	}
	return env.AI_SEARCH.get(AI_SEARCH_INSTANCE_NAME);
}

export async function getOrCreateCatalogVectorClient(env: {
	AI_SEARCH?: CatalogAiSearchNamespace;
}): Promise<CatalogAiSearchInstance | null> {
	if (!env.AI_SEARCH) {
		console.warn("[Catalog Vector] Not configured — missing AI_SEARCH binding");
		return null;
	}

	const client = env.AI_SEARCH.get(AI_SEARCH_INSTANCE_NAME);
	try {
		await client.info();
		return client;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("ai_search_not_found")) {
			throw error;
		}
		console.log(
			`[Catalog Vector] Creating AI Search instance ${AI_SEARCH_INSTANCE_NAME}`,
		);
		return env.AI_SEARCH.create({
			id: AI_SEARCH_INSTANCE_NAME,
			index_method: { vector: true, keyword: true },
			custom_metadata: CATALOG_METADATA_FIELDS.map((fieldName) => ({
				field_name: fieldName,
				data_type: "text",
			})),
		});
	}
}

// ============================================================================
// Searchable Text
// ============================================================================

/**
 * Build searchable text from a catalog app for indexing.
 * Concatenates key fields that users would search for.
 */
function buildSearchableText(app: CatalogAppVectorInput): string {
	const parts: string[] = [];

	if (app.name) parts.push(app.name);
	if (app.description) parts.push(app.description);
	if (app.modelDescription) parts.push(app.modelDescription);
	if (app.developer) parts.push(app.developer);

	if (app.categories && app.categories.length > 0) {
		parts.push(app.categories.join(" "));
	}
	if (app.category) {
		parts.push(app.category);
	}

	if (app.keywordsForDiscovery && app.keywordsForDiscovery.length > 0) {
		parts.push(app.keywordsForDiscovery.join(" "));
	}
	if (app.keywordsForTriggering && app.keywordsForTriggering.length > 0) {
		parts.push(app.keywordsForTriggering.join(" "));
	}

	if (app.seoDescription) parts.push(app.seoDescription);

	return parts.join(" ").substring(0, 4000); // Limit to 4000 chars
}

/**
 * Build metadata object for a catalog app.
 */
function buildMetadata(app: CatalogAppVectorInput): CatalogVectorMetadata {
	return {
		id: app.id,
		slug: app.slug ?? "",
		name: app.name,
		source: app.source ?? "",
		connectorType: app.connectorType,
	};
}

async function ensureCatalogMetadataSchema(
	client: CatalogAiSearchInstance,
): Promise<void> {
	const info = await client.info();
	const existing = new Set(
		(info.custom_metadata ?? [])
			.map((field) => field.field_name)
			.filter((field): field is string => typeof field === "string"),
	);

	if (CATALOG_METADATA_FIELDS.every((field) => existing.has(field))) {
		return;
	}

	await client.update({
		custom_metadata: CATALOG_METADATA_FIELDS.map((fieldName) => ({
			field_name: fieldName,
			data_type: "text",
		})),
	});
}

// ============================================================================
// Upsert Operations
// ============================================================================

/**
 * Upsert a single catalog app into the AI Search index.
 * Uploads the app as a text document with structured metadata.
 * Uses fire-and-forget upload (no polling) for speed.
 */
export async function upsertCatalogApp(
	client: CatalogAiSearchInstance,
	app: CatalogAppVectorInput,
): Promise<string> {
	const itemKey = `catalog:${app.id}`;
	const searchableText = buildSearchableText(app);
	const metadata = buildMetadata(app);

	await ensureCatalogMetadataSchema(client);
	await client.items.upload(`${itemKey}.txt`, searchableText, { metadata });

	return itemKey;
}

/** Upload with bounded pacing; retry only provider throttling, using stable item keys. */
export async function bulkUpsertCatalogApps(
	client: CatalogAiSearchInstance,
	apps: CatalogAppVectorInput[],
): Promise<{ upserted: number; failed: number }> {
	if (apps.length === 0) return { upserted: 0, failed: 0 };
	await ensureCatalogMetadataSchema(client);
	let upserted = 0;
	let failed = 0;
	for (const app of apps) {
		// Avoid bursts across both pages and callers. Provider limits are shared;
		// pacing alone cannot prevent throttling from other account activity.
		await new Promise((resolve) => setTimeout(resolve, 250));
		for (let attempt = 0; ; attempt++) {
			try {
				await client.items.upload(
					`catalog:${app.id}.txt`,
					buildSearchableText(app),
					{
						metadata: buildMetadata(app),
					},
				);
				upserted++;
				break;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const status =
					typeof error === "object" && error !== null && "status" in error
						? error.status
						: undefined;
				const throttled =
					status === 429 || /rate.?limit|too many requests/i.test(message);
				if (attempt < 3 && throttled) {
					// Cloudflare's binding may expose only the message, without HTTP headers.
					await new Promise((resolve) =>
						setTimeout(resolve, 2000 * 2 ** attempt),
					);
					continue;
				}
				// Stop a throttled page instead of spending its whole deadline retrying every item.
				if (throttled) throw error;
				failed++;
				console.error("[Catalog Vector] Upload failed", {
					id: app.id,
					error: message,
				});
				break;
			}
		}
	}
	return { upserted, failed };
}

// ============================================================================
// Search Operations
// ============================================================================

/**
 * Semantic search across catalog apps.
 * Uses AI Search hybrid retrieval (vector + keyword) with reranking.
 */
export async function searchCatalogApps(
	client: CatalogAiSearchInstance,
	query: string,
	options: CatalogSearchOptions = {},
): Promise<CatalogSearchResult[]> {
	const topK = options.topK ?? 20;
	const filters = buildCatalogFilter(options);

	console.log(
		`[Catalog Vector] Searching "${query.substring(0, 80)}" topK=${topK}${filters ? `, filters: ${JSON.stringify(filters)}` : ""}`,
	);

	const result = await client.search({
		query,
		ai_search_options: {
			retrieval: {
				max_num_results: topK,
				retrieval_type: "hybrid",
				...(filters ? { filters } : {}),
			},
			reranking: { enabled: true },
		},
	});

	console.log(`[Catalog Vector] Found ${result.chunks.length} matches`);

	return result.chunks
		.filter((chunk) => chunk.item?.metadata)
		.map((chunk) => {
			const meta = chunk.item.metadata as unknown as CatalogVectorMetadata;
			return {
				id: meta.id,
				score: chunk.score,
				metadata: meta,
			};
		});
}

// ============================================================================
// Delete Operations
// ============================================================================

/**
 * Remove a catalog app from the AI Search index.
 * Looks up the item by key name and deletes it.
 */
export async function deleteCatalogApp(
	client: CatalogAiSearchInstance,
	id: string,
): Promise<void> {
	const itemKey = `catalog:${id}`;
	// List items matching this key to find the item ID
	const items = await client.items.list({
		search: `${itemKey}.txt`,
		per_page: 1,
	});
	const first = items.result[0];
	if (first) {
		await client.items.delete(first.id);
	}
}

/**
 * Batch remove catalog apps from the AI Search index.
 */
export async function batchDeleteCatalogApps(
	client: CatalogAiSearchInstance,
	ids: string[],
): Promise<void> {
	if (ids.length === 0) return;

	// Delete in parallel, best-effort
	await Promise.allSettled(ids.map((id) => deleteCatalogApp(client, id)));
}

// ============================================================================
// Filter Builder
// ============================================================================

/**
 * Build AI Search metadata filters. AI Search custom metadata is capped and
 * string-only, so unsupported filters are intentionally ignored here.
 *
 * @example
 * buildCatalogFilter({ source: "chatgpt", connectorType: "MCP" })
 * // Returns: { source: "chatgpt", connectorType: "MCP" }
 */
function buildCatalogFilter(
	options: CatalogSearchOptions,
): Record<string, unknown> | undefined {
	const filter: Record<string, unknown> = {};

	if (options.source) {
		filter.source = options.source;
	}
	if (options.connectorType) {
		filter.connectorType = options.connectorType;
	}

	return Object.keys(filter).length > 0 ? filter : undefined;
}
