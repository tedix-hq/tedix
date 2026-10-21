/**
 * Public web search through the deployment's model gateway.
 *
 * The search runs on the `AI` binding with the same gateway as model calls, so
 * the provider charge lands in that gateway's log beside model spend. The
 * Gateway log cannot carry Tedix attribution for a search, so this records a
 * call-time receipt in `tedi_call_costs` keyed by the Gateway log id; cost
 * ingestion later finds that id taken and fills in the reported charge
 * (`settleGatewayReportedReceiptCosts`).
 */
import {
	WEB_SEARCH_COST_SOURCE,
	WEB_SEARCH_MAX_DESCRIPTION_CHARS,
	WEB_SEARCH_MAX_RESULTS,
	WEB_SEARCH_MAX_TITLE_CHARS,
	WEB_SEARCH_MAX_URL_CHARS,
	type WebSearchOutput,
	type WebSearchResult,
} from "@tedix/api-contract/schemas/web-search";
import type { NewTediCallCost } from "@tedix/db/schema/tedis";

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

/** The receipt that attributes one search's Gateway charge. */
export function buildWebSearchReceipt(input: {
	organizationId: string;
	tediId: string | null;
	runId: string | null;
	gatewayId: string;
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
		// unpriced and ingestion's own row (also unpriced) keeps the evidence.
		gatewayLogId: input.gatewayLogId ?? `web-search:${crypto.randomUUID()}`,
		gatewayId: input.gatewayId,
		snapshotAt: input.occurredAt,
		model: WEB_SEARCH_LEDGER_MODEL,
		provider: "ai-gateway",
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
		costReason: input.gatewayLogId
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

export async function runGatewayWebSearch(input: {
	env: WebSearchEnv;
	query: string;
	limit: number;
	organizationId: string;
	tediId: string | null;
	runId: string | null;
	recordReceipt: (row: NewTediCallCost) => Promise<void>;
	now?: () => Date;
}): Promise<WebSearchOutput> {
	const gateway = resolveWebSearchGateway(input.env);
	if (!gateway)
		return {
			status: "unavailable",
			message: "Web search is not available on this deployment.",
		};
	const occurredAt = (input.now?.() ?? new Date()).toISOString();
	const started = performance.now();
	let response: Response | null = null;
	let failure: string | null = null;
	try {
		response = await gateway.binding.websearch({
			gatewayId: gateway.gatewayId,
			query: input.query,
			limit: Math.min(input.limit, WEB_SEARCH_MAX_RESULTS),
		});
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	const callDurationMs = performance.now() - started;
	const gatewayLogId =
		response?.headers.get("cf-aig-log-id") ??
		gateway.binding.aiGatewayLogId ??
		null;
	let payload: unknown = null;
	if (response?.ok) {
		try {
			payload = await response.json();
		} catch {
			failure = "Web search returned an unreadable response.";
		}
	} else if (response) {
		failure = `Web search failed with status ${response.status}.`;
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
					gatewayId: gateway.gatewayId,
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
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (failure !== null) {
		console.warn("[web-search] search failed", {
			organizationId: input.organizationId,
			failure,
		});
		return { status: "failed", message: "Web search failed. Try again later." };
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
