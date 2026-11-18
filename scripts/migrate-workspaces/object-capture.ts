/** Read-only object recovery capture and comparison with a shared capture. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CaptureManifest } from "./capture-manifest";
import { collectWorkspaceRows } from "./export";
import { RowDigest, renderRow, rowKey, type StoredRow } from "./rows";
import { refKey } from "./scope";
import { snapshotManifest } from "./snapshot-proof";
import { Snapshot, type WorkspaceRef } from "./source";
import { WORKSPACE_TABLES } from "./tables";
import type { StoreDescription, WorkspaceStoreFactory } from "./target";

type Summary = { count: number; sha256: string };
export interface ObjectCaptureManifest extends WorkspaceRef {
	kind: "workspace-object-capture";
	version: 1;
	startedAt: string;
	endedAt: string;
	main: "main.sqlite";
	logs: [];
	fileSha256: string;
	tables: Record<string, Summary>;
	object: StoreDescription;
	requests: number;
	pageSize: number;
	delayMs: number;
}
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const fileHash = (path: string) =>
	createHash("sha256").update(readFileSync(path)).digest("hex");
function summarize(rows: StoredRow[], primaryKey: readonly string[]): Summary {
	const digest = new RowDigest(primaryKey);
	for (const row of rows) digest.add(row);
	return { count: digest.count, sha256: digest.hex() };
}

export async function exportObject(
	stores: WorkspaceStoreFactory,
	ref: WorkspaceRef,
	directory: string,
	options: {
		pageSize?: number;
		delayMs?: number;
		sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<ObjectCaptureManifest> {
	const pageSize = options.pageSize ?? 100;
	const delayMs = options.delayMs ?? 2000;
	if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000)
		throw new Error("page size must be 1..1000");
	if (!Number.isFinite(delayMs) || delayMs < 2000)
		throw new Error("object capture delay must be at least 2000ms");
	// A failed walk leaves no manifest; never overwrite an earlier recovery copy.
	mkdirSync(directory, { mode: 0o700 });
	const path = join(directory, "main.sqlite");
	const db = new DatabaseSync(path);
	let store: Awaited<ReturnType<WorkspaceStoreFactory["open"]>> | undefined;
	const startedAt = new Date().toISOString();
	const wait =
		options.sleep ??
		((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
	let requests = 0;
	const tables: Record<string, Summary> = {};
	try {
		store = await stores.open(ref);
		await wait(delayMs);
		requests++;
		const object = await store.describe();
		if (refKey(object) !== refKey(ref))
			throw new Error("object identity differs from requested workspace");
		for (const mapping of WORKSPACE_TABLES) {
			let after: string | null = null;
			const cursors = new Set<string>();
			const keys = new Set<string>();
			const digest = new RowDigest(mapping.primaryKey);
			let columns: string[] | undefined;
			do {
				await wait(delayMs);
				requests++;
				const page = await store.readRows(mapping.table, after, pageSize);
				if (page.rows.length > pageSize)
					throw new Error("object exceeded requested page size");
				for (const row of page.rows) {
					if (!columns) {
						columns = Object.keys(row).sort();
						db.exec(
							`CREATE TABLE ${quote(mapping.table)} (${columns.map(quote).join(", ")})`,
						);
					}
					if (
						JSON.stringify(Object.keys(row).sort()) !== JSON.stringify(columns)
					)
						throw new Error(`${mapping.table}: columns changed during export`);
					if (mapping.primaryKey.some((column) => row[column] == null))
						throw new Error(`${mapping.table}: missing primary key`);
					const key = rowKey(row, mapping.primaryKey);
					if (keys.has(key))
						throw new Error(`${mapping.table}: duplicate row ${key}`);
					keys.add(key);
					db.prepare(
						`INSERT INTO ${quote(mapping.table)} VALUES (${columns.map(() => "?").join(", ")})`,
					).run(...columns.map((column) => row[column]!));
					digest.add(row);
				}
				if (page.next !== null) {
					if (!page.rows.length || cursors.has(page.next))
						throw new Error(`${mapping.table}: non-advancing cursor`);
					cursors.add(page.next);
				}
				after = page.next;
			} while (after !== null);
			if (!columns)
				db.exec(
					`CREATE TABLE ${quote(mapping.table)} (${mapping.primaryKey.map(quote).join(", ")})`,
				);
			tables[mapping.table] = { count: digest.count, sha256: digest.hex() };
		}
		db.close();
		const manifest: ObjectCaptureManifest = {
			kind: "workspace-object-capture",
			version: 1,
			...ref,
			startedAt,
			endedAt: new Date().toISOString(),
			main: "main.sqlite",
			logs: [],
			fileSha256: fileHash(path),
			tables,
			object,
			requests,
			pageSize,
			delayMs,
		};
		writeFileSync(
			join(directory, "manifest.json"),
			JSON.stringify(manifest, null, 2),
			{ mode: 0o600, flag: "wx" },
		);
		return manifest;
	} finally {
		if (db.isOpen) db.close();
		await store?.close();
	}
}

function readManifest(
	directory: string,
): CaptureManifest | ObjectCaptureManifest {
	const manifest = JSON.parse(
		readFileSync(join(directory, "manifest.json"), "utf8"),
	) as CaptureManifest | ObjectCaptureManifest;
	if (
		manifest.version !== 1 ||
		!["paced-workspace-capture", "workspace-object-capture"].includes(
			manifest.kind,
		)
	)
		throw new Error("unsupported capture manifest");
	return manifest;
}
function readCapture(
	directory: string,
	manifest: CaptureManifest | ObjectCaptureManifest,
	ref: WorkspaceRef,
): Map<string, StoredRow[]> {
	if (manifest.kind === "workspace-object-capture") {
		if (refKey(manifest) !== refKey(ref))
			throw new Error("object capture names a different workspace");
		const path = join(directory, "main.sqlite");
		if (
			manifest.main !== "main.sqlite" ||
			fileHash(path) !== manifest.fileSha256
		)
			throw new Error("object capture file checksum differs");
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			const tables = new Map<string, StoredRow[]>();
			for (const mapping of WORKSPACE_TABLES) {
				const rows = db
					.prepare(`SELECT * FROM ${quote(mapping.table)}`)
					.all() as StoredRow[];
				const summary = summarize(rows, mapping.primaryKey);
				const expected = manifest.tables[mapping.table];
				if (
					!expected ||
					summary.count !== expected.count ||
					summary.sha256 !== expected.sha256
				)
					throw new Error(`${mapping.table}: object capture checksum differs`);
				tables.set(mapping.table, rows);
			}
			return tables;
		} finally {
			db.close();
		}
	}
	const snapshot = Snapshot.open({ main: join(directory, "manifest.json") });
	try {
		// Comparison accepts old captures, but never silently accepts damaged files.
		const proof = snapshotManifest(snapshot);
		if (
			JSON.stringify(proof.main) !== JSON.stringify(manifest.proof.main) ||
			JSON.stringify(proof.logs) !== JSON.stringify(manifest.proof.logs)
		)
			throw new Error("shared capture checksum differs");
		if (
			!snapshot
				.listWorkspaces(manifest.assignments)
				.some((candidate) => refKey(candidate) === refKey(ref))
		)
			throw new Error("workspace absent from shared capture");
		return collectWorkspaceRows(snapshot, ref, manifest.assignments).tables;
	} finally {
		snapshot.close();
	}
}

export interface CaptureComparison extends WorkspaceRef {
	ok: boolean;
	differenceCount: number;
	tables: Array<{
		table: string;
		before: Summary;
		after: Summary;
		differences: Array<{ key: string; kind: "added" | "removed" | "changed" }>;
	}>;
}
export function compareCaptures(
	beforeDir: string,
	afterDir: string,
	ref?: WorkspaceRef,
): CaptureComparison {
	const beforeManifest = readManifest(beforeDir);
	const afterManifest = readManifest(afterDir);
	const inferred =
		afterManifest.kind === "workspace-object-capture"
			? afterManifest
			: beforeManifest.kind === "workspace-object-capture"
				? beforeManifest
				: undefined;
	const workspace = ref ?? inferred;
	if (!workspace)
		throw new Error(
			"comparing shared captures requires one --scope organization/workspace",
		);
	const before = readCapture(beforeDir, beforeManifest, workspace);
	const after = readCapture(afterDir, afterManifest, workspace);
	const tables: CaptureComparison["tables"] = WORKSPACE_TABLES.map(
		(mapping) => {
			const left = before.get(mapping.table)!;
			const right = after.get(mapping.table)!;
			const index = (rows: StoredRow[]) => {
				const entries = new Map<string, string>();
				for (const row of rows) {
					const key = rowKey(row, mapping.primaryKey);
					if (entries.has(key))
						throw new Error(`${mapping.table}: duplicate key ${key}`);
					entries.set(key, renderRow(row));
				}
				return entries;
			};
			const l = index(left),
				r = index(right);
			const differences: CaptureComparison["tables"][number]["differences"] =
				[];
			for (const key of [...new Set([...l.keys(), ...r.keys()])].sort()) {
				if (!l.has(key)) differences.push({ key, kind: "added" });
				else if (!r.has(key)) differences.push({ key, kind: "removed" });
				else if (l.get(key) !== r.get(key))
					differences.push({ key, kind: "changed" });
			}
			return {
				table: mapping.table,
				before: summarize(left, mapping.primaryKey),
				after: summarize(right, mapping.primaryKey),
				differences,
			};
		},
	);
	const differenceCount = tables.reduce(
		(sum, table) => sum + table.differences.length,
		0,
	);
	return {
		organizationId: workspace.organizationId,
		workspaceId: workspace.workspaceId,
		ok: differenceCount === 0,
		differenceCount,
		tables,
	};
}
