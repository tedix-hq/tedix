/**
 * Short, stable, fixed-length key derived from a raw cache fingerprint.
 *
 * Raw aggregate fingerprints are the full entries JSON, which for large
 * aggregates (tedix-unified, 31 apps) runs to several KB — past R2's 1024-byte
 * object-key limit, so the L3 write threw silently and the expensive surfaces
 * never cached. The hash also keeps Cache API URLs bounded. cyrb53 (53-bit)
 * → ~14 hex chars; collision risk is negligible across the handful of distinct
 * fingerprints. Not a security hash — just a compact cache key.
 */
export function hashAggregateCacheKey(cacheKey: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < cacheKey.length; i++) {
		const ch = cacheKey.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0))
		.toString(16)
		.padStart(14, "0");
}
