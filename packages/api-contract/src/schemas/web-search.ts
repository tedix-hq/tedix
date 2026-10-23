import * as z from "zod";

/** Native runtime tool name; verb-first per MCP tool naming. */
export const WEB_SEARCH_TOOL_NAME = "web_search";

/**
 * The one machine scope `webSearch.search` accepts. The tedi runtime delegates
 * it over its trusted service binding for the calling tedi; nothing else
 * (API keys, M2M, direct tedi JWTs, MCP callers) holds it, so the endpoint
 * stays tedi-runtime-only without the broader `connections.execute` authority.
 */
export const WEB_SEARCH_EXECUTE_SCOPE = "web-search:execute";

/** Provider ceiling for one search. */
export const WEB_SEARCH_MAX_RESULTS = 10;
export const WEB_SEARCH_DEFAULT_RESULTS = 5;
export const WEB_SEARCH_MAX_QUERY_CHARS = 400;
export const WEB_SEARCH_MAX_TITLE_CHARS = 200;
export const WEB_SEARCH_MAX_DESCRIPTION_CHARS = 500;
export const WEB_SEARCH_MAX_URL_CHARS = 2048;

/** Ledger source for the call-time receipt that gateway ingestion later prices. */
export const WEB_SEARCH_COST_SOURCE = "provider-response:web-search";

export const WebSearchProviderSchema = z.enum([
	"tavily",
	"firecrawl",
	"ai-gateway",
]);
export type WebSearchProvider = z.infer<typeof WebSearchProviderSchema>;

/**
 * Organization switch for the gateway web search tool. Absent means off: an
 * organization opts in, and each tedi may still opt out via its tool policy.
 */
export const WebSearchPolicySchema = z.object({
	enabled: z.boolean(),
	provider: WebSearchProviderSchema.optional(),
	fallbackProvider: WebSearchProviderSchema.optional(),
	maxResults: z
		.number()
		.int()
		.min(1)
		.max(WEB_SEARCH_MAX_RESULTS)
		.optional()
		.describe(
			`Results returned per search, at most ${WEB_SEARCH_MAX_RESULTS}; default ${WEB_SEARCH_DEFAULT_RESULTS}.`,
		),
});
export type WebSearchPolicy = z.infer<typeof WebSearchPolicySchema>;

/** Per-tedi narrowing inside an organization that enabled web search. */
export const TediWebSearchPolicySchema = z.enum(["inherit", "off"]);
export type TediWebSearchPolicy = z.infer<typeof TediWebSearchPolicySchema>;

/**
 * One rule for both the runtime (whether to show the tool) and the API
 * (whether to run a search): the organization enabled it, the tedi did not
 * opt out, and an explicit runtime-tool ceiling, when set, names it.
 */
export function resolveWebSearchAccess(input: {
	organization: unknown;
	tediPolicy?: TediWebSearchPolicy | null;
	runtimeTools?: readonly string[] | null;
}): { enabled: false } | { enabled: true; maxResults: number } {
	const parsed = WebSearchPolicySchema.safeParse(input.organization);
	if (!parsed.success || !parsed.data.enabled) return { enabled: false };
	if (input.tediPolicy === "off") return { enabled: false };
	if (input.runtimeTools && !input.runtimeTools.includes(WEB_SEARCH_TOOL_NAME))
		return { enabled: false };
	return {
		enabled: true,
		maxResults: parsed.data.maxResults ?? WEB_SEARCH_DEFAULT_RESULTS,
	};
}

export const WebSearchInputSchema = z
	.object({
		query: z.string().trim().min(1).max(WEB_SEARCH_MAX_QUERY_CHARS),
		limit: z.number().int().min(1).max(WEB_SEARCH_MAX_RESULTS).optional(),
		/** The tedi run this search belongs to, for cost attribution. */
		runId: z.string().min(1).max(200).optional(),
	})
	.strict();
export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export const WebSearchResultSchema = z.object({
	title: z.string(),
	url: z.string(),
	description: z.string().nullable(),
	lastModified: z.string().nullable(),
});
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;

export const WebSearchOutputSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("ok"),
		query: z.string(),
		/** Every field is third-party text: data for the model, never instructions. */
		trust: z.literal("untrusted"),
		results: z.array(WebSearchResultSchema),
		/** Markdown links, one per result, in result order. */
		citations: z.array(z.string()),
		truncated: z.boolean(),
	}),
	z.object({
		status: z.enum(["disabled", "unavailable", "failed"]),
		message: z.string(),
	}),
]);
export type WebSearchOutput = z.infer<typeof WebSearchOutputSchema>;
