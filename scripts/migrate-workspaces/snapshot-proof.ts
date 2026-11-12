/**
 * What a remote import must prove about its snapshot before customer data
 * moves. There is no override.
 *
 * 1. A validated full snapshot, taken at import time: the main database and
 *    every log partition, no older than {@link SNAPSHOT_MAX_AGE_MS}, whose
 *    count and hash manifest equals the one each bundle recorded at export.
 * 2. Historical log coverage: the log partitions' ranges reach back to the
 *    oldest run and hold only rows inside their range, and every row that
 *    should move is in its bundle (`reconcile --snapshot` repeats this).
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { renderRow, type StoredRow } from "./rows";
import { hasTable, type Snapshot } from "./source";
import { WORKSPACE_TABLES } from "./tables";

/** A snapshot older than this is stale for an import; take a new one. */
export const SNAPSHOT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface LogPartitionRange {
	id: string;
	state: string;
	fromTs: string;
	toTs: string | null;
}

export interface StoreProof {
	/** The partition's own `log_partition` row; null for main and for an unranged log store. */
	partition: LogPartitionRange | null;
	/** Every mapped table this store can hold: row count and one hash over all rows. */
	tables: Record<string, { count: number; sha256: string }>;
}

export interface SnapshotManifest {
	takenAt: string;
	capture?: import("./capture-manifest").CaptureManifest;
	main: StoreProof;
	logs: StoreProof[];
}

function partitionRows(db: DatabaseSync): LogPartitionRange[] {
	if (!hasTable(db, "log_partition")) return [];
	return db
		.prepare(
			"SELECT id, state, from_ts AS fromTs, to_ts AS toTs FROM log_partition ORDER BY id",
		)
		.all()
		.map((row) => ({
			id: String(row.id),
			state: String(row.state),
			fromTs: String(row.fromTs),
			toTs: row.toTs === null ? null : String(row.toTs),
		}));
}

function storeProof(db: DatabaseSync, store: "main" | "logs"): StoreProof {
	const tables: StoreProof["tables"] = {};
	for (const mapping of WORKSPACE_TABLES) {
		if (!mapping.stores.includes(store)) continue;
		const hash = createHash("sha256");
		let count = 0;
		if (hasTable(db, mapping.table))
			for (const row of db
				.prepare(
					`SELECT * FROM "${mapping.table}" ORDER BY ${mapping.primaryKey.map((c) => `"${c}"`).join(", ")}`,
				)
				.iterate()) {
				hash.update(renderRow(row as StoredRow));
				hash.update("\n");
				count += 1;
			}
		tables[mapping.table] = { count, sha256: hash.digest("hex") };
	}
	return {
		partition: store === "logs" ? (partitionRows(db)[0] ?? null) : null,
		tables,
	};
}

/** The count and hash manifest of every store the snapshot holds. */
export function snapshotManifest(snapshot: Snapshot): SnapshotManifest {
	return {
		takenAt: snapshot.takenAt.toISOString(),
		...(snapshot.capture ? { capture: snapshot.capture } : {}),
		main: storeProof(snapshot.main, "main"),
		logs: snapshot.logs.map((db) => storeProof(db, "logs")),
	};
}

/** Gate 1: the snapshot is complete (main plus every log partition) and fresh. */
export function validateSnapshot(
	snapshot: Snapshot,
	now: Date = new Date(),
): string[] {
	const problems: string[] = [];
	const age = now.getTime() - snapshot.takenAt.getTime();
	if (snapshot.capture) {
		const capture = snapshot.capture;
		if (
			!Number.isFinite(age) ||
			age < 0 ||
			!Number.isFinite(Date.parse(capture.startedAt)) ||
			Date.parse(capture.startedAt) > snapshot.takenAt.getTime()
		)
			problems.push("invalid capture times");
		if (
			!capture.logDatabaseIds?.length ||
			new Set(capture.logDatabaseIds).size !== capture.logDatabaseIds.length ||
			JSON.stringify(capture.logDatabaseIds) !==
				JSON.stringify(capture.completedLogDatabaseIds) ||
			capture.logs.length !== capture.logDatabaseIds.length
		)
			problems.push("capture log coverage is incomplete");
		for (const [index, file] of [capture.main, ...capture.logs].entries()) {
			for (const mapping of WORKSPACE_TABLES.filter(
				(m) => index === 0 || m.stores.includes("logs"),
			)) {
				const mark = capture.highWater?.[file]?.[mapping.table];
				if (
					!mark ||
					!Number.isSafeInteger(mark.rowid) ||
					mark.rowid < 0 ||
					(mark.updatedAt !== null &&
						!Number.isFinite(Date.parse(mark.updatedAt)))
				)
					problems.push(
						`capture missing high-water mark: ${file} ${mapping.table}`,
					);
			}
		}
		problems.push(
			...manifestDifferences(capture.proof, {
				takenAt: snapshot.takenAt.toISOString(),
				main: storeProof(snapshot.main, "main"),
				logs: snapshot.logs.map((db) => storeProof(db, "logs")),
			}),
		);
	}
	if (age > SNAPSHOT_MAX_AGE_MS)
		problems.push(
			`snapshot was taken at ${snapshot.takenAt.toISOString()}, more than ${SNAPSHOT_MAX_AGE_MS / 3_600_000} hours before the import; take a new one`,
		);
	if (snapshot.logs.length === 0) {
		problems.push(
			"snapshot has no log partition; pass every log partition with --logs",
		);
		return problems;
	}
	const ranges: LogPartitionRange[] = [];
	snapshot.logs.forEach((db, index) => {
		const label = `log snapshot ${index + 1}`;
		if (!hasTable(db, "log_partition")) {
			problems.push(
				`${label} has no log_partition table; it is not a log partition`,
			);
			return;
		}
		const rows = partitionRows(db);
		if (rows.length > 1)
			problems.push(
				`${label} has ${rows.length} log_partition rows, expected one`,
			);
		if (rows[0]) ranges.push(rows[0]);
	});
	const unranged = snapshot.logs.length - ranges.length;
	if (unranged > 0 && snapshot.logs.length > 1)
		problems.push(
			"a log partition without a range holds all dates, so it must be the only one",
		);
	if (ranges.length === snapshot.logs.length && ranges.length > 0) {
		const sorted = [...ranges].sort((a, b) => (a.fromTs < b.fromTs ? -1 : 1));
		if (new Set(sorted.map((r) => r.id)).size !== sorted.length)
			problems.push("two log snapshots are the same partition");
		const active = sorted.filter((r) => r.state === "active");
		if (active.length !== 1 || sorted.at(-1)?.state !== "active")
			problems.push(
				"the newest log partition must be the only active one; the active partition is missing",
			);
		for (let i = 1; i < sorted.length; i += 1) {
			const previous = sorted[i - 1]!;
			if (previous.toTs === null || sorted[i]!.fromTs <= previous.toTs)
				problems.push(
					`log partitions ${previous.id} and ${sorted[i]!.id} overlap`,
				);
		}
	}
	return problems;
}

