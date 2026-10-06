/**
 * Simple TTL cache — Map with timestamps.
 * No LRU, no fancy eviction. Just get/set with expiry.
 */
export class TtlCache<T> {
	private cache = new Map<string, { value: T; expiresAt: number }>();

	constructor(private ttlMs: number) {}

	get(key: string): T | undefined {
		const entry = this.cache.get(key);
		if (!entry) return undefined;
		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			return undefined;
		}
		return entry.value;
	}

	set(key: string, value: T): void {
		this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
	}

	delete(key: string): boolean {
		return this.cache.delete(key);
	}

	clear(): void {
		this.cache.clear();
	}

	get size(): number {
		return this.cache.size;
	}
}
