import type { FetcherLike } from "@tedix/api-client/internal";

const GRANT_PATH = "/rpc/organizations/verifyMultiOrgMcpGrant";
const TTL_MS = 10_000;
/** An allowed grant is keyed by consent id and revision, so a new consent misses. */
const GRANT_TTL_MS = 120_000;
/** One unavailable answer per key per window, so callers can't hammer a busy D1. */
const UNAVAILABLE_TTL_MS = 5_000;
const MAX_ENTRIES = 500;
const SHARED_CACHE_ORIGIN = "https://gateway-read-cache.tedix.internal";
const READ_PATHS = new Set([
	GRANT_PATH,
	"/rpc/mcpGovernance/resolveAgentTransportPolicy",
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
	if (outcome === "allowed") return GRANT_TTL_MS;
	return outcome === "unavailable" ? UNAVAILABLE_TTL_MS : 0;
}

function sharedCache(): Cache | null {
	return typeof caches !== "undefined" && caches.default
		? caches.default
		: null;
}

/** Allowed grants also live in the per-colo cache, so new isolates skip D1. */
async function readSharedGrant(key: string): Promise<CachedResponse | null> {
	try {
		const hit = await sharedCache()?.match(`${SHARED_CACHE_ORIGIN}/${key}`);
		if (!hit) return null;
		const expiresAt = Number(hit.headers.get("X-Expires-At"));
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
			await hit.body?.cancel();
			return null;
		}
		return {
			body: await hit.text(),
			status: 200,
			headers: [["Content-Type", "application/json"]],
			ttlMs: expiresAt - Date.now(),
		};
	} catch {
		return null;
	}
}

async function writeSharedGrant(key: string, body: string): Promise<void> {
	try {
		await sharedCache()?.put(
			`${SHARED_CACHE_ORIGIN}/${key}`,
			new Response(body, {
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": `max-age=${GRANT_TTL_MS / 1000}`,
					"X-Expires-At": String(Date.now() + GRANT_TTL_MS),
				},
			}),
		);
	} catch {}
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
						if (path === GRANT_PATH) {
							const shared = await readSharedGrant(key);
							if (shared) return shared;
						}
						const response = await binding.fetch(request);
						const body = await response.clone().text();
						const ttlMs = retention(path, response.status, body);
						if (path === GRANT_PATH && ttlMs === GRANT_TTL_MS)
							await writeSharedGrant(key, body);
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
