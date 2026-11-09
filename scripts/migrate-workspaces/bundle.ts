/**
 * A bundle is one workspace's rows, written once by `export` and read by
 * `import` and `reconcile`: `manifest.json` plus one `<table>.jsonl` per
 * mapped table. Bundles live in a local directory or in an R2 bucket
 * (`r2://bucket/prefix`, uploaded with the bucket's jurisdiction).
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromWire, toWire, type StoredRow, type WireRow } from "./rows";
import type { SnapshotManifest } from "./snapshot-proof";
import type { WorkspaceRef } from "./source";
import type { WorkspaceAssignments } from "./tables";

export interface TableSummary {
	count: number;
	sha256: string;
	/** Rows whose workspace column was rewritten to this workspace. */
	reassigned: number;
}

export interface BundleManifest extends WorkspaceRef {
	version: 1;
	exportedAt: string;
	/** Which organization choices this bundle applied. */
	assignments: WorkspaceAssignments[string] | null;
	tables: Record<string, TableSummary>;
	/** Serving revision per output, as the source had it. */
	outputHeads: Array<{
		outputId: string;
		currentRevisionId: string | null;
		latestRevision: number | null;
	}>;
	/** Count and hash manifest of the snapshot this bundle was exported from. */
	snapshot: SnapshotManifest;
}

export interface BundleStore {
	write(
		ref: WorkspaceRef,
		manifest: BundleManifest,
		tables: Map<string, StoredRow[]>,
	): Promise<void>;
	read(
		ref: WorkspaceRef,
	): Promise<{ manifest: BundleManifest; tables: Map<string, StoredRow[]> }>;
	list(): Promise<WorkspaceRef[]>;
}

function bundleKey(ref: WorkspaceRef): string {
	return join(
		encodeURIComponent(ref.organizationId),
		encodeURIComponent(ref.workspaceId),
	);
}

export class LocalBundleStore implements BundleStore {
	constructor(readonly dir: string) {}

	async write(
		ref: WorkspaceRef,
		manifest: BundleManifest,
		tables: Map<string, StoredRow[]>,
	) {
		const dir = join(this.dir, bundleKey(ref));
		mkdirSync(dir, { recursive: true });
		for (const [table, rows] of tables)
			writeFileSync(
				join(dir, `${table}.jsonl`),
				rows.map((row) => JSON.stringify(toWire(row))).join("\n") +
					(rows.length ? "\n" : ""),
			);
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify(manifest, null, "\t"),
		);
	}

	async read(ref: WorkspaceRef) {
		const dir = join(this.dir, bundleKey(ref));
		const manifest = JSON.parse(
			readFileSync(join(dir, "manifest.json"), "utf8"),
		) as BundleManifest;
		const tables = new Map<string, StoredRow[]>();
		for (const table of Object.keys(manifest.tables))
			tables.set(table, readJsonl(join(dir, `${table}.jsonl`)));
		return { manifest, tables };
	}

	async list(): Promise<WorkspaceRef[]> {
		if (!existsSync(this.dir)) return [];
		const refs: WorkspaceRef[] = [];
		for (const org of readdirSync(this.dir, { withFileTypes: true }))
			if (org.isDirectory())
				for (const ws of readdirSync(join(this.dir, org.name), {
					withFileTypes: true,
				}))
					if (
						ws.isDirectory() &&
						existsSync(join(this.dir, org.name, ws.name, "manifest.json"))
					)
						refs.push({
							organizationId: decodeURIComponent(org.name),
							workspaceId: decodeURIComponent(ws.name),
						});
		return refs.sort((a, b) =>
			`${a.organizationId}/${a.workspaceId}` <
			`${b.organizationId}/${b.workspaceId}`
				? -1
				: 1,
		);
	}
}

function readJsonl(path: string): StoredRow[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => fromWire(JSON.parse(line) as WireRow));
}

