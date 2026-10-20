import { guardedFetch } from "@tedix/ssrf-guard";

/**
 * SSRF-guarded fetch for the stateless MCP POST paths. `config.url` is
 * D1/plugin-supplied and these requests carry auth headers, so the guard
 * validates the target and every redirect hop (stripping credentials on
 * cross-origin hops). Managed Tedix gateway hosts ({slug}.mcp.tedix.dev and
 * friends) are legitimate configured targets for this client, so only those
 * exact host shapes bypass the Tedix-internal hostname denylist; a D1/plugin
 * row cannot use this path to reach `api.tedix.dev` or another platform host.
 * Private/loopback/link-local IP literals stay blocked unconditionally. http
 * is allowed only for the local-dev `*.localhost` lane — this package is
 * runtime-neutral and has no environment signal to key on.
 */
const MANAGED_MCP_HOST_RE = /^[^.]+\.(?:mcp|tedi)\.(?:tedix\.dev|tedix\.tech)$/;

const LOCAL_MANAGED_MCP_HOST_RE = /^[^.]+\.(?:mcp|tedi)\.localhost$/;

const SINGLE_LABEL_DEV_MCP_HOST_RE = /^[^.]+\.tedix\.tech$/;

const RESERVED_PLATFORM_HOST_LABELS = new Set([
	"api",
	"app",
	"cms",
	"docs-admin",
	"email",
	"gateway",
	"landing",
	"mcp",
	"os",
	"skill-runtime",
	"studio",
	"tedi",
	"widget",
]);

export function isManagedMcpHostname(hostname: string): boolean {
	if (
		MANAGED_MCP_HOST_RE.test(hostname) ||
		LOCAL_MANAGED_MCP_HOST_RE.test(hostname)
	) {
		return true;
	}
	if (!SINGLE_LABEL_DEV_MCP_HOST_RE.test(hostname)) return false;
	return !RESERVED_PLATFORM_HOST_LABELS.has(
		hostname.slice(0, hostname.indexOf(".")),
	);
}

export function guardedMcpFetch(
	url: string,
	init: RequestInit,
): Promise<Response> {
	let allowHttp = false;
	let allowInternalHosts = false;
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		allowHttp = LOCAL_MANAGED_MCP_HOST_RE.test(hostname);
		allowInternalHosts = isManagedMcpHostname(hostname);
	} catch {
		/* guardedFetch reports the invalid URL */
	}
	return guardedFetch(url, init, { allowHttp, allowInternalHosts });
}
