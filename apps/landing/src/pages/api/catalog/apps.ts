/**
 * Catalog Apps API Proxy
 * Proxies client-side catalog requests through the server
 * so the API key stays server-side and we avoid CORS issues.
 */

import { env } from "cloudflare:workers";
import { normalizeCatalogCategory } from "@tedix/api-contract/utils/catalog-categories";
import type { APIRoute } from "astro";
import { getCatalogClient } from "../../../lib/api";

const SORT_BY_VALUES = new Set([
	"name",
	"sourceCreatedAt",
	"updatedAt",
	"lastSyncedAt",
	"relevance",
]);
const SORT_DIR_VALUES = new Set(["asc", "desc"]);
const CONNECTOR_TYPE_VALUES = new Set([
	"MCP",
	"SERVICE",
	"FIRST_PARTY_ECOSYSTEM",
	"NATIVE",
]);
const HEALTH_STATUS_VALUES = new Set([
	"healthy",
	"degraded",
	"unhealthy",
	"requires_auth",
	"blocked",
	"unsupported",
	"unknown",
]);
const SOURCE_VALUES = new Set([
	"chatgpt",
	"claude",
	"gemini",
	"copilot",
	"official",
	"tedix",
	"tedi",
	"community",
	"manual",
]);

function allowedParam<T extends string>(
	value: string | null,
	allowed: Set<string>,
): T | undefined {
	return value && allowed.has(value) ? (value as T) : undefined;
}

export const GET: APIRoute = async ({ url }) => {
	if (!env.API_SERVICE && !env.API_URL) {
		return new Response(JSON.stringify({ error: "API not configured" }), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		});
	}

	const client = getCatalogClient(env);
	const params = url.searchParams;

	try {
		const sortBy = allowedParam<
			"name" | "sourceCreatedAt" | "updatedAt" | "lastSyncedAt" | "relevance"
		>(params.get("sortBy"), SORT_BY_VALUES);
		const sortDir = allowedParam<"asc" | "desc">(
			params.get("sortDir"),
			SORT_DIR_VALUES,
		);
		const result = await client.catalog.list({
			search: params.get("search") || undefined,
			category: normalizeCatalogCategory(params.get("category")) || undefined,
			connectorType: allowedParam<
				"MCP" | "SERVICE" | "FIRST_PARTY_ECOSYSTEM" | "NATIVE"
			>(params.get("connectorType"), CONNECTOR_TYPE_VALUES),
			healthStatus: allowedParam<
				| "healthy"
				| "degraded"
				| "unhealthy"
				| "requires_auth"
				| "blocked"
				| "unsupported"
				| "unknown"
			>(params.get("healthStatus"), HEALTH_STATUS_VALUES),
			hasInteractive: params.get("hasInteractive") === "true" || undefined,
			hasWrites: params.get("hasWrites") === "true" || undefined,
			sortBy,
			sortDir,
			limit: params.get("limit") ? Number(params.get("limit")) : 24,
			offset: params.get("offset") ? Number(params.get("offset")) : 0,
			source: allowedParam<
				| "chatgpt"
				| "claude"
				| "gemini"
				| "copilot"
				| "official"
				| "tedix"
				| "tedi"
				| "community"
				| "manual"
			>(params.get("source"), SOURCE_VALUES),
		});

		return new Response(JSON.stringify(result), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "public, max-age=60",
			},
		});
	} catch (error) {
		console.error("[Catalog Proxy] Error:", error);
		return new Response(JSON.stringify({ error: "Failed to fetch apps" }), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		});
	}
};
