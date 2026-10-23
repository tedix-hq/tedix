/**
 * Public web search through organization-selected providers.
 *
 * Every provider response records an attributed cost receipt. Gateway receipts
 * are keyed by log id so ingestion can fill in the reported charge. Direct
 * provider receipts remain unpriced when the provider reports no dollar cost.
 */
import {
	WEB_SEARCH_COST_SOURCE,
	WEB_SEARCH_MAX_DESCRIPTION_CHARS,
	WEB_SEARCH_MAX_RESULTS,
	WEB_SEARCH_MAX_TITLE_CHARS,
	WEB_SEARCH_MAX_URL_CHARS,
	type WebSearchOutput,
	type WebSearchPolicy,
	type WebSearchProvider,
	type WebSearchResult,
} from "@tedix/api-contract/schemas/web-search";
import type { NewTediCallCost } from "@tedix/db/schema/tedis";
import { safeExceptionTopology } from "../lib/safe-log-metadata";

/** Search model name recorded in the cost ledger. */
export const WEB_SEARCH_LEDGER_MODEL = "web-search";

export interface WebSearchBinding {
	websearch?: (request: AiWebSearchRequest) => Promise<Response>;
	aiGatewayLogId?: string | null;
}

export interface WebSearchEnv {
	AI?: WebSearchBinding;
	AI_GATEWAY_LLM_ID?: string;
}

/** The gateway and binding, or null when this deployment cannot search. */
export function resolveWebSearchGateway(env: WebSearchEnv): {
	binding: Required<Pick<WebSearchBinding, "websearch">> & WebSearchBinding;
	gatewayId: string;
} | null {
	const gatewayId = env.AI_GATEWAY_LLM_ID?.trim();
	const binding = env.AI;
	if (!binding || typeof binding.websearch !== "function") return null;
	if (!gatewayId || gatewayId === "configured-via-private-overlay") return null;
	return {
		binding: binding as Required<Pick<WebSearchBinding, "websearch">> &
			WebSearchBinding,
		gatewayId,
	};
}

/** Collapse whitespace and control characters, then cap the length. */
function plainText(value: unknown, max: number): string | null {
	if (typeof value !== "string") return null;
	const text = value.replace(/[\p{Cc}\s]+/gu, " ").trim();
	if (!text) return null;
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function httpUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.length > WEB_SEARCH_MAX_URL_CHARS)
		return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		if (url.username || url.password) return null;
		return url.toString();
	} catch {
		return null;
	}
}

/** A markdown link whose label cannot break out of the brackets. */
/**
 * A numbered markdown link labelled by host. The provider-written title stays
 * in the untrusted result body, so a citation carries no third-party prose.
 */
export function citationLink(result: WebSearchResult, index: number): string {
	const host = new URL(result.url).hostname;
	const href = result.url.replace(/\(/g, "%28").replace(/\)/g, "%29");
	return `[${index + 1}. ${host}](${href})`;
}

/** Bounded, validated results from an untrusted provider payload. */
export function normalizeWebSearchItems(
	payload: unknown,
	limit: number,
): { results: WebSearchResult[]; truncated: boolean } {
	const items =
		payload && typeof payload === "object" && "items" in payload
			? (payload as { items: unknown }).items
			: null;
	if (!Array.isArray(items)) return { results: [], truncated: false };
	const cap = Math.min(limit, WEB_SEARCH_MAX_RESULTS);
	const results: WebSearchResult[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (results.length >= cap) break;
		if (!item || typeof item !== "object") continue;
		const raw = item as Record<string, unknown>;
		const url = httpUrl(raw.url);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		results.push({
			title: plainText(raw.title, WEB_SEARCH_MAX_TITLE_CHARS) ?? url,
			url,
			description: plainText(raw.description, WEB_SEARCH_MAX_DESCRIPTION_CHARS),
			lastModified: plainText(raw.lastModifiedDate, 40),
		});
	}
	return { results, truncated: items.length > results.length };
}

