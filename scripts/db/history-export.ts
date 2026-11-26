#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { S3Client } from "bun";
import {
	createHistoryReader,
	HISTORY_TABLES,
	type HistoryRead,
	type HistoryRow,
	type HistoryTable,
} from "@tedix/db/queries/history-export";
import { remoteD1QueryRest } from "../lib/remote-d1";

export interface HistoryBucket {
	list(options: { prefix: string; continuationToken?: string }): Promise<{
		contents?: { key: string }[];
		isTruncated?: boolean;
		nextContinuationToken?: string;
	}>;
	get(key: string): Promise<Uint8Array>;
	put(key: string, bytes: Uint8Array): Promise<void>;
}

export function createHistoryBucket(client: S3Client): HistoryBucket {
	return {
		list: (options) => client.list(options),
		get: async (key) => {
			// S3File.arrayBuffer() transparently decompresses content-encoded archives.
			const response = await fetch(client.presign(key, { expiresIn: 60 }), {
				decompress: false,
				redirect: "error",
			});
			if (!response.ok) throw new Error(`R2 read failed (${response.status})`);
			return new Uint8Array(await response.arrayBuffer());
		},
		put: async (key, bytes) => {
			await client.file(key).write(bytes, { type: "application/octet-stream" });
		},
	};
}

interface HistoryFile {
	path: string;
	sha256: string;
	bytes: number;
	table: string | null;
	source: string;
	rows: number | null;
	from: string | null;
	to: string | null;
	inputSha256?: string;
}

export const sha256 = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

