import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	osGadgetCode,
	osGadgetCodeBlobs,
} from "@tedix/db/schema/os-workspaces";
import { organizations } from "@tedix/db/schema/organizations";
import { getOsGadgetCode } from "@tedix/db/queries/os-workspaces/gadgets";
import { osGadgetCodeSha256 } from "@tedix/db/queries/os-workspaces/gadget-code";
import {
	GADGET_CODE_DEDUPE_STATE_KEY,
	type GadgetCodeDedupeMode,
	runGadgetCodeDedupeTick,
} from "./os-gadget-code-dedupe";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

const editor = JSON.stringify({
	"client.js": "é".repeat(500),
	"server.js": "",
});
const custom = JSON.stringify({ "client.js": "render()", "server.js": "x" });
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	// The revision and gadget tables are not needed here.
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(organizations, osGadgetCode, osGadgetCodeBlobs));
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
	const facade = createD1Facade(sqlite, { maxBoundParams: 100 });
	const fault = { failOn: null as string | null, statements: [] as string[] };
	const d1 = new Proxy(facade, {
		get(target, property, receiver) {
			if (property !== "prepare")
				return Reflect.get(target, property, receiver);
			return (query: string) => {
				fault.statements.push(query);
				if (fault.failOn && query.toLowerCase().startsWith(fault.failOn))
					throw new Error("D1_ERROR: D1 DB is overloaded. Requests queued");
				return target.prepare(query);
			};
		},
	});
	const db = createDbQueryClient(d1);
	const objects = new Map<string, ArrayBuffer>();
	const bucket = {
		async put(key: string, value: ArrayBuffer) {
			objects.set(key, value);
		},
		async get(key: string) {
			const value = objects.get(key);
			return value ? { arrayBuffer: async () => value } : null;
		},
	};
	const json = (key: string) =>
		JSON.parse(new TextDecoder().decode(objects.get(key)));
	const arm = (mode: GadgetCodeDedupeMode) =>
		bucket.put(
			GADGET_CODE_DEDUPE_STATE_KEY,
			new TextEncoder().encode(JSON.stringify({ version: 1, mode }))
				.buffer as ArrayBuffer,
		);
	const seed = (
		revisionId: string,
		files: string,
		organizationId = "fictional-harbor",
		filesSha256: string | null = null,
	) =>
		sqlite
			.prepare(
				"INSERT INTO os_gadget_code (revision_id, organization_id, gadget_id, files, code_length, files_sha256, created_at) VALUES (?,?,?,?,?,?,'2026-11-11 10:00:00')",
			)
			.run(
				revisionId,
				organizationId,
				`app-${revisionId}`,
				filesSha256 ? "" : files,
				files.length,
				filesSha256,
			);
	const rows = () =>
		sqlite
			.prepare(
				"SELECT revision_id, length(files) AS inline_length, files_sha256 FROM os_gadget_code ORDER BY rowid",
			)
			.all() as {
			revision_id: string;
			inline_length: number;
			files_sha256: string | null;
		}[];
	const blobs = () =>
		sqlite
			.prepare(
				"SELECT organization_id, sha256, files, code_length FROM os_gadget_code_blobs ORDER BY organization_id, sha256",
			)
			.all();
	const tick = (
		limits: Parameters<typeof runGadgetCodeDedupeTick>[0]["limits"] = {},
	) =>
		runGadgetCodeDedupeTick({
			db,
			bucket,
			now: new Date("2026-11-11T20:00:00.000Z"),
			limits: { rowPauseMs: 0, ...limits },
		});
	/** Tick until the pass ends; returns the final tick. */
	const drain = async (
		limits?: Parameters<typeof runGadgetCodeDedupeTick>[0]["limits"],
	) => {
		for (let guard = 0; guard < 50; guard++) {
			const result = await tick(limits);
			if (result.status !== "swept") return result;
		}
		throw new Error("Pass did not finish");
	};
	return {
		db,
		sqlite,
		fault,
		objects,
		json,
		arm,
		seed,
		rows,
		blobs,
		tick,
		drain,
	};
}

/** Three editor copies and one custom app in Harbor, one editor copy in Ridge. */
async function seedLegacy(f: ReturnType<typeof fixture>) {
	const editorSha = await osGadgetCodeSha256(editor);
	f.seed("a", editor);
	f.seed("b", editor);
	f.seed("c", custom);
	f.seed("ridge", editor, "fictional-ridge");
	f.seed("d", editor);
	return editorSha;
}

const legacyBytes = 4 * bytes(editor) + bytes(custom);
const blobBytes = 2 * bytes(editor) + bytes(custom);