/** A provider-attributed receipt; only Gateway receipts can be priced by ingestion. */
export function buildWebSearchReceipt(input: {
	organizationId: string;
	tediId: string | null;
	runId: string | null;
	gatewayId: string | null;
	provider?: WebSearchProvider;
	gatewayLogId: string | null;
	occurredAt: string;
	success: boolean;
	callDurationMs: number;
}): NewTediCallCost {
	return {
		id: crypto.randomUUID(),
		orgId: input.organizationId,
		tediId: input.tediId,
		// Keyed by the Gateway log so ingestion settles this row instead of
		// adding an unattributed second one. Without a log id the receipt stays
		// unpriced; ingestion must not create a second search usage row.
		gatewayLogId: input.gatewayLogId ?? `web-search:${crypto.randomUUID()}`,
		gatewayId: input.gatewayId ?? `direct:${input.provider}`,
		snapshotAt: input.occurredAt,
		model: WEB_SEARCH_LEDGER_MODEL,
		provider: input.provider ?? "ai-gateway",
		runId: input.runId,
		sessionType: input.tediId ? "tedi" : "kernel",
		source: WEB_SEARCH_COST_SOURCE,
		usageKind: "other",
		usageUnit: "units",
		usageQuantity: 1,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		estimatedCostUsd: null,
		callDurationMs: input.callDurationMs,
		costBasis: "unknown",
		costReason:
			input.provider && input.provider !== "ai-gateway"
				? "provider_cost_not_reported"
				: input.gatewayLogId
					? "awaiting_gateway_cost"
					: "missing_gateway_log_id",
		sessionCount: 1,
		success: input.success,
		cached: false,
		dataQuality: input.success
			? "quarantined_no_pricing"
			: "quarantined_failed",
	};
}

/** Numeric gateway error codes only; the error text stays out of results and logs. */
async function gatewayErrorCodes(response: Response): Promise<number[]> {
	try {
		const body = (await response.json()) as { errors?: unknown } | null;
		if (!Array.isArray(body?.errors)) return [];
		return body.errors
			.map((error) => (error as { code?: unknown } | null)?.code)
			.filter((code): code is number => Number.isInteger(code))
			.slice(0, 3);
	} catch {
		return [];
	}
}