/**
 * Gate 2, the log half: the partitions reach back to the oldest run in the
 * main store, and each ranged partition holds only events inside its range.
 */
export function logCoverageProblems(snapshot: Snapshot): string[] {
	const problems: string[] = [];
	const ranges = snapshot.logs.map((db) => partitionRows(db)[0] ?? null);
	if (snapshot.logs.length === 0 || ranges.some((range) => range === null))
		return problems; // no logs is gate 1's finding; an unranged partition holds all dates
	const oldestRun = hasTable(snapshot.main, "kernel_runtime_runs")
		? snapshot.main
				.prepare("SELECT min(created_at) AS t FROM kernel_runtime_runs")
				.get()?.t
		: null;
	const earliest = ranges
		.map((range) => range!.fromTs)
		.sort()
		.at(0)!;
	if (typeof oldestRun === "string" && oldestRun < earliest)
		problems.push(
			`log partitions start at ${earliest}, after the oldest run (${oldestRun}); a partition is missing`,
		);
	snapshot.logs.forEach((db, index) => {
		const range = ranges[index]!;
		if (!hasTable(db, "kernel_runtime_events")) return;
		const bounds = db
			.prepare(
				"SELECT min(created_at) AS first, max(created_at) AS last FROM kernel_runtime_events",
			)
			.get();
		if (typeof bounds?.first !== "string" || typeof bounds.last !== "string")
			return;
		if (
			bounds.first < range.fromTs ||
			(range.toTs !== null && bounds.last > range.toTs)
		)
			problems.push(
				`log partition ${range.id} holds events from ${bounds.first} to ${bounds.last}, outside its range ${range.fromTs}..${range.toTs ?? "now"}`,
			);
	});
	return problems;
}

/** Fields of the export-time manifest that differ from the one taken now. */
export function manifestDifferences(
	expected: SnapshotManifest | undefined,
	actual: SnapshotManifest,
): string[] {
	if (!expected) return ["bundle carries no snapshot manifest"];
	const differences: string[] = [];
	if (JSON.stringify(expected.capture) !== JSON.stringify(actual.capture))
		differences.push("capture boundaries differ");
	if (expected.takenAt !== actual.takenAt)
		differences.push(
			`snapshot taken at ${actual.takenAt}, bundle exported from ${expected.takenAt}`,
		);
	const stores: Array<
		[string, StoreProof | undefined, StoreProof | undefined]
	> = [["main", expected.main, actual.main]];
	const logCount = Math.max(expected.logs.length, actual.logs.length);
	for (let i = 0; i < logCount; i += 1)
		stores.push([`log ${i + 1}`, expected.logs[i], actual.logs[i]]);
	for (const [label, want, have] of stores) {
		if (!want || !have) {
			differences.push(`${label}: present on one side only`);
			continue;
		}
		if (JSON.stringify(want.partition) !== JSON.stringify(have.partition))
			differences.push(`${label}: log partition differs`);
		for (const table of new Set([
			...Object.keys(want.tables),
			...Object.keys(have.tables),
		])) {
			const a = want.tables[table];
			const b = have.tables[table];
			if (a?.count !== b?.count || a?.sha256 !== b?.sha256)
				differences.push(
					`${label} ${table}: count ${a?.count ?? "none"} -> ${b?.count ?? "none"}`,
				);
		}
	}
	return differences;
}
