import { getTediRuntimePolicy } from "@tedix/db/queries/tedi-runtime-bootstrap";
import type { TediModelPolicy } from "./model-policy";

/** In-memory control-plane caches, separate from active turns and durable work. */
export class RuntimeConfigCache {
	constructor(private readonly readPolicy = getTediRuntimePolicy) {}
	generation = 0;
	private workItemConcurrency: number | null = null;
	modelPolicy: TediModelPolicy | undefined;

	invalidate(): void {
		this.generation++;
		this.workItemConcurrency = null;
		this.modelPolicy = undefined;
	}

	async getMaxConcurrentWorkItems(
		db: D1Database,
		tediId: string | null | undefined,
	): Promise<number> {
		if (this.workItemConcurrency !== null) return this.workItemConcurrency;
		const generation = this.generation;
		const fallback = 2;
		if (!tediId) return fallback;
		let parsed = fallback;
		let cacheable = false;
		try {
			const row = await this.readPolicy(db, tediId);
			if (row?.definition) {
				const definition =
					typeof row.definition === "string"
						? JSON.parse(row.definition)
						: row.definition;
				const value = definition?.workItemConcurrency;
				parsed =
					typeof value === "number" && value > 0
						? Math.min(value, 8)
						: fallback;
				cacheable = true;
			}
		} catch {
			/* Preserve the existing fallback when the current read fails. */
		}
		// Admission consumes this result immediately: an old read must neither
		// repopulate the cache nor authorize new work after invalidation.
		if (generation !== this.generation)
			return this.getMaxConcurrentWorkItems(db, tediId);
		if (cacheable) this.workItemConcurrency = parsed;
		return parsed;
	}
}
