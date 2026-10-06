/**
 * Insert into an isolate-local cache while retaining at most `maxEntries`.
 *
 * Maps preserve insertion order, so deleting the oldest key gives the same
 * simple FIFO behavior as the existing hand-written MCP cache bounds. A
 * replacement is refreshed to the newest position.
 */
export function setBoundedCacheEntry<K, V>(
	cache: Map<K, V>,
	key: K,
	value: V,
	maxEntries: number,
): void {
	if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
		throw new RangeError("maxEntries must be a positive safe integer");
	}
	cache.delete(key);
	cache.set(key, value);
	while (cache.size > maxEntries) {
		const oldest = cache.keys().next();
		if (oldest.done) return;
		cache.delete(oldest.value);
	}
}

/** Release expired values on cache activity, including keys never read again. */
export function pruneExpiredCacheEntries<K, V extends { expiresAt: number }>(
	cache: Map<K, V>,
	now = Date.now(),
): void {
	for (const [key, value] of cache) {
		if (value.expiresAt <= now) cache.delete(key);
	}
}

/** TTL pruning plus the existing FIFO bound; this bounds entries, not bytes. */
export function setBoundedExpiringCacheEntry<
	K,
	V extends { expiresAt: number },
>(cache: Map<K, V>, key: K, value: V, maxEntries: number): void {
	pruneExpiredCacheEntries(cache);
	setBoundedCacheEntry(cache, key, value, maxEntries);
}
