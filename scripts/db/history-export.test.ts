import { afterEach, expect, test } from "bun:test";
import { S3Client } from "bun";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	createHistoryReader,
	HISTORY_TABLES,
	type HistoryRead,
} from "@tedix/db/queries/history-export";
import {
	archiveKeys,
	createHistoryBucket,
	exportHistory,
	type HistoryBucket,
	sha256,
} from "./history-export";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
const from = "2026-01-01T00:00:00.000Z";
const to = "2026-02-01T00:00:00.000Z";
const organization = "org_example";

test("R2 transport preserves compressed archive bytes despite Content-Encoding", async () => {
	const text = '{"id":"example"}\n';
	const compressed = gzipSync(text);
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () =>
			new Response(compressed, { headers: { "Content-Encoding": "gzip" } }),
	});
	try {
		const bucket = createHistoryBucket(
			new S3Client({
				endpoint: `http://127.0.0.1:${server.port}`,
				bucket: "example",
				accessKeyId: "fictional",
				secretAccessKey: "fictional",
			}),
		);
		const bytes = await bucket.get("example.ndjson.gz");
		expect(sha256(bytes)).toBe(sha256(compressed));
		expect(gunzipSync(bytes).toString()).toBe(text);
	} finally {
		server.stop(true);
	}
});

function store() {
	const db = new Database(":memory:");
	for (const spec of HISTORY_TABLES) {
		db.exec(
			`CREATE TABLE ${spec.table} (id TEXT, ${spec.owner} TEXT${spec.time ? `, ${spec.time} ${spec.epoch ? "REAL" : "TEXT"}` : ""}, payload TEXT)`,
		);
	}
	db.exec(
		"CREATE TABLE skill_runs (id TEXT, organization_id TEXT); CREATE TABLE tedis (id TEXT, organization_id TEXT)",
	);
	const read: HistoryRead = async (sql, params) =>
		db.query(sql).all(...params) as Record<string, unknown>[];
	return { db, read };
}

function bucket() {
	const objects = new Map<string, Uint8Array>();
	const api: HistoryBucket = {
		list: async ({ prefix, continuationToken }) => {
			const keys = [...objects.keys()]
				.filter((key) => key.startsWith(prefix))
				.sort();
			const offset = Number(continuationToken ?? 0);
			return {
				contents: keys.slice(offset, offset + 1).map((key) => ({ key })),
				isTruncated: keys.length > offset + 1,
				nextContinuationToken: String(offset + 1),
			};
		},
		get: async (key) => {
			const bytes = objects.get(key);
			if (!bytes) throw new Error("Missing object");
			return bytes;
		},
		put: async (key, bytes) => {
			objects.set(key, bytes);
		},
	};
	return { objects, api };
}