export async function runWebSearch(input: {
	env: WebSearchEnv;
	policy?: Pick<WebSearchPolicy, "provider" | "fallbackProvider">;
	resolveCredential?: (
		provider: "tavily" | "firecrawl",
	) => Promise<string | null>;
	fetch?: typeof fetch;
	query: string;
	limit: number;
	organizationId: string;
	tediId: string | null;
	runId: string | null;
	recordReceipt: (row: NewTediCallCost) => Promise<void>;
	now?: () => Date;
}): Promise<WebSearchOutput> {
	const provider = input.policy?.provider ?? "ai-gateway";
	const fallbackProvider = input.policy?.fallbackProvider;
	const fallback = () =>
		runWebSearch({
			...input,
			policy: { provider: fallbackProvider },
		});
	const canFallback = fallbackProvider && fallbackProvider !== provider;
	const gateway =
		provider === "ai-gateway" ? resolveWebSearchGateway(input.env) : null;
	let token: string | null = null;
	if (provider !== "ai-gateway") {
		try {
			token = (await input.resolveCredential?.(provider)) ?? null;
		} catch (error) {
			console.warn("[web-search] credential unavailable", {
				organizationId: input.organizationId,
				provider,
				exception: safeExceptionTopology(error),
			});
		}
	}
	if (provider === "ai-gateway" ? !gateway : !token)
		return canFallback
			? fallback()
			: {
					status: "unavailable",
					message: "Web search is not available on this deployment.",
				};
	const occurredAt = (input.now?.() ?? new Date()).toISOString();
	const started = performance.now();
	let response: Response | null = null;
	let failure: string | null = null;
	let thrownException: ReturnType<typeof safeExceptionTopology> | undefined;
	let errorCodes: number[] = [];
	try {
		const limit = Math.min(input.limit, WEB_SEARCH_MAX_RESULTS);
		response = gateway
			? await gateway.binding.websearch({
					gatewayId: gateway.gatewayId,
					query: input.query,
					limit,
				})
			: await (input.fetch ?? fetch)(
					provider === "tavily"
						? "https://api.tavily.com/search"
						: "https://api.firecrawl.dev/v2/search",
					{
						method: "POST",
						headers: {
							Authorization: `Bearer ${token}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(
							provider === "tavily"
								? {
										query: input.query,
										max_results: limit,
										search_depth: "basic",
										include_answer: false,
										include_raw_content: false,
									}
								: { query: input.query, limit, sources: ["web"] },
						),
						signal: AbortSignal.timeout(30_000),
						redirect: "manual",
					},
				);
	} catch (error) {
		thrownException = safeExceptionTopology(error);
		failure = "Web search request threw.";
	}
	const callDurationMs = performance.now() - started;
	const gatewayLogId = gateway
		? (response?.headers.get("cf-aig-log-id") ??
			gateway.binding.aiGatewayLogId ??
			null)
		: null;
	let payload: unknown = null;
	if (response?.ok) {
		try {
			payload = await response.json();
			if (provider !== "ai-gateway") {
				const body = payload as {
					results?: unknown;
					data?: { web?: unknown };
				} | null;
				const items = provider === "tavily" ? body?.results : body?.data?.web;
				if (!Array.isArray(items)) throw new Error("Invalid search results");
				payload = {
					items: items.map((item: Record<string, unknown> | null) => ({
						url: item?.url,
						title: item?.title,
						description:
							provider === "tavily" ? item?.content : item?.description,
						lastModifiedDate: item?.published_date,
					})),
				};
			}
		} catch {
			failure = "Web search returned an unreadable response.";
		}
	} else if (response) {
		failure = `Web search failed with status ${response.status}.`;
		errorCodes = await gatewayErrorCodes(response);
	}
	// Record every attempt that reached the gateway: a failed search can still
	// be a charged one, and the receipt is how that charge gets attributed.
	if (response || gatewayLogId) {
		try {
			await input.recordReceipt(
				buildWebSearchReceipt({
					organizationId: input.organizationId,
					tediId: input.tediId,
					runId: input.runId,
					gatewayId: gateway?.gatewayId ?? null,
					provider,
					gatewayLogId,
					occurredAt,
					success: failure === null,
					callDurationMs,
				}),
			);
		} catch (error) {
			console.error("[web-search] cost receipt not persisted", {
				organizationId: input.organizationId,
				tediId: input.tediId,
				gatewayLogId,
				exception: safeExceptionTopology(error),
			});
		}
	}
	if (failure !== null) {
		if (
			canFallback &&
			(response?.status === 402 || (response && response.status >= 500))
		) {
			return fallback();
		}
		console.warn("[web-search] search failed", {
			organizationId: input.organizationId,
			failure,
			...(errorCodes.length > 0 && { errorCodes }),
			...(thrownException && { exception: thrownException }),
		});
		// The status (never the provider body) tells the tedi and the run
		// evidence whether a retry can help.
		return {
			status: "failed",
			message: response
				? `Web search failed (HTTP ${response.status}${errorCodes.length ? `, code ${errorCodes.join(", ")}` : ""}). Try again later.`
				: "Web search failed. Try again later.",
		};
	}
	const { results, truncated } = normalizeWebSearchItems(payload, input.limit);
	return {
		status: "ok",
		query: input.query,
		trust: "untrusted",
		results,
		citations: results.map((result, index) => citationLink(result, index)),
		truncated,
	};
}
