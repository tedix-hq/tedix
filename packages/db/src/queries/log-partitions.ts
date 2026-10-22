import type { DbClient } from "../client";
import { logPartition } from "../schema/logs-db";

const partitionCache = new WeakMap<
	object,
	{ expiresAt: number; row: Promise<typeof logPartition.$inferSelect | null> }
>();

/** Coalesce concurrent reads across request clients, refreshing after 30 seconds. */
export function readLogPartition(db: DbClient) {
	const binding = db.$client;
	const cached = partitionCache.get(binding);
	if (cached && cached.expiresAt > Date.now()) return cached.row;
	const row = db
		.select()
		.from(logPartition)
		.limit(2)
		.then((rows) => {
			if (rows.length > 1) throw new Error("Multiple log_partition rows");
			const partition = rows[0] ?? null;
			if (
				partition &&
				(!["active", "sealed"].includes(partition.state) ||
					!Number.isFinite(Date.parse(partition.fromTs)) ||
					(partition.state === "active"
						? partition.toTs !== null
						: partition.toTs === null ||
							!Number.isFinite(Date.parse(partition.toTs)) ||
							Date.parse(partition.toTs) < Date.parse(partition.fromTs)))
			)
				throw new Error("Invalid log_partition range or state");
			return partition;
		});
	const entry = { expiresAt: Date.now() + 30_000, row };
	partitionCache.set(binding, entry);
	void row.catch(() => {
		if (partitionCache.get(binding) === entry) partitionCache.delete(binding);
	});
	return row;
}
