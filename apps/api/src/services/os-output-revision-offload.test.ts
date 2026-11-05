import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { osOutputRevisions, osOutputs } from "@tedix/db/schema/os-workspaces";
import { organizations } from "@tedix/db/schema/organizations";
import { getOsOutputRevision } from "@tedix/db/queries/os-workspaces/outputs";
import {
	hydrateOutputRevision,
	outputRevisionBodyKey,
	storeOutputRevisionBody,
} from "./os-output-revision-body-store";
import {
	OUTPUT_BODY_OFFLOAD_STATE_KEY,
	runOutputRevisionBodyOffloadTick,
} from "./os-output-revision-offload";

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
	const bucket = {
		puts: [] as string[],
		async put(key: string, value: ArrayBuffer) {
			bucket.puts.push(key);
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
		pointer?: Partial<{
			bodyR2Key: string;
			contentSha256: string;
			contentBytes: number;
		}>,
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
			...pointer,
		});
	}
	const row = (id: string) =>
		sqlite
			.prepare(
				"SELECT content, body_r2_key, content_sha256, content_bytes FROM os_output_revisions WHERE id=?",
			)
			.get(id)! as {
			content: string;
			body_r2_key: string | null;
			content_sha256: string | null;
			content_bytes: number | null;
		};
	const json = (key: string) =>
		JSON.parse(new TextDecoder().decode(objects.get(key)));
	const tick = (
		now: Date,
		limits?: Parameters<typeof runOutputRevisionBodyOffloadTick>[0]["limits"],
	) => runOutputRevisionBodyOffloadTick({ db, bucket, now, limits });
	return { db, sqlite, objects, bucket, seed, row, json, tick };
}

const t0 = new Date("2026-11-05T07:00:00.000Z");
const later = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

