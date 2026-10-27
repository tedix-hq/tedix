import type { OtAuthorityStorage } from "./ot/authority";

// Even UTF-16 strings with escaping stay well below SQLite's 2 MiB value limit.
const CHUNK_UNITS = 128 * 1024;
const PART = ":chunk:";

function chunkCount(value: unknown): number {
	if (typeof value !== "object" || value === null) return 0;
	const count = (value as { roomChunks?: unknown }).roomChunks;
	return typeof count === "number" && Number.isSafeInteger(count) && count > 0
		? count
		: 0;
}

/**
 * Keep the authority's synchronous write/output-gate contract while splitting
 * large bases AND rows. One list reads a record and its parts at one instant;
 * separate manifest/chunk reads could mix two materializations. Small values
 * retain the legacy layout, so existing rooms need no migration.
 */
export class ChunkedRoomStorage implements OtAuthorityStorage {
	readonly #counts = new Map<string, number>();

	constructor(private readonly storage: OtAuthorityStorage) {}

	async get<T>(key: string): Promise<T | undefined> {
		if (key !== "ot:base" && !key.startsWith("ot:row:")) {
			return this.storage.get<T>(key);
		}
		return this.#decode<T>(key, await this.storage.list({ prefix: key }));
	}

	async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
		if (options.prefix !== "ot:row:") return this.storage.list<T>(options);
		const records = await this.storage.list<unknown>(options);
		const result = new Map<string, T>();
		for (const key of records.keys()) {
			if (key.includes(PART)) continue;
			const value = this.#decode<T>(key, records);
			if (value !== undefined) result.set(key, value);
		}
		return result;
	}

	#decode<T>(key: string, records: Map<string, unknown>): T | undefined {
		const value = records.get(key);
		const count = chunkCount(value);
		this.#counts.set(key, Math.max(count, this.#counts.get(key) ?? 0));
		if (count === 0) return value as T | undefined;
		const parts: string[] = [];
		for (let i = 0; i < count; i++) {
			const part = records.get(`${key}${PART}${i}`);
			if (typeof part !== "string") {
				throw new Error(
					"The collaboration room has an incomplete stored record.",
				);
			}
			parts.push(part);
		}
		return JSON.parse(parts.join("")) as T;
	}

	put(key: string, value: unknown): Promise<void> {
		if (key !== "ot:base" && !key.startsWith("ot:row:")) {
			return this.storage.put(key, value);
		}
		const serialized = JSON.stringify(value);
		const count =
			serialized.length > CHUNK_UNITS
				? Math.ceil(serialized.length / CHUNK_UNITS)
				: 0;
		const writes: Promise<void>[] = [];
		for (let i = 0; i < count; i++) {
			writes.push(
				this.storage.put(
					`${key}${PART}${i}`,
					serialized.slice(i * CHUNK_UNITS, (i + 1) * CHUNK_UNITS),
				),
			);
		}
		writes.push(this.storage.put(key, count ? { roomChunks: count } : value));
		for (let i = count; i < (this.#counts.get(key) ?? 0); i++) {
			writes.push(this.storage.delete(`${key}${PART}${i}`));
		}
		this.#counts.set(key, count);
		return Promise.all(writes).then(() => {});
	}

	delete(key: string): Promise<void> {
		const writes = [this.storage.delete(key)];
		for (let i = 0; i < (this.#counts.get(key) ?? 0); i++) {
			writes.push(this.storage.delete(`${key}${PART}${i}`));
		}
		this.#counts.delete(key);
		return Promise.all(writes).then(() => {});
	}
}