function rowTime(table: HistoryTable, row: HistoryRow): string | null {
	if (!table.time) return null;
	const raw = row[table.time];
	const value =
		table.epoch && typeof raw === "number"
			? raw * 1000
			: typeof raw === "string"
				? Date.parse(
						/(Z|[+-]\d\d:\d\d)$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`,
					)
				: NaN;
	if (!Number.isFinite(value))
		throw new Error(`Invalid timestamp in ${table.table}`);
	return new Date(value).toISOString();
}

/** Never prune by the object's day: it names only the chunk's first row. */
export async function* archiveKeys(bucket: HistoryBucket, prefix: string) {
	let continuationToken: string | undefined;
	const seen = new Set<string>();
	do {
		const page = await bucket.list({ prefix, continuationToken });
		for (const object of page.contents ?? []) {
			if (!object.key.startsWith(prefix) || !object.key.endsWith(".ndjson.gz"))
				throw new Error("Unexpected archive key");
			yield object.key;
		}
		if (!page.isTruncated) break;
		const next = page.nextContinuationToken;
		if (!next || seen.has(next))
			throw new Error("Archive pagination did not advance");
		seen.add(next);
		continuationToken = next;
	} while (true);
}

export async function exportHistory(params: {
	organization: string;
	from: string;
	to: string;
	output: string;
	stores: { binding: string; read: HistoryRead }[];
	bucket: HistoryBucket;
	verifier: Uint8Array;
}) {
	const { organization, bucket, stores } = params;
	if (!organization || organization === "_platform")
		throw new Error("An organization is required");
	const from = new Date(params.from).toISOString();
	const to = new Date(params.to).toISOString();
	if (from >= to) throw new Error("from must precede to (exclusive)");
	if (
		stores[0]?.binding !== "DB" ||
		!stores.some((store) => store.binding === "LOGS_DB") ||
		new Set(stores.map((store) => store.binding)).size !== stores.length ||
		stores.some((store) => !/^(DB|LOGS_DB(?:_\d+)?)$/.test(store.binding))
	)
		throw new Error(
			"Supply DB, LOGS_DB and every numbered logs binding exactly once",
		);
	const startedAt = new Date().toISOString();
	const prefix = `history-exports/v1/${encodeURIComponent(organization)}/${randomUUID()}/`;
	// Refuse to mix a new pack with an earlier or incomplete export.
	await mkdir(params.output, { recursive: false, mode: 0o700 });
	const files: HistoryFile[] = [];
	const scans: {
		table: string;
		source: string;
		rows: number;
		highWater?: number;
		objects?: number;
	}[] = [];
	const write = async (
		path: string,
		bytes: Uint8Array,
		detail: Omit<HistoryFile, "path" | "bytes" | "sha256">,
	) => {
		await writeFile(join(params.output, path), bytes, {
			mode: 0o600,
			flag: "wx",
		});
		await bucket.put(prefix + path, bytes);
		if (sha256(await bucket.get(prefix + path)) !== sha256(bytes))
			throw new Error(`R2 read-back mismatch: ${path}`);
		files.push({ path, bytes: bytes.length, sha256: sha256(bytes), ...detail });
	};
	const writeRows = async (
		table: HistoryTable,
		source: string,
		rows: HistoryRow[],
		inputSha256?: string,
	) => {
		if (!rows.length) return;
		const times = rows
			.map((row) => rowTime(table, row))
			.filter((time): time is string => time !== null)
			.sort();
		await write(
			`${String(files.length).padStart(6, "0")}-${table.table}.ndjson`,
			new TextEncoder().encode(
				rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
			),
			{
				table: table.table,
				source,
				rows: rows.length,
				from: times[0] ?? null,
				to: times.at(-1) ?? null,
				...(inputSha256 ? { inputSha256 } : {}),
			},
		);
	};
	const main = createHistoryReader(stores[0]!.read);
	const owners = {
		skill_runs: await main.owners("skill_runs", organization),
		tedis: await main.owners("tedis", organization),
	};
	// Source order follows retention: main -> logs -> archive, so a forward move
	// during collection can add copies but cannot remove an unread source row.
	for (const store of stores) {
		const reader = createHistoryReader(store.read);
		for (const table of HISTORY_TABLES) {
			if (store.binding !== "DB" && !table.logs) continue;
			const highWater = await reader.highWater(table);
			const scan = {
				table: table.table,
				source: store.binding,
				highWater,
				rows: 0,
			};
			const ownerIds = table.indirect ? owners[table.indirect] : null;
			// Bound the ownership parameter as well as each result page.
			for (let start = 0; start < (ownerIds?.length ?? 1); start += 500) {
				let after = 0;
				while (true) {
					const rows = await reader.page(table, {
						organization,
						from,
						to,
						after,
						highWater,
						owners: ownerIds?.slice(start, start + 500),
					});
					await writeRows(table, store.binding, rows);
					scan.rows += rows.length;
					if (rows.length < 500) break;
					const next = rows.at(-1)?.__rowid;
					if (typeof next !== "number" || next <= after)
						throw new Error("D1 pagination did not advance");
					after = next;
				}
			}
			scans.push(scan);
		}
	}
	for (const table of HISTORY_TABLES) {
		if (!table.logs || !table.time) continue;
		const scan = {
			table: table.table,
			source: "d1-archive/v1",
			rows: 0,
			objects: 0,
		};
		const archivePrefix = `d1-archive/v1/${table.table}/${encodeURIComponent(organization)}/`;
		for await (const key of archiveKeys(bucket, archivePrefix)) {
			const input = await bucket.get(key);
			const rows = gunzipSync(input)
				.toString("utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as HistoryRow);
			const selected = rows.filter((row) => {
				if (!table.indirect && row[table.owner] !== organization)
					throw new Error(`Archive tenant mismatch: ${key}`);
				const time = rowTime(table, row)!;
				return time >= from && time < to;
			});
			await writeRows(table, key, selected, sha256(input));
			scan.rows += selected.length;
			scan.objects++;
		}
		scans.push(scan);
	}
	await write("verify.py", params.verifier, {
		table: null,
		source: "verifier",
		rows: null,
		from: null,
		to: null,
	});
	const manifest = {
		format: "tedix-history-pack/v1",
		organization,
		from,
		to,
		startedAt,
		finishedAt: new Date().toISOString(),
		prefix,
		consistency:
			"Per-store rowid high waters; collection interval, not a cross-store snapshot. Copies and conflicting versions are retained. Counts are physical rows, not unique events.",
		exclusions: [
			"Platform-only cron/workflow rows and platform call costs",
			"Business-state tables outside the declared history inventory",
			"Separate audit-exports; their audit rows are collected from D1/d1-archive",
			"Organization log store gateway change records, checkpoints, day manifests and change-record-evidence bundles, including historical exceptions and public signing keys",
		],
		indirectOwnership:
			"D1 artifacts/usage use the organization's current main skill_runs/tedis IDs; R2 uses the organization prefix recorded at archival time. Deleted parents cannot be attributed from D1 alone.",
		tables: HISTORY_TABLES,
		stores: stores.map((store) => store.binding),
		scans,
		files,
	};
	const bytes = new TextEncoder().encode(
		JSON.stringify(manifest, null, 2) + "\n",
	);
	await writeFile(join(params.output, "manifest.json"), bytes, {
		mode: 0o600,
		flag: "wx",
	});
	await bucket.put(prefix + "manifest.json", bytes);
	if (sha256(await bucket.get(prefix + "manifest.json")) !== sha256(bytes))
		throw new Error("Manifest read-back mismatch");
	return {
		manifestKey: prefix + "manifest.json",
		manifestSha256: sha256(bytes),
		files: files.length,
		rows: scans.reduce((sum, scan) => sum + scan.rows, 0),
	};
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Set ${name} from the authorized installation`);
	return value;
}

