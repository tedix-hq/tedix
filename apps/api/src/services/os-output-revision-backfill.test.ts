import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { osOutputRevisions, osOutputs } from "@tedix/db/schema/os-workspaces";
import { organizations } from "@tedix/db/schema/organizations";
import {
	getOutputBodyBackfillSummary,
	setBackfilledOutputBody,
} from "@tedix/db/queries/os-workspaces/output-body-backfill";
import { backfillOutputRevisionBodiesPage } from "./os-output-revision-backfill";
import { storeOutputRevisionBody } from "./os-output-revision-body-store";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec(schemaDdl(organizations, osOutputs, osOutputRevisions));
	sqlite.exec("PRAGMA foreign_keys = ON");
	sqlite
		.prepare("INSERT INTO organizations(id,name,slug) VALUES (?,?,?),(?,?,?)")
		.run(
			"fictional-harbor",
			"Harbor",
			"harbor",
			"fictional-ridge",
			"Ridge",
			"ridge",
		);
	const db = createDbQueryClient(
		createD1Facade(sqlite, { maxBoundParams: 100 }),
	);
	const objects = new Map<string, ArrayBuffer>();
	const storage = {
		async put(key: string, value: ArrayBuffer) {
			objects.set(key, value);
		},
		async get(key: string) {
			const bytes = objects.get(key);
			return bytes ? { arrayBuffer: async () => bytes } : null;
		},
	};
	async function seed(
		id: string,
		content: string,
		organizationId = "fictional-harbor",
	) {
		await db.insert(osOutputs).values({
			id,
			organizationId,
			title: id,
			kind: "document",
			createdByKind: "user",
			createdById: "fictional-person",
		});
		await db.insert(osOutputRevisions).values({
			id,
			organizationId,
			outputId: id,
			revision: 1,
			content,
			createdByKind: "user",
			createdById: "fictional-person",
		});
	}
	const run = (
		params: { after?: number; through?: number; limit?: number } = {},
	) =>
		backfillOutputRevisionBodiesPage(db, storage, {
			organizationId: "fictional-harbor",
			...params,
		});
	const row = (id: string) =>
		sqlite.prepare("SELECT * FROM os_output_revisions WHERE id=?").get(id)!;
	const receipt = (key: string) =>
		JSON.parse(new TextDecoder().decode(objects.get(key)));
	return { db, sqlite, objects, storage, seed, run, row, receipt };
}

