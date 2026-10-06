import { contentSearchInstanceId } from "./content-index";

export interface AiSearchEnv {
	CONTENT_AI_SEARCH?: AiSearchNamespace;
}

export interface ContentSearchSource {
	url: string;
	title: string;
	snippet: string;
	score: number;
	thumbnail?: string;
	category?: string;
	publishedAt?: string;
	author?: string;
}

export interface ContentSearchResult {
	success: boolean;
	sources: ContentSearchSource[];
	query: string;
	total: number;
	error?: string;
}

export interface AuthoritativeContentDocument {
	canonicalUrl: string;
	sourceRevision: string;
	visibility: "public" | "private" | "disabled";
	objectKey: string;
	digest: string;
	title: string;
	contentType: string;
}

function metadataText(
	metadata: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = metadata?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Search one app-owned AI Search instance and reconstruct exact citations. */
export async function searchContent(
	env: AiSearchEnv,
	query: string,
	options: {
		appId: string;
		limit?: number;
		resolveDocuments: (
			appId: string,
			objectKeys: string[],
		) => Promise<Map<string, AuthoritativeContentDocument>>;
	},
): Promise<ContentSearchResult> {
	if (!env.CONTENT_AI_SEARCH) {
		return {
			success: false,
			sources: [],
			query,
			total: 0,
			error: "Content AI Search binding not available",
		};
	}

	try {
		const result = await env.CONTENT_AI_SEARCH.get(
			contentSearchInstanceId(options.appId),
		).search({
			query,
			ai_search_options: {
				retrieval: {
					retrieval_type: "hybrid",
					max_num_results: options.limit ?? 8,
					match_threshold: 0.3,
				},
			},
		});

		const candidates = result.chunks.flatMap((chunk) => {
			const canonicalUrl = metadataText(chunk.item.metadata, "canonicalUrl");
			const objectKey = metadataText(chunk.item.metadata, "objectKey");
			const digest = metadataText(chunk.item.metadata, "digest");
			const sourceRevision = metadataText(
				chunk.item.metadata,
				"sourceRevision",
			);
			const visibility = metadataText(chunk.item.metadata, "visibility");
			if (
				!canonicalUrl ||
				!objectKey ||
				!digest ||
				!sourceRevision ||
				!visibility
			) {
				console.error(
					"[Content AI Search] Dropping chunk without citation metadata",
					{
						itemKey: chunk.item.key,
					},
				);
				return [];
			}
			return [
				{
					chunk,
					metadata: {
						canonicalUrl,
						sourceRevision,
						visibility,
						objectKey,
						digest,
					},
				},
			];
		});
		const documents = await options.resolveDocuments(options.appId, [
			...new Set(candidates.map(({ metadata }) => metadata.objectKey)),
		]);
		const sourcesByUrl = new Map<string, ContentSearchSource>();
		for (const { chunk, metadata } of candidates) {
			const document = documents.get(metadata.objectKey);
			if (
				!document ||
				document.canonicalUrl !== metadata.canonicalUrl ||
				document.sourceRevision !== metadata.sourceRevision ||
				document.visibility !== metadata.visibility ||
				document.digest !== metadata.digest
			) {
				console.error(
					"[Content AI Search] Dropping chunk that does not match D1",
					{ itemKey: chunk.item.key },
				);
				continue;
			}
			const snippet = chunk.text
				.replace(/^#.*\n/m, "")
				.trim()
				.slice(0, 300);
			const source = {
				url: document.canonicalUrl,
				title: document.title,
				snippet,
				score: chunk.score,
				category: document.contentType,
			};
			const previous = sourcesByUrl.get(document.canonicalUrl);
			if (!previous || source.score > previous.score) {
				sourcesByUrl.set(document.canonicalUrl, source);
			}
		}
		const sources = [...sourcesByUrl.values()];

		return {
			success: true,
			sources,
			query: result.search_query || query,
			total: sources.length,
		};
	} catch (error) {
		console.error("[Content AI Search] Search error:", error);
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes("ai_search_not_found")) {
			return { success: true, sources: [], query, total: 0 };
		}
		return {
			success: false,
			sources: [],
			query,
			total: 0,
			error: message,
		};
	}
}
