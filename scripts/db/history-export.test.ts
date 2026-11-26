import { afterEach, expect, test } from "bun:test";
import { S3Client } from "bun";
import { Database } from "bun:sqlite";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { importSigningKey, sealRun } from "@tedix/agent-governance/seal";
import {
	DAY_MANIFEST_FORMAT,
	EVIDENCE_BUNDLE_FORMAT,
} from "@tedix/agent-governance/evidence";
import { collectLedger, verifyLedger } from "./history-ledger";
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

test("signed post-cutover ledger and standalone exceptions verify offline with tenant isolation", async () => {
	const root = await mkdtemp(join(tmpdir(), "history-ledger-"));
	roots.push(root);
	const output = join(root, "pack");
	const main = store(),
		logs = store();
	const { api, objects } = bucket();
	const pair = generateKeyPairSync("ed25519");
	const key = await importSigningKey(
		pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
	);
	const keys = { [key.fingerprint]: key.publicKeySpki };
	const records = [
		{ id: "context", recordedAt: "2025-12-31T23:59:59Z", sequence: 1 },
		{
			id: "post-cutover",
			recordedAt: "2026-01-02T00:00:00Z",
			sequence: 2,
			value: 0.000001,
		},
	];
	const sealed = await sealRun({
		organizationId: organization,
		records,
		previousChainHash: null,
		previousCheckpointDigest: null,
		sealedAt: "2026-02-02T00:00:00Z",
		signer: { privateKey: key.privateKey, keyId: key.fingerprint },
	});
	const bundle = {
		format: EVIDENCE_BUNDLE_FORMAT,
		checkpointId: "checkpoint",
		writtenAt: "2026-02-02T00:00:00Z",
		checkpoint: sealed.checkpoint,
		records: records.map((row, i) => ({ ...row, ...sealed.seals[i] })),
		publicKey: null,
		verification: { recordsVerified: 2, signature: "not_checked" },
	};
	const bundleKey = `change-record-evidence/v1/${organization}/000000000002-checkpoint.json`;
	const bytes = new TextEncoder().encode(JSON.stringify(bundle));
	objects.set(bundleKey, bytes);
	const dayKey = `change-record-evidence/v1/${organization}/days/2026-02-02.json`;
	objects.set(
		dayKey,
		new TextEncoder().encode(
			JSON.stringify({
				format: DAY_MANIFEST_FORMAT,
				organizationId: organization,
				day: "2026-02-02",
				updatedAt: bundle.writtenAt,
				checkpoints: [
					{
						checkpointId: "checkpoint",
						firstSequence: 1,
						lastSequence: 2,
						recordCount: 2,
						checkpointDigest: sealed.checkpoint.digest,
						bundleKey,
						bundleSha256: sha256(bytes),
					},
				],
			}),
		),
	);
	// The same records can survive in a historical bundle without a day manifest.
	objects.set(
		`change-record-evidence/v1/${organization}/historical-copy.json`,
		bytes,
	);
	const historicalRecord = {
		id: "historical-version",
		sequence: 2,
		recordedAt: "2026-01-02T00:00:00Z",
	};
	const historical = await sealRun({
		organizationId: organization,
		records: [historicalRecord],
		previousChainHash: null,
		previousCheckpointDigest: "a".repeat(64),
		sealedAt: "2026-01-03T00:00:00Z",
	});
	objects.set(
		`change-record-evidence/v1/${organization}/unsigned-exception.json`,
		new TextEncoder().encode(
			JSON.stringify({
				...bundle,
				checkpointId: "historical",
				checkpoint: historical.checkpoint,
				records: [{ ...historicalRecord, ...historical.seals[0] }],
			}),
		),
	);
	objects.set(
		"change-record-evidence/v1/org_other/private.json",
		new TextEncoder().encode("private"),
	);
	objects.set(
		`audit-exports/v1/${organization}/2026-01-02/00.jsonl.gz`,
		gzipSync(
			JSON.stringify({
				id: "audit-only",
				organizationId: organization,
				timestamp: "2026-01-02T00:00:00Z",
			}) + "\n",
		),
	);
	objects.set(
		"audit-exports/v1/org_other/2026-01-02/00.jsonl.gz",
		gzipSync("private"),
	);
	try {
		const receipt = await exportHistory({
			organization,
			from,
			to,
			output,
			stores: [
				{ binding: "DB", read: main.read },
				{ binding: "LOGS_DB", read: logs.read },
			],
			bucket: api,
			verifier: new Uint8Array(
				await readFile(new URL("./verify-history-pack.py", import.meta.url)),
			),
			ledgerKeys: keys,
		});
		const manifest = JSON.parse(
			await readFile(join(output, "manifest.json"), "utf8"),
		);
		expect(manifest.ledger.selectedRecords).toBe(3);
		expect(manifest.ledger.contextRecords).toBe(2);
		expect(manifest.ledger.duplicateRecords).toBe(2);
		expect(manifest.ledger.standalone).toHaveLength(2);
		expect(manifest.ledger.unsigned).toHaveLength(1);
		expect(manifest.ledger.conflictingSequences).toEqual([2]);
		expect(manifest.ledger.missingPredecessors).toHaveLength(1);
		expect(manifest.ledger.missingDays).toContain("2026-01-02");
		expect(
			manifest.files.some((file: { source: string }) =>
				file.source.includes("org_other"),
			),
		).toBe(false);
		const keysPath = join(root, "keys.json");
		await writeFile(keysPath, JSON.stringify(keys));
		const verified = Bun.spawnSync([
			"python3",
			join(output, "verify.py"),
			output,
			"--sha256",
			receipt.manifestSha256,
			"--keys",
			keysPath,
		]);
		expect(verified.stderr.toString()).toBe("");
		expect(verified.exitCode).toBe(0);
		expect(
			JSON.parse(verified.stdout.toString()).ledger.keyFingerprints,
		).toEqual([key.fingerprint]);
		const collected = await collectLedger(api, organization, from, to);
		await expect(
			verifyLedger(collected, organization, from, to, {}),
		).rejects.toThrow("verification failed");
		const changed = structuredClone(bundle);
		changed.records[1]!.id = "tampered";
		await expect(
			verifyLedger(
				[
					{
						key: bundleKey,
						bytes: new TextEncoder().encode(JSON.stringify(changed)),
					},
				],
				organization,
				from,
				to,
				keys,
			),
		).rejects.toThrow("verification failed");
		objects.set(bundleKey, new TextEncoder().encode(JSON.stringify(changed)));
		await expect(collectLedger(api, organization, from, to)).rejects.toThrow(
			"Missing or changed",
		);
		objects.set(bundleKey, bytes);
		objects.set(
			`change-record-evidence/v1/${organization}/wrong-tenant.json`,
			new TextEncoder().encode(
				JSON.stringify({
					...bundle,
					checkpoint: { ...bundle.checkpoint, organizationId: "org_other" },
				}),
			),
		);
		await expect(collectLedger(api, organization, from, to)).rejects.toThrow(
			"tenant",
		);
	} finally {
		main.db.close();
		logs.db.close();
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
