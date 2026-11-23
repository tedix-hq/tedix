import type { FetcherLike } from "@tedix/api-client/internal";

const TTL_MS = 10_000;
const MAX_ENTRIES = 500;
const READ_PATHS = new Set([
	"/rpc/organizations/verifyMultiOrgMcpGrant",
	"/rpc/mcpGovernance/resolveAgentTransportPolicy",
	"/rpc/externalAgentIdentity/resolveSessionAuth",
]);

type CachedResponse = {
	body: string;
	status: number;
	headers: [string, string][];
};
const bindings = new WeakMap<FetcherLike, FetcherLike>();

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
					.then(async () => {
						const response = await binding.fetch(request);
						const body = await response.clone().text();
						let reusable = response.ok;
						if (path === "/rpc/organizations/verifyMultiOrgMcpGrant") {
							try {
								reusable &&= JSON.parse(body)?.json?.allowed === true;
							} catch {
								reusable = false;
							}
						}
						if (!reusable && entries.get(key)?.pending === pending)
							entries.delete(key);
						return {
							body,
							status: response.status,
							headers: [...response.headers],
						};
					})
					.catch((error: unknown) => {
						if (entries.get(key)?.pending === pending) entries.delete(key);
						throw error;
					});
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