/**
 * R2 through `wrangler r2 object`, staged in a local directory. Every object
 * is created in the bucket's jurisdiction (`eu` by default), the same rule the
 * CLI release bucket needed on the EU account.
 */
export class R2BundleStore implements BundleStore {
	readonly #local: LocalBundleStore;
	constructor(
		readonly bucket: string,
		readonly prefix: string,
		readonly jurisdiction: string = "eu",
		stagingDir: string = join(tmpdir(), "tedix-workspace-bundles"),
	) {
		this.#local = new LocalBundleStore(stagingDir);
	}

	private wrangler(args: string[]): string {
		const result = spawnSync("bunx", ["wrangler", "r2", "object", ...args], {
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
		});
		if (result.status !== 0)
			throw new Error(
				`wrangler r2 object ${args[0]} failed: ${result.stderr || result.stdout}`,
			);
		return result.stdout;
	}

	private objectKey(ref: WorkspaceRef, file: string): string {
		return `${this.bucket}/${[this.prefix, bundleKey(ref), file].filter(Boolean).join("/")}`;
	}

	async write(
		ref: WorkspaceRef,
		manifest: BundleManifest,
		tables: Map<string, StoredRow[]>,
	) {
		await this.#local.write(ref, manifest, tables);
		const dir = join(this.#local.dir, bundleKey(ref));
		for (const file of [
			...[...tables.keys()].map((t) => `${t}.jsonl`),
			"manifest.json",
		])
			this.wrangler([
				"put",
				this.objectKey(ref, file),
				"--file",
				join(dir, file),
				"--jurisdiction",
				this.jurisdiction,
				"--remote",
			]);
	}

	async read(ref: WorkspaceRef) {
		const dir = join(this.#local.dir, bundleKey(ref));
		mkdirSync(dir, { recursive: true });
		this.wrangler([
			"get",
			this.objectKey(ref, "manifest.json"),
			"--file",
			join(dir, "manifest.json"),
			"--jurisdiction",
			this.jurisdiction,
			"--remote",
		]);
		const manifest = JSON.parse(
			readFileSync(join(dir, "manifest.json"), "utf8"),
		) as BundleManifest;
		for (const table of Object.keys(manifest.tables))
			this.wrangler([
				"get",
				this.objectKey(ref, `${table}.jsonl`),
				"--file",
				join(dir, `${table}.jsonl`),
				"--jurisdiction",
				this.jurisdiction,
				"--remote",
			]);
		return this.#local.read(ref);
	}

	async list(): Promise<WorkspaceRef[]> {
		// `wrangler r2 object` has no listing; the export writes an index object.
		const dir = this.#local.dir;
		mkdirSync(dir, { recursive: true });
		this.wrangler([
			"get",
			`${this.bucket}/${[this.prefix, "index.json"].filter(Boolean).join("/")}`,
			"--file",
			join(dir, "index.json"),
			"--jurisdiction",
			this.jurisdiction,
			"--remote",
		]);
		return JSON.parse(
			readFileSync(join(dir, "index.json"), "utf8"),
		) as WorkspaceRef[];
	}

	async writeIndex(refs: WorkspaceRef[]): Promise<void> {
		const dir = this.#local.dir;
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "index.json"), JSON.stringify(refs));
		this.wrangler([
			"put",
			`${this.bucket}/${[this.prefix, "index.json"].filter(Boolean).join("/")}`,
			"--file",
			join(dir, "index.json"),
			"--jurisdiction",
			this.jurisdiction,
			"--remote",
		]);
	}
}

/** `r2://bucket/prefix` or a directory path. */
export function openBundleStore(
	location: string,
	jurisdiction = "eu",
): BundleStore {
	const r2 = /^r2:\/\/([^/]+)\/?(.*)$/.exec(location);
	if (r2) return new R2BundleStore(r2[1]!, r2[2] ?? "", jurisdiction);
	return new LocalBundleStore(location);
}
