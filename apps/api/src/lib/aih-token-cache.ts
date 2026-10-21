export interface AihTokenCacheEntry {
	token: string;
	expiresAt: number;
}

interface AihTokenCacheKeyParts {
	tediId: string;
	mcpServerId: string;
	clientId: string;
	credentialVersion?: string | null;
}

const aihTokenCache = new Map<string, AihTokenCacheEntry>();
const MAX_CACHE_ENTRIES = 100;

function cacheKey(parts: AihTokenCacheKeyParts): string {
	return JSON.stringify([
		parts.tediId,
		parts.mcpServerId,
		parts.clientId,
		parts.credentialVersion ?? "v0",
	]);
}

export function getCachedAihToken(
	parts: AihTokenCacheKeyParts & { now: number },
): AihTokenCacheEntry | null {
	const key = cacheKey(parts);
	const cached = aihTokenCache.get(key);
	if (cached && cached.expiresAt > parts.now) {
		return cached;
	}
	aihTokenCache.delete(key);
	return null;
}

export function setCachedAihToken(
	parts: AihTokenCacheKeyParts & { now: number },
	entry: AihTokenCacheEntry,
): void {
	for (const [key, value] of aihTokenCache) {
		if (value.expiresAt <= parts.now) aihTokenCache.delete(key);
	}

	const key = cacheKey(parts);
	aihTokenCache.delete(key);
	if (entry.expiresAt <= parts.now) return;
	// Map insertion order makes the oldest write the eviction candidate.
	aihTokenCache.set(key, entry);
	for (const oldestKey of aihTokenCache.keys()) {
		if (aihTokenCache.size <= MAX_CACHE_ENTRIES) break;
		aihTokenCache.delete(oldestKey);
	}
}

export function clearAihTokenCacheForTediServer(params: {
	tediId: string;
	mcpServerId: string;
	clientId?: string | null;
}): number {
	const identity = [params.tediId, params.mcpServerId];
	if (params.clientId != null) identity.push(params.clientId);
	// Retain the tuple separator so one identity cannot prefix another.
	const prefix = `${JSON.stringify(identity).slice(0, -1)},`;
	let deleted = 0;
	for (const key of aihTokenCache.keys()) {
		if (key.startsWith(prefix)) {
			aihTokenCache.delete(key);
			deleted += 1;
		}
	}
	return deleted;
}