test("pack spans paged main, numbered logs and multi-day archive chunks with verified file hashes", async () => {
	const root = await mkdtemp(join(tmpdir(), "history-pack-"));
	roots.push(root);
	const output = join(root, "pack");
	const main = store(),
		logs = store(),
		older = store();
	try {
		main.db.exec(
			"INSERT INTO skill_runs VALUES ('run_example', 'org_example'), ('run_other', 'org_other')",
		);
		const insertRun = main.db.prepare("INSERT INTO skill_runs VALUES (?, ?)");
		for (let i = 0; i < 500; i++) insertRun.run(`run_bulk_${i}`, organization);
		main.db.exec(
			"INSERT INTO skill_run_artifacts VALUES ('artifact', 'run_example', '2026-01-03', NULL)",
		);
		logs.db.exec(
			"INSERT INTO skill_run_artifacts VALUES ('private', 'run_other', '2026-01-03', NULL)",
		);
		const insert = main.db.prepare(
			"INSERT INTO audit_events VALUES (?, ?, ?, ?)",
		);
		for (let i = 0; i < 501; i++)
			insert.run(`event-${i}`, organization, Date.parse(from) / 1000, "main");
		insert.run("other-tenant", "org_other", Date.parse(from) / 1000, "private");
		insert.run("upper-bound", organization, Date.parse(to) / 1000, "excluded");
		logs.db.exec(
			`INSERT INTO audit_events VALUES ('event-0', 'org_example', ${Date.parse(from) / 1000}, 'conflicting-copy')`,
		);
		older.db.exec(
			`INSERT INTO audit_events VALUES ('historical', 'org_example', ${Date.parse(from) / 1000 + 1}, 'old')`,
		);
		const { api, objects } = bucket();
		const archiveRow = {
			id: "archive",
			organization_id: organization,
			timestamp: Date.parse(from) / 1000 + 2,
			__rowid: 9,
		};
		objects.set(
			`d1-archive/v1/audit_events/${organization}/2025-12-30/1-9.ndjson.gz`,
			gzipSync(
				JSON.stringify({
					...archiveRow,
					timestamp: Date.parse(from) / 1000 - 1,
				}) +
					"\n" +
					JSON.stringify(archiveRow) +
					"\n",
			),
		);
		objects.set(
			`d1-archive/v1/audit_events/${organization}/2026-01-01/10-10.ndjson.gz`,
			gzipSync(JSON.stringify({ ...archiveRow, id: "archive-2" }) + "\n"),
		);
		objects.set(
			"d1-archive/v1/audit_events/org_other/2026-01-01/1-1.ndjson.gz",
			gzipSync("private"),
		);
		const verifier = new Uint8Array(
			await readFile(new URL("./verify-history-pack.py", import.meta.url)),
		);
		const receipt = await exportHistory({
			organization,
			from,
			to,
			output,
			stores: [
				{ binding: "DB", read: main.read },
				{ binding: "LOGS_DB", read: logs.read },
				{ binding: "LOGS_DB_1", read: older.read },
			],
			bucket: api,
			verifier,
		});
		const manifestBytes = await readFile(join(output, "manifest.json"));
		const manifest = JSON.parse(manifestBytes.toString());
		expect(receipt.rows).toBe(506);
		expect(
			manifest.files.filter(
				(file: { source: string; table: string }) =>
					file.source === "DB" && file.table === "audit_events",
			),
		).toHaveLength(2);
		expect([...objects.keys()].at(-1)).toBe(receipt.manifestKey);
		expect(sha256(objects.get(receipt.manifestKey)!)).toBe(
			receipt.manifestSha256,
		);
		for (const file of manifest.files) {
			const bytes = await readFile(join(output, file.path));
			expect(sha256(bytes)).toBe(file.sha256);
			expect(bytes.length).toBe(file.bytes);
		}
	} finally {
		main.db.close();
		logs.db.close();
		older.db.close();
	}
});

test("SQLite page filters mixed text timestamps and indirect ownership with a fixed high water", async () => {
	const { db, read } = store();
	try {
		const table = HISTORY_TABLES.find(
			(spec) => spec.table === "tedi_usage_events",
		)!;
		db.exec(
			"INSERT INTO tedi_usage_events VALUES ('a', 'tedi_example', '2026-01-01 00:00:00', NULL), ('b', 'tedi_example', '2026-02-01T00:00:00Z', NULL), ('c', 'tedi_other', '2026-01-02', NULL)",
		);
		const reader = createHistoryReader(read);
		const highWater = await reader.highWater(table);
		db.exec(
			"INSERT INTO tedi_usage_events VALUES ('late', 'tedi_example', '2026-01-02', NULL)",
		);
		const rows = await reader.page(table, {
			organization,
			from,
			to,
			after: 0,
			highWater,
			owners: ["tedi_example"],
		});
		expect(rows.map((row) => row.id)).toEqual(["a"]);
	} finally {
		db.close();
	}
});

test("missing archive pages and failed publication abort without a manifest", async () => {
	const { api, objects } = bucket();
	const stalled = {
		...api,
		list: async () => ({ isTruncated: true, nextContinuationToken: "same" }),
	};
	await expect(async () => {
		for await (const _key of archiveKeys(
			stalled,
			"d1-archive/v1/audit_events/org_example/",
		)) {
			/* consume */
		}
	}).toThrow("did not advance");
	const main = store(),
		logs = store();
	const root = await mkdtemp(join(tmpdir(), "history-failure-"));
	roots.push(root);
	try {
		main.db.exec(
			"INSERT INTO work_events VALUES ('event', 'org_example', '2026-01-02', NULL)",
		);
		await expect(
			exportHistory({
				organization,
				from,
				to,
				output: join(root, "pack"),
				stores: [
					{ binding: "DB", read: main.read },
					{ binding: "LOGS_DB", read: logs.read },
				],
				bucket: {
					...api,
					put: async () => {
						throw new Error("denied");
					},
				},
				verifier: new Uint8Array(),
			}),
		).rejects.toThrow("denied");
		expect(
			[...objects.keys()].some((key) => key.endsWith("manifest.json")),
		).toBe(false);
	} finally {
		main.db.close();
		logs.db.close();
	}
});
