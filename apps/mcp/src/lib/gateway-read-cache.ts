import type { FetcherLike } from "@tedix/api-client/internal";

const GRANT_PATH = "/rpc/organizations/verifyMultiOrgMcpGrant";
const TTL_MS = 10_000;
/** One unavailable answer per key per window, so callers can't hammer a busy D1. */
const UNAVAILABLE_TTL_MS = 5_000;
const MAX_ENTRIES = 500;
const READ_PATHS = new Set([
	GRANT_PATH,
	"/rpc/mcpGovernance/resolveAgentTransportPolicy",
	// Whether the organization has any policy fence, read up to twice per MCP
	// call; the same ten seconds a transport policy change already waits.
	"/rpc/mcpGovernance/resolveTenantPolicyOrganizationPresence",
	"/rpc/externalAgentIdentity/resolveSessionAuth",
]);

type CachedResponse = {
	body: string;
	status: number;
	headers: [string, string][];
	ttlMs: number;
};
const bindings = new WeakMap<FetcherLike, FetcherLike>();

function grantOutcome(body: string): "allowed" | "unavailable" | "other" {
	try {
		const json = JSON.parse(body)?.json;
		if (json?.allowed === true) return "allowed";
		if (json?.reason === "provider_unavailable") return "unavailable";
	} catch {}
	return "other";
}

/** How long one answer may serve later callers; 0 keeps nothing. */
function retention(path: string, status: number, body: string): number {
	if (path !== GRANT_PATH) return status >= 200 && status < 300 ? TTL_MS : 0;
	if (status >= 500) return UNAVAILABLE_TTL_MS;
	if (status < 200 || status >= 300) return 0;
	const outcome = grantOutcome(body);
	// An allow must be checked again: removal takes effect on the next call.
	if (outcome === "allowed") return 0;
	return outcome === "unavailable" ? UNAVAILABLE_TTL_MS : 0;
}

/** Only gateway authority reads; writes and explicit fresh checks use the binding directly. */
export function gatewayReadBinding(binding: FetcherLike): FetcherLike {
	const existing = bindings.get(binding);
	if (existing) return existing;
	const entries = new Map<
		string,
		{ expiresAt: number; pending: Promise<CachedResponse> }
	>();
	const cached: FetcherLike = {
		async fetch(request) {
			const started = Date.now();
			const path = new URL(request.url).pathname;
			if (request.method !== "POST" || !READ_PATHS.has(path))
				return binding.fetch(request);
			// Include every authority header and input. Retain only the digest as the key.
			const digest = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(
					JSON.stringify([
						request.url,
						[...request.headers].sort(([a], [b]) => a.localeCompare(b)),
						await request.clone().text(),
					]),
				),
			);
			const key = [...new Uint8Array(digest)]
				.map((byte) => byte.toString(16).padStart(2, "0"))
				.join("");
			const now = Date.now();
			let entry = entries.get(key);
			if (!entry || entry.expiresAt <= now) {
				const pending = Promise.resolve()
					.then(async (): Promise<CachedResponse> => {
						const response = await binding.fetch(request);
						const body = await response.clone().text();
						const ttlMs = retention(path, response.status, body);
						return {
							body,
							status: response.status,
							headers: [...response.headers],
							ttlMs,
						};
					})
					.then((response) => {
						const current = entries.get(key);
						if (current?.pending === pending) {
							if (response.ttlMs <= 0) entries.delete(key);
							else current.expiresAt = started + response.ttlMs;
						}
						return response;
					})
					.catch((error: unknown) => {
						if (entries.get(key)?.pending === pending) entries.delete(key);
						throw error;
					});
				// Concurrent callers share the in-flight read; a wedged one stops
				// serving after the base TTL so later callers fetch afresh.
				entry = { expiresAt: started + TTL_MS, pending };
				entries.delete(key);
				entries.set(key, entry);
				while (entries.size > MAX_ENTRIES)
					entries.delete(entries.keys().next().value!);
			}
			const response = await entry.pending;
			// Separate response bodies prevent one request consuming another caller's result.
			return new Response(response.body, {
				status: response.status,
				headers: response.headers,
			});
		},
	};
	bindings.set(binding, cached);
	return cached;
}