async function main() {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			organization: { type: "string" },
			from: { type: "string" },
			to: { type: "string" },
			output: { type: "string" },
		},
		strict: true,
	});
	if (!values.organization || !values.from || !values.to || !values.output)
		throw new Error(
			"Usage: bun scripts/db/history-export.ts --organization <id> --from <ISO> --to <ISO-exclusive> --output <new-directory>",
		);
	const accountId = required("CLOUDFLARE_ACCOUNT_ID");
	if (!/^[a-f0-9]{32}$/.test(accountId))
		throw new Error("Invalid Cloudflare account ID");
	const apiToken = required("CLOUDFLARE_API_TOKEN");
	const targets = JSON.parse(required("HISTORY_D1_DATABASES")) as Record<
		string,
		string
	>;
	if (
		!targets ||
		Array.isArray(targets) ||
		Object.values(targets).some(
			(id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id),
		) ||
		new Set(Object.values(targets)).size !== Object.keys(targets).length
	)
		throw new Error(
			"HISTORY_D1_DATABASES must map distinct bindings to database UUIDs",
		);
	const stores = Object.entries(targets)
		.sort(([a], [b]) => (a === "DB" ? -1 : b === "DB" ? 1 : a.localeCompare(b)))
		.map(([binding, databaseId]) => ({
			binding,
			read: async (sql: string, params: (string | number | null)[]) => {
				// The D1 REST API answers bursts with 429; the export's back-to-back
				// scans hit it after a few pages (21 Nov 2026). Wait and resend.
				let response = await remoteD1QueryRest({
					accountId,
					apiToken,
					databaseId,
					sql,
					params,
					caller: "scripts/db/history-export.ts",
				});
				for (const waitMs of [1_000, 2_000, 5_000, 10_000, 20_000, 30_000]) {
					if (response.status !== 429 && response.status !== 503) break;
					await Bun.sleep(waitMs);
					response = await remoteD1QueryRest({
						accountId,
						apiToken,
						databaseId,
						sql,
						params,
						caller: "scripts/db/history-export.ts",
					});
				}
				const result = response.result as {
					success: boolean;
					results: HistoryRow[];
					meta?: { rows_written?: number };
				}[];
				if (
					!response.ok ||
					!Array.isArray(result) ||
					result.length !== 1 ||
					result[0]?.success !== true ||
					!Array.isArray(result[0].results) ||
					result[0].meta?.rows_written
				)
					throw new Error(
						`History read failed for ${binding} (${response.status})`,
					);
				return result[0].results;
			},
		}));
	// The jurisdiction endpoint refuses buckets outside EU; no global fallback.
	const client = new S3Client({
		endpoint: `https://${accountId}.eu.r2.cloudflarestorage.com`,
		region: "auto",
		bucket: required("HISTORY_R2_BUCKET"),
		accessKeyId: required("AWS_ACCESS_KEY_ID"),
		secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
	});
	const bucket = createHistoryBucket(client);
	const verifier = new Uint8Array(
		await readFile(new URL("./verify-history-pack.py", import.meta.url)),
	);
	console.log(
		JSON.stringify(
			await exportHistory({
				...values,
				organization: values.organization,
				from: values.from,
				to: values.to,
				output: values.output,
				stores,
				bucket,
				verifier,
			}),
		),
	);
}

if (import.meta.main) await main();
