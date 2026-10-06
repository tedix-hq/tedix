/**
 * Tedi Enrichment Bridge
 *
 * Invokes a tedi (via TEDI_SERVICE binding) to enrich tool responses
 * with contextual intelligence and dynamic UI generation.
 *
 * Only activates when app has tediPolicy.enabled = true in mcpConfig.
 */

import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import { LAYOUT_CATALOG_PROMPT } from "@tedix/api-contract/generated/layout-catalog-prompt";
import { createMcpLogger } from "../log";

const log = createMcpLogger("mcp.tedi_enrichment");

interface TediEnrichmentRequest {
	tediId: string;
	appId: string;
	action: "enrich-tool-call";
	traceId?: string;
	payload: {
		toolId: string;
		toolTitle: string;
		args: Record<string, unknown>;
		rawResult: unknown;
		catalogPrompt: string;
		appContext: {
			appSlug: string;
			vertical?: string;
		};
		callerIdentity?: {
			authType: "oauth" | "anonymous";
			userId?: string;
			scopes?: string[];
		};
		tediPolicy: {
			allowedTools: string[];
			blockedTools: string[];
			maxTokens: number;
			timeoutMs: number;
		};
	};
}

interface TediEnrichmentResponse {
	enrichedData?: unknown;
	layoutSpec?: {
		root: string;
		elements: Record<string, unknown>;
		state?: Record<string, unknown>;
	};
	textContent?: string;
	muscleMemoryUpdate?: { pattern: string; observation: string };
	error?: string;
}

export type { TediEnrichmentRequest, TediEnrichmentResponse };

export async function invokeTediEnrichment(
	env: CloudflareEnv,
	request: TediEnrichmentRequest,
): Promise<TediEnrichmentResponse | null> {
	if (!env.API_SERVICE) {
		console.warn("[TediEnrichment] API_SERVICE binding not available");
		return null;
	}

	try {
		const headers: Record<string, string> = {
			"X-Service-Binding": "true",
		};
		if (request.traceId) {
			headers["X-Trace-Id"] = request.traceId;
		}

		return await callRpc<TediEnrichmentResponse>(
			"tediInvoke/enrich",
			{
				tediId: request.tediId,
				appId: request.appId,
				payload: request.payload,
			},
			{
				apiUrl: "https://api",
				fetch: serviceBindingFetch(env.API_SERVICE),
				headers,
			},
		);
	} catch (error) {
		log.error("Tedi enrichment failed", {
			event: "tedi_enrichment.invoke_failed",
			appId: request.appId,
			tediId: request.tediId,
			traceId: request.traceId,
			outcome: "unavailable",
			error,
		});
		return null;
	}
}

/**
 * Build a TediEnrichmentRequest from tool execution context
 */
export function buildEnrichmentRequest(params: {
	tediId: string;
	appId: string;
	toolId: string;
	toolTitle: string;
	args: Record<string, unknown>;
	rawResult: unknown;
	appSlug: string;
	vertical?: string;
	/** Skip layout catalog prompt for text-only enrichment (e.g., content_answer) */
	skipCatalogPrompt?: boolean;
	traceId?: string;
	callerIdentity?: {
		authType: "oauth" | "anonymous";
		userId?: string;
		scopes?: string[];
	};
	policy: {
		allowedEnrichmentTools: string[];
		blockedEnrichmentTools: string[];
		maxEnrichmentTokens: number;
		enrichmentTimeoutMs: number;
	};
}): TediEnrichmentRequest {
	return {
		tediId: params.tediId,
		appId: params.appId,
		action: "enrich-tool-call",
		traceId: params.traceId,
		payload: {
			toolId: params.toolId,
			toolTitle: params.toolTitle,
			args: params.args,
			rawResult: params.rawResult,
			catalogPrompt: params.skipCatalogPrompt ? "" : LAYOUT_CATALOG_PROMPT,
			appContext: {
				appSlug: params.appSlug,
				vertical: params.vertical,
			},
			callerIdentity: params.callerIdentity,
			tediPolicy: {
				allowedTools: params.policy.allowedEnrichmentTools,
				blockedTools: params.policy.blockedEnrichmentTools,
				maxTokens: params.policy.maxEnrichmentTokens,
				timeoutMs: params.policy.enrichmentTimeoutMs,
			},
		},
	};
}