describe("output body backfill", () => {
	it("pages by rowid, retains inline UTF-8 bytes, verifies R2, and reports per-org dedupe", async () => {
		const f = fixture();
		await f.seed("a", "\ufeffGrüße 🌍\r\n  ");
		await f.seed("foreign", "foreign", "fictional-ridge");
		await f.seed("b", "\ufeffGrüße 🌍\r\n  ");
		await f.seed("c", "");
		const first = await f.run({ limit: 1 });
		expect(first).toMatchObject({
			rows: 1,
			rowsWritten: 1,
			cursor: 1,
			through: 4,
			done: false,
			hashMismatches: 0,
		});
		// Later inserts belong to the next pass, not this fixed boundary.
		await f.seed("later", "later");
		const second = await f.run({
			after: first.cursor,
			through: first.through,
			limit: 2,
		});
		expect(second).toMatchObject({
			rows: 2,
			rowsWritten: 2,
			cursor: 4,
			done: true,
			hashMismatches: 0,
		});
		expect(f.row("a").content).toBe("\ufeffGrüße 🌍\r\n  ");
		expect(f.row("c").content).toBe("");
		expect(f.row("a").body_r2_key).toBe(f.row("b").body_r2_key);
		expect(f.row("foreign").body_r2_key).toBeNull();
		expect(f.row("later").body_r2_key).toBeNull();
		expect(f.receipt(second.receiptKey)).toMatchObject({
			status: "verified",
			cursor: 4,
			rows: 2,
		});
		expect(second.summary).toMatchObject({
			rows: 4,
			missing: 1,
			distinctHashes: 2,
			distinctHashesPerRow: 0.5,
		});
		expect(first.bytes + second.bytes).toBe(
			2 * new TextEncoder().encode("\ufeffGrüße 🌍\r\n  ").length,
		);
	});

	it("records corruption and stops the cursor before setting the pointer", async () => {
		const f = fixture();
		await f.seed("a", "right");
		const wrong = await storeOutputRevisionBody(
			f.storage,
			"fictional-harbor",
			"wrong",
		);
		const original = f.storage.get;
		f.storage.get = async (key) =>
			key.endsWith(".gz") ? original(wrong.bodyR2Key) : original(key);
		const result = await f.run();
		expect(result).toMatchObject({
			rows: 0,
			rowsWritten: 0,
			cursor: 0,
			done: false,
			hashMismatches: 1,
			failures: [{ id: "a", rowid: 1, reason: "body_mismatch" }],
		});
		expect(f.row("a").body_r2_key).toBeNull();
		expect(f.row("a").content_sha256).toBeNull();
		expect(f.row("a").content_bytes).toBeNull();
		expect(f.receipt(result.receiptKey).status).toBe("failed");
		f.storage.get = original;
		expect(
			await f.run({ through: result.through, after: result.cursor }),
		).toMatchObject({ done: true, rowsWritten: 1 });
	});

	it.each(["missing", "invalid-gzip", "read-error"])(
		"never points at an unverified %s object",
		async (fault) => {
			const f = fixture();
			await f.seed("a", "private body");
			const get = f.storage.get;
			f.storage.get = async (key) => {
				if (!key.endsWith(".gz")) return get(key);
				if (fault === "read-error")
					throw new Error("provider message containing private body");
				return fault === "missing"
					? null
					: { arrayBuffer: async () => new Uint8Array([0]).buffer };
			};
			const result = await f.run();
			expect(result.rowsWritten).toBe(0);
			expect(result.failures[0]?.reason).toBe("verify_failed");
			expect(f.row("a").body_r2_key).toBeNull();
			expect(JSON.stringify(f.receipt(result.receiptKey))).not.toContain(
				"private body",
			);
		},
	);

	it("replays an interrupted page and verifies committed pointers without rewriting bodies", async () => {
		const f = fixture();
		await f.seed("a", "same");
		const put = f.storage.put;
		let receipts = 0;
		f.storage.put = async (key, value) => {
			if (key.endsWith(".json") && ++receipts === 2)
				throw new Error("receipt outage");
			return put(key, value);
		};
		await expect(f.run()).rejects.toThrow("receipt outage");
		expect(f.row("a").body_r2_key).toBeTruthy();
		const prepared = [...f.objects.keys()].find((key) =>
			key.endsWith(".json"),
		)!;
		expect(f.receipt(prepared)).toMatchObject({
			status: "prepared",
			after: 0,
			cursor: 0,
			through: 1,
		});
		f.storage.put = async (key, value) => {
			if (key.endsWith(".gz"))
				throw new Error("must not rewrite a committed body");
			return put(key, value);
		};
		expect(await f.run({ through: 1 })).toMatchObject({
			done: true,
			rows: 1,
			rowsWritten: 0,
			bytes: 4,
		});
		f.objects.delete(f.row("a").body_r2_key as string);
		expect(await f.run({ through: 1 })).toMatchObject({
			done: false,
			rows: 0,
			failures: [{ reason: "verify_failed" }],
		});
	});

	it("requires a durable intent receipt before any body or pointer writes", async () => {
		const f = fixture();
		await f.seed("a", "body");
		f.storage.put = async () => {
			throw new Error("receipt unavailable");
		};
		await expect(f.run()).rejects.toThrow("receipt unavailable");
		expect(f.objects.size).toBe(0);
		expect(f.row("a").body_r2_key).toBeNull();
	});

	it("fences concurrent body changes and tenant scope in the pointer update", async () => {
		const f = fixture();
		await f.seed("a", "old");
		const metadata = await storeOutputRevisionBody(
			f.storage,
			"fictional-harbor",
			"old",
		);
		for (const change of [
			{ organizationId: "fictional-ridge", content: "old", rowid: 1 },
			{ organizationId: "fictional-harbor", content: "changed", rowid: 1 },
			{ organizationId: "fictional-harbor", content: "old", rowid: 2 },
		]) {
			expect(
				await setBackfilledOutputBody(f.db, {
					id: "a",
					...metadata,
					...change,
				}),
			).toEqual([]);
		}
		const get = f.storage.get;
		f.storage.get = async (key) => {
			if (key.endsWith(".gz"))
				f.sqlite
					.prepare(
						"UPDATE os_output_revisions SET content='changed' WHERE id='a'",
					)
					.run();
			return get(key);
		};
		expect(await f.run()).toMatchObject({
			done: false,
			cursor: 0,
			failures: [{ reason: "pointer_failed" }],
		});
		expect(f.row("a").body_r2_key).toBeNull();
	});

	it("validates resume bounds and handles an empty organization without a false ratio", async () => {
		const f = fixture();
		expect(await f.run()).toMatchObject({
			done: true,
			rows: 0,
			cursor: 0,
			summary: { rows: 0, distinctHashesPerRow: null },
		});
		for (const params of [
			{ after: 1 },
			{ after: -1 },
			{ limit: 26 },
			{ through: 0.5 },
			{ after: 2, through: 1 },
		]) {
			await expect(f.run(params)).rejects.toThrow();
		}
		expect(
			await getOutputBodyBackfillSummary(f.db, {
				organizationId: "fictional-ridge",
			}),
		).toMatchObject({ rows: 0, missing: 0 });
	});
});