describe("gadget code dedupe tick", () => {
	it("does nothing until an operator arms it", async () => {
		const f = fixture();
		await seedLegacy(f);
		expect(await f.tick()).toMatchObject({ status: "off", mode: "off" });
		expect(f.fault.statements).toEqual([]);
		expect(f.objects.size).toBe(0);
	});

	it("dry run reports what an apply pass would reclaim and writes nothing to D1", async () => {
		const f = fixture();
		await seedLegacy(f);
		const before = f.rows();
		await f.arm("dry_run");
		const first = await f.tick({ maxRows: 2 });
		expect(first).toMatchObject({
			status: "swept",
			mode: "dry_run",
			cursor: 2,
			tick: { legacyRows: 2, blobsAdded: 1, rowsCleared: 2 },
		});
		const done = await f.drain({ maxRows: 2 });
		expect(done).toMatchObject({
			status: "completed",
			mode: "dry_run",
			pass: {
				legacyRows: 5,
				inlineBytes: legacyBytes,
				blobsAdded: 3,
				blobBytesAdded: blobBytes,
				rowsCleared: 5,
				bytesCleared: legacyBytes,
			},
			passBytesReclaimed: legacyBytes - blobBytes,
			skipped: [],
		});
		expect(f.json(done.reportKey!)).toMatchObject({
			mode: "dry_run",
			legacyRows: 5,
			blobsAdded: 3,
			bytesReclaimed: legacyBytes - blobBytes,
		});
		expect(f.rows()).toEqual(before);
		expect(f.blobs()).toEqual([]);
		expect(
			f.fault.statements.filter((query) => !/^select/i.test(query)),
		).toEqual([]);
		// The pass turned itself off.
		expect(f.json(GADGET_CODE_DEDUPE_STATE_KEY)).toMatchObject({
			mode: "off",
			lastReportKey: done.reportKey,
		});
		expect(await f.tick()).toMatchObject({ status: "off" });
	});

	it("applies in paced ticks, keeps every reader whole and changes nothing on a rerun", async () => {
		const f = fixture();
		const editorSha = await seedLegacy(f);
		// A row written by the new path is left alone.
		await f.db.insert(osGadgetCodeBlobs).values({
			organizationId: "fictional-harbor",
			sha256: editorSha,
			files: editor,
			codeLength: editor.length,
		});
		f.seed("new", editor, "fictional-harbor", editorSha);
		await f.arm("apply");
		const first = await f.tick({ maxRows: 2 });
		expect(first).toMatchObject({
			status: "swept",
			cursor: 2,
			tick: { rowsCleared: 2, blobsAdded: 0 },
		});
		expect(f.rows().map((row) => row.inline_length)).toEqual([
			0,
			0,
			custom.length,
			editor.length,
			editor.length,
			0,
		]);
		const done = await f.drain({ maxRows: 2 });
		expect(done).toMatchObject({
			status: "completed",
			mode: "apply",
			pass: {
				legacyRows: 5,
				rowsCleared: 5,
				bytesCleared: legacyBytes,
				// Harbor already had the editor blob; custom and Ridge's are new.
				blobsAdded: 2,
				blobBytesAdded: bytes(custom) + bytes(editor),
			},
			skipped: [],
		});
		expect(f.rows().every((row) => row.inline_length === 0)).toBe(true);
		expect(f.rows().every((row) => row.files_sha256?.length === 64)).toBe(true);
		expect(f.blobs()).toHaveLength(3);
		for (const [revisionId, organizationId, files] of [
			["a", "fictional-harbor", editor],
			["c", "fictional-harbor", custom],
			["ridge", "fictional-ridge", editor],
		] as const)
			expect(
				await getOsGadgetCode(f.db, { organizationId, revisionId }),
			).toMatchObject({ files, codeLength: files.length });
		// Another organization's identical blob does not serve this row.
		expect(
			await getOsGadgetCode(f.db, {
				organizationId: "fictional-harbor",
				revisionId: "ridge",
			}),
		).toBeUndefined();

		const after = { rows: f.rows(), blobs: f.blobs() };
		await f.arm("apply");
		expect(await f.drain()).toMatchObject({
			status: "completed",
			pass: { legacyRows: 0, rowsCleared: 0, blobsAdded: 0 },
		});
		expect({ rows: f.rows(), blobs: f.blobs() }).toEqual(after);
	});

	it("stops the tick when the database is busy and resumes from the same row", async () => {
		const f = fixture();
		await seedLegacy(f);
		await f.arm("apply");
		f.fault.failOn = "update";
		const busy = await f.tick();
		expect(busy).toMatchObject({
			status: "swept",
			stoppedBy: "database_busy",
			cursor: 0,
			tick: { rowsCleared: 0 },
		});
		// One update was attempted, then nothing more.
		expect(
			f.fault.statements.filter((query) => /^update/i.test(query)),
		).toHaveLength(1);
		expect(f.rows().every((row) => row.files_sha256 === null)).toBe(true);
		f.fault.failOn = null;
		expect(await f.drain()).toMatchObject({
			status: "completed",
			pass: { rowsCleared: 5 },
		});
		expect(f.rows().every((row) => row.inline_length === 0)).toBe(true);
	});

	it("never clears a row whose blob does not match, and skips it after three tries", async () => {
		const f = fixture();
		const editorSha = await seedLegacy(f);
		await f.db.insert(osGadgetCodeBlobs).values({
			organizationId: "fictional-ridge",
			sha256: editorSha,
			files: "not the editor",
			codeLength: 1,
		});
		await f.arm("apply");
		const done = await f.drain();
		expect(done).toMatchObject({
			status: "completed",
			pass: { rowsCleared: 4 },
			skipped: [{ revisionId: "ridge", reason: "reference_failed" }],
		});
		expect(f.rows().find((row) => row.revision_id === "ridge")).toEqual({
			revision_id: "ridge",
			inline_length: editor.length,
			files_sha256: null,
		});
	});
});