describe("output revision body offload tick", () => {
	it("moves inline bodies to R2, verifies them, clears D1 and keeps readers whole", async () => {
		const f = fixture();
		const body = "﻿Grüße 🌍\r\n  ";
		await f.seed("a", body);
		await f.seed("foreign", '{"kind":"document"}', "fictional-ridge");
		// Already pointed by the earlier backfill but still inline.
		const stored = await storeOutputRevisionBody(
			f.bucket,
			"fictional-harbor",
			"pointed",
		);
		await f.seed("pointed", "pointed", "fictional-harbor", stored);
		// A legacy empty body has nothing to move and must stay readable.
		await f.seed("empty", "");

		const first = await f.tick(t0, { maxRows: 2 });
		expect(first).toMatchObject({
			status: "swept",
			candidates: 2,
			rowsCleared: 2,
			failures: [],
			cursor: 2,
			maxRowid: 4,
		});
		expect(f.row("a")).toEqual({
			content: "",
			body_r2_key: outputRevisionBodyKey(
				"fictional-harbor",
				(await storeOutputRevisionBody(f.bucket, "fictional-harbor", body))
					.contentSha256,
			),
			content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			content_bytes: new TextEncoder().encode(body).byteLength,
		});
		expect(f.row("foreign").body_r2_key).toContain("/fictional-ridge/");
		expect(f.row("pointed").content).toBe("pointed");
		// The receipt and the resumable cursor are durable.
		expect(f.json(first.receiptKey!)).toMatchObject({
			after: 0,
			through: 4,
			cursor: 2,
			rowsCleared: 2,
			bytesCleared: new TextEncoder().encode(body).byteLength + 19,
		});
		expect(f.json(OUTPUT_BODY_OFFLOAD_STATE_KEY)).toMatchObject({
			cursor: 2,
			passes: 0,
			totals: { rowsCleared: 2, failures: 0 },
		});

		const second = await f.tick(later(2), { maxRows: 2 });
		expect(second).toMatchObject({
			status: "swept",
			candidates: 1,
			rowsCleared: 1,
			cursor: 4,
			passes: 1,
			summary: { rows: 4, inlineRows: 0, pointerMissing: 1 },
		});
		expect(f.row("pointed")).toMatchObject({
			content: "",
			body_r2_key: stored.bodyR2Key,
		});
		expect(f.row("empty")).toMatchObject({ content: "", body_r2_key: null });

		// Readers hydrate the moved body byte for byte, and the empty legacy row.
		for (const [id, expected] of [
			["a", body],
			["pointed", "pointed"],
			["empty", ""],
		] as const) {
			const hydrated = await hydrateOutputRevision(
				(await getOsOutputRevision(f.db, {
					organizationId: "fictional-harbor",
					revisionId: id,
				}))!,
				f.bucket,
			);
			expect(hydrated.content).toBe(expected);
		}

		// The pass is complete: the tick idles until the pause elapses, then
		// rescans from the start and finds nothing inline.
		expect(await f.tick(later(4))).toMatchObject({ status: "idle" });
		expect(await f.tick(later(70))).toMatchObject({
			status: "swept",
			candidates: 0,
			cursor: 4,
			passes: 2,
		});
	});

	it("records a disagreeing pointer as a failure, leaves the row intact and retries next pass", async () => {
		const f = fixture();
		await f.seed("bad", "bytes", "fictional-harbor", {
			bodyR2Key: outputRevisionBodyKey("fictional-harbor", "0".repeat(64)),
			contentSha256: "0".repeat(64),
			contentBytes: 5,
		});
		await f.seed("good", "fine");
		const first = await f.tick(t0);
		expect(first).toMatchObject({
			rowsCleared: 1,
			failures: [{ id: "bad", rowid: 1, reason: "pointer_failed" }],
			cursor: 2,
			passes: 1,
		});
		expect(f.row("bad")).toMatchObject({
			content: "bytes",
			content_sha256: "0".repeat(64),
		});
		expect(f.json(OUTPUT_BODY_OFFLOAD_STATE_KEY)).toMatchObject({
			totals: { rowsCleared: 1, failures: 1 },
		});
		// The next pass sees it again instead of forgetting it.
		const retry = await f.tick(later(90));
		expect(retry.failures).toEqual([
			{ id: "bad", rowid: 1, reason: "pointer_failed" },
		]);
	});

	it("stops at the byte budget, resumes after the last moved row and honours the pause switch", async () => {
		const f = fixture();
		for (const id of ["one", "two", "three"]) await f.seed(id, id.repeat(10));
		const first = await f.tick(t0, { maxBytes: 25 });
		expect(first).toMatchObject({ rowsCleared: 1, cursor: 1 });
		expect(f.row("two").content).toBe("two".repeat(10));
		const second = await f.tick(later(2), { maxBytes: 25 });
		expect(second).toMatchObject({ rowsCleared: 1, cursor: 2 });
		await f.bucket.put(
			OUTPUT_BODY_OFFLOAD_STATE_KEY,
			await new Blob([
				JSON.stringify({
					...f.json(OUTPUT_BODY_OFFLOAD_STATE_KEY),
					paused: true,
				}),
			]).arrayBuffer(),
		);
		expect(await f.tick(later(4))).toMatchObject({
			status: "paused",
			cursor: 2,
		});
		expect(f.row("three").content).toBe("three".repeat(10));
	});

	it("resumes a window that held more inline rows than one tick moves", async () => {
		const f = fixture();
		for (const id of ["r1", "r2", "r3", "r4", "r5"]) await f.seed(id, id);
		const first = await f.tick(t0, { maxRows: 2 });
		expect(first).toMatchObject({ rowsCleared: 2, cursor: 2 });
		const second = await f.tick(later(2), { maxRows: 2 });
		expect(second).toMatchObject({ rowsCleared: 2, cursor: 4 });
		const third = await f.tick(later(4), { maxRows: 2 });
		expect(third).toMatchObject({ rowsCleared: 1, cursor: 5, passes: 1 });
		expect(
			f.sqlite
				.prepare(
					"SELECT count(*) AS n FROM os_output_revisions WHERE content <> ''",
				)
				.get(),
		).toEqual({ n: 0 });
	});
});
