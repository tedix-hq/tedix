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

function cacheKey(parts: AihTokenCacheKeyParts): string {
	return [
		parts.tediId,
		parts.mcpServerId,
		parts.clientId,
		parts.credentialVersion ?? "v0",
	].join(":");
}

export function getCachedAihToken(
	parts: AihTokenCacheKeyParts & { now: number },
): AihTokenCacheEntry | null {
	const cached = aihTokenCache.get(cacheKey(parts));
	if (cached && cached.expiresAt > parts.now) {
		return cached;
	}
	return null;
}

export function setCachedAihToken(
	parts: AihTokenCacheKeyParts & { now: number },
	entry: AihTokenCacheEntry,
): void {
	aihTokenCache.set(cacheKey(parts), entry);

	if (aihTokenCache.size > 100) {
		for (const [key, value] of aihTokenCache) {
			if (value.expiresAt <= parts.now) aihTokenCache.delete(key);
		}
	}
}

export function clearAihTokenCacheForTediServer(params: {
	tediId: string;
	mcpServerId: string;
	clientId?: string | null;
}): number {
	const prefix = params.clientId
		? `${params.tediId}:${params.mcpServerId}:${params.clientId}:`
		: `${params.tediId}:${params.mcpServerId}:`;
	let deleted = 0;
	for (const key of aihTokenCache.keys()) {
		if (key.startsWith(prefix)) {
			aihTokenCache.delete(key);
			deleted += 1;
		}
	}
	return deleted;
}
