import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import { createMcpLogger } from "../log";

const log = createMcpLogger("mcp.auth.managed_credentials");

// Managed app MCP endpoints look like `reflexos.mcp.tedix.tech`.
// Managed tedi MCP endpoints look like `reflexos.tedi.tedix.tech`.
// Those are distinct concepts even when their first label is the same.
const MANAGED_MCP_HOST_RE = /^[^.]+\.(?:mcp|tedi)\.(?:tedix\.dev|tedix\.tech)$/;
const LOCAL_MANAGED_MCP_HOST_RE = /^[^.]+\.(?:mcp|tedi)\.localhost$/;
const TEDIX_TEDI_HOST_RE = /^[^.]+\.tedi\.(?:tedix\.dev|tedix\.tech)$/;
const LOCAL_TEDI_HOST_RE = /^[^.]+\.tedi\.localhost$/;
// Platform-hosted upstream MCP origins can also use single-label dev-zone
// hosts, e.g. `reflexos.tedix.tech`. They are trusted for SSRF purposes but
// must not be routed as Tedix tedi service-binding hosts.
const SINGLE_LABEL_DEV_ZONE_MCP_HOST_RE = /^[^.]+\.tedix\.tech$/;
const RESERVED_PLATFORM_HOST_LABELS = new Set([
	"api",
	"app",
	"cms",
	"email",
	"gateway",
	"landing",
	"mcp",
	"skill-runtime",
	"tedi",
	"widget",
]);

const ALLOWED_CREDENTIAL_HEADERS = new Set([
	"authorization",
	"x-tedix-org-id",
	"x-tedix-tedi-id",
]);

const CANONICAL_CREDENTIAL_HEADERS: Record<string, string> = {
	authorization: "Authorization",
	"x-tedix-org-id": "X-Tedix-Org-Id",
	"x-tedix-tedi-id": "X-Tedix-Tedi-Id",
};

export function isTedixManagedMcpUrl(serverUrl: string): boolean {
	try {
		const url = new URL(serverUrl);
		const hostname = url.hostname.toLowerCase();
		if (LOCAL_MANAGED_MCP_HOST_RE.test(hostname)) {
			return url.protocol === "http:" || url.protocol === "https:";
		}
		if (isSingleLabelPlatformMcpHost(hostname)) {
			return url.protocol === "https:";
		}
		return url.protocol === "https:" && MANAGED_MCP_HOST_RE.test(hostname);
	} catch {
		return false;
	}
}

export function getTedixManagedTediHost(serverUrl: string): string | null {
	try {
		const url = new URL(serverUrl);
		const hostname = url.hostname.toLowerCase();
		if (LOCAL_TEDI_HOST_RE.test(hostname)) {
			return url.protocol === "http:" || url.protocol === "https:"
				? hostname
				: null;
		}
		return url.protocol === "https:" && TEDIX_TEDI_HOST_RE.test(hostname)
			? hostname
			: null;
	} catch {
		return null;
	}
}

/** Hostname of a server URL, for logging. Never the path — it can carry tenant ids. */
function safeHost(serverUrl: string): string {
	try {
		return new URL(serverUrl).hostname.toLowerCase();
	} catch {
		return "invalid";
	}
}

function isSingleLabelPlatformMcpHost(hostname: string): boolean {
	if (!SINGLE_LABEL_DEV_ZONE_MCP_HOST_RE.test(hostname)) return false;
	const label = hostname.slice(0, hostname.indexOf("."));
	return !RESERVED_PLATFORM_HOST_LABELS.has(label);
}

async function resolveFallbackTediId(
	env: CloudflareEnv,
	orgId: string,
): Promise<string | null> {
	if (!env.API_SERVICE) return null;

	try {
		const data = await callRpc<{ data?: Array<{ id: string }> }>(
			"tedis/list",
			{ limit: 1 },
			{
				apiUrl: "https://api",
				fetch: serviceBindingFetch(env.API_SERVICE),
				headers: {
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": orgId,
				},
			},
		);
		return data.data?.[0]?.id ?? null;
	} catch (error) {
		log.warn("Fallback tedi lookup failed", {
			event: "managed_credentials.tedi_lookup_failed",
			organizationId: orgId,
			outcome: "unavailable",
			error,
		});
		return null;
	}
}

function normalizeCredentialHeaders(
	headers: Record<string, string> | undefined,
): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (typeof value !== "string" || value.length === 0) continue;
		const lower = key.toLowerCase();
		if (!ALLOWED_CREDENTIAL_HEADERS.has(lower)) continue;
		normalized[CANONICAL_CREDENTIAL_HEADERS[lower] ?? key] = value;
	}
	return normalized;
}

export async function resolveManagedMcpAuthHeaders(params: {
	serverUrl: string;
	env: CloudflareEnv;
	tediId?: string | null;
	orgId?: string | null;
}): Promise<Record<string, string>> {
	if (!isTedixManagedMcpUrl(params.serverUrl) || !params.env.API_SERVICE) {
		return {};
	}

	let tediId = params.tediId ?? null;
	if (!tediId && params.orgId) {
		tediId = await resolveFallbackTediId(params.env, params.orgId);
	}
	if (!tediId) return {};

	try {
		const data = await callRpc<{ headers?: Record<string, string> }>(
			"mcpCredentials/resolve",
			{ tediId, serverUrl: params.serverUrl },
			{
				apiUrl: "https://api",
				fetch: serviceBindingFetch(params.env.API_SERVICE),
				headers: {
					"X-Service-Binding": "true",
					...(params.orgId ? { "X-Tedix-Org-Id": params.orgId } : {}),
					"X-Tedix-Tedi-Id": tediId,
				},
			},
		);
		return normalizeCredentialHeaders(data.headers);
	} catch (error) {
		log.warn("Managed MCP credential resolve failed", {
			event: "managed_credentials.resolve_failed",
			// Host only: an MCP server URL's PATH can encode tenant identifiers.
			serverHost: safeHost(params.serverUrl),
			...(params.orgId ? { organizationId: params.orgId } : {}),
			tediId,
			outcome: "unavailable",
			error,
		});
		return {};
	}
}
