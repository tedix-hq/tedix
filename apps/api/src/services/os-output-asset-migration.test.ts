import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { osOutputRevisions, osOutputs } from "@tedix/db/schema/os-workspaces";
import { organizations } from "@tedix/db/schema/organizations";
import { workspaceOutputIndex } from "@tedix/db/schema/workspace-feed";
import { getOsOutputRevision } from "@tedix/db/queries/os-workspaces/outputs";
import {
	hydrateOutputRevision,
	storeOutputRevisionBody,
} from "./os-output-revision-body-store";
import {
	OUTPUT_ASSET_MIGRATION_STATE_KEY,
	runOutputAssetMigrationTick,
} from "./os-output-asset-migration";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

const ORG = "fictional-harbor";
const picture = (fill: number) =>
	`data:image/png;base64,${Buffer.alloc(3_000, fill).toString("base64")}`;
const deck = (...sources: string[]) =>
	JSON.stringify({
		kind: "presentation",
		slides: [],
		deck: {
			activeSlideId: "s1",
			slides: [
				{
					id: "s1",
					name: "One",
					elements: sources.map((src, index) => ({
						id: `e${index}`,
						type: "image",
						src,
					})),
				},
			],
		},
	});
const sources = (content: string): string[] =>
	JSON.parse(content).deck.slides[0].elements.map(
		(element: { src: string }) => element.src,
	);

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec(
		schemaDdl(
			organizations,
			osOutputs,
			osOutputRevisions,
			workspaceOutputIndex,
		),
	);
	sqlite
		.prepare("INSERT INTO organizations(id,name,slug) VALUES (?,?,?)")
		.run(ORG, "Harbor", "harbor");
	const db = createDbQueryClient(
		createD1Facade(sqlite, { maxBoundParams: 100 }),
	);
	const objects = new Map<string, { bytes: ArrayBuffer; type?: string }>();
	const bucket = {
		async put(
			key: string,
			bytes: ArrayBuffer,
			options?: { httpMetadata?: { contentType?: string } },
		) {
			objects.set(key, { bytes, type: options?.httpMetadata?.contentType });
		},
		async get(key: string) {
			const object = objects.get(key);
			return object
				? {
						arrayBuffer: async () => object.bytes,
						httpMetadata: { contentType: object.type },
					}
				: null;
		},
		async head(key: string) {
			return objects.has(key) ? { key } : null;
		},
	};
	const person = {
		createdByKind: "user" as const,
		createdById: "fictional-person",
	};
	async function output(id: string, kind: "presentation" | "sheet") {
		await db
			.insert(osOutputs)
			.values({ ...person, id, organizationId: ORG, title: id, kind });
	}
	/** A revision this database owns: `inline` keeps the body in the row. */
	async function revision(id: string, content: string, inline = false) {
		const body = await storeOutputRevisionBody(bucket, ORG, content);
		await db.insert(osOutputRevisions).values({
			...person,
			id: `${id}-r1`,
			organizationId: ORG,
			outputId: id,
			revision: 1,
			content: inline ? content : "",
			...(inline ? {} : body),
		});
		return body;
	}
	async function index(
		id: string,
		body: Awaited<ReturnType<typeof storeOutputRevisionBody>>,
	) {
		await db.insert(workspaceOutputIndex).values({
			id: `${id}:1`,
			organizationId: ORG,
			workspaceId: "workspace-1",
			outputId: id,
			revision: 1,
			revisionId: `${id}-r1`,
			isCurrent: 1,
			outputKind: "presentation",
			title: id,
			status: "active",
			outputCreatedByKind: "user",
			outputCreatedById: "fictional-person",
			outputCreatedAt: "2026-11-01T00:00:00.000Z",
			revisionCreatedByKind: "user",
			revisionCreatedById: "fictional-person",
			revisionCreatedAt: "2026-11-01T00:00:00.000Z",
			updatedAt: "2026-11-01T00:00:00.000Z",
			...body,
		});
	}
	const indexRow = (id: string) =>
		sqlite
			.prepare(
				"SELECT content_sha256, content_bytes, body_r2_key FROM workspace_output_index WHERE id=?",
			)
			.get(`${id}:1`) as {
			content_sha256: string;
			content_bytes: number;
			body_r2_key: string;
		};
	const read = async (id: string) =>
		(
			await hydrateOutputRevision(
				(await getOsOutputRevision(db, {
					organizationId: ORG,
					revisionId: `${id}-r1`,
				}))!,
				bucket,
			)
		).content;
	const json = (key: string) =>
		JSON.parse(new TextDecoder().decode(objects.get(key)!.bytes));
	const assets = () =>
		[...objects.keys()].filter((key) => key.startsWith("os-output-assets/"));
	/** What an operator writes to start a run. */
	const start = (state: Record<string, unknown> = {}) =>
		bucket.put(
			OUTPUT_ASSET_MIGRATION_STATE_KEY,
			new TextEncoder().encode(
				JSON.stringify({ version: 1, phase: "shared", cursor: 0, ...state }),
			).buffer as ArrayBuffer,
		);
	return {
		start,
		db,
		sqlite,
		bucket,
		objects,
		output,
		revision,
		index,
		indexRow,
		read,
		json,
		assets,
	};
}

const t0 = new Date("2026-11-12T07:00:00.000Z");

describe("stored image migration tick", () => {
	it("rewrites embedded bodies this database owns, moves their index rows and finishes once", async () => {
		const f = fixture();
		await f.start();
		const one = picture(1);
		const two = picture(2);
		await f.output("offloaded", "presentation");
		const before = await f.revision("offloaded", deck(one, two, one));
		await f.index("offloaded", before);
		await f.output("inline", "presentation");
		await f.revision("inline", deck(one), true);
		await f.output("plain", "presentation");
		const plain = await f.revision("plain", deck("https://example.org/a.png"));
		await f.output("numbers", "sheet");
		await f.revision("numbers", '{"kind":"sheet","columns":[],"rows":[]}');

		const first = await runOutputAssetMigrationTick({
			db: f.db,
			bucket: f.bucket,
			now: t0,
		});
		expect(first).toMatchObject({
			status: "swept",
			scanned: 3,
			rewritten: 2,
			failures: [],
			phase: "objects",
			cursor: 0,
		});
		const [a, b, c] = sources(await f.read("offloaded"));
		expect(a).toMatch(/^tedix-asset:[a-f0-9]{64}$/);
		expect(b).toMatch(/^tedix-asset:[a-f0-9]{64}$/);
		expect(c).toBe(a);
		expect(b).not.toBe(a);
		// The same picture in another file is that file's own image.
		expect(sources(await f.read("inline"))).toEqual([a]);
		expect(f.assets().sort()).toEqual(
			[
				`os-output-assets/v1/${ORG}/offloaded/${a!.slice(12)}`,
				`os-output-assets/v1/${ORG}/offloaded/${b!.slice(12)}`,
				`os-output-assets/v1/${ORG}/inline/${a!.slice(12)}`,
			].sort(),
		);
		const after = (await getOsOutputRevision(f.db, {
			organizationId: ORG,
			revisionId: "offloaded-r1",
		}))!;
		expect(after.content).toBe("");
		expect(after.contentSha256).not.toBe(before.contentSha256);
		expect(after.contentBytes).toBeLessThan(1_000);
		expect(f.indexRow("offloaded")).toEqual({
			content_sha256: after.contentSha256,
			content_bytes: after.contentBytes,
			body_r2_key: after.bodyR2Key,
		});
		// The previous body is left for the body sweep, and untouched files stay as they were.
		expect(f.objects.has(before.bodyR2Key)).toBe(true);
		expect(
			(await getOsOutputRevision(f.db, {
				organizationId: ORG,
				revisionId: "plain-r1",
			}))!.contentSha256,
		).toBe(plain.contentSha256);
		expect(f.json(first.receiptKey!)).toMatchObject({
			phase: "shared",
			scanned: 3,
			rewritten: 2,
		});

		const second = await runOutputAssetMigrationTick({
			db: f.db,
			bucket: f.bucket,
			now: t0,
		});
		expect(second).toMatchObject({ status: "swept", phase: "done" });
		const puts = f.objects.size;
		expect(
			await runOutputAssetMigrationTick({
				db: f.db,
				bucket: f.bucket,
				now: t0,
			}),
		).toMatchObject({ status: "done", scanned: 0, rewritten: 0 });
		expect(f.objects.size).toBe(puts);
		expect(f.json(OUTPUT_ASSET_MIGRATION_STATE_KEY)).toMatchObject({
			phase: "done",
			completedAt: t0.toISOString(),
			totals: { scanned: 3, rewritten: 2, failures: 0 },
		});
	});

	it("does nothing until an operator starts it, and a dry run only counts", async () => {
		const f = fixture();
		f.objects.delete(OUTPUT_ASSET_MIGRATION_STATE_KEY);
		const one = picture(1);
		await f.output("deck", "presentation");
		const before = await f.revision("deck", deck(one, picture(2), one));
		await f.output("plain", "presentation");
		await f.revision("plain", deck("https://example.org/a.png"));
		const stored = new Map(f.objects);
		const tick = () =>
			runOutputAssetMigrationTick({ db: f.db, bucket: f.bucket, now: t0 });
		expect(await tick()).toMatchObject({
			status: "not_started",
			scanned: 0,
			rewritten: 0,
		});
		expect(f.objects).toEqual(stored);

		await f.start({ dryRun: true });
		expect(await tick()).toMatchObject({
			status: "swept",
			dryRun: true,
			scanned: 2,
			rewritten: 1,
			embeddedBytes: one.length + picture(2).length,
			receiptKey: null,
		});
		expect(await tick()).toMatchObject({ phase: "done" });
		expect(await tick()).toMatchObject({ status: "done", dryRun: true });
		expect(f.json(OUTPUT_ASSET_MIGRATION_STATE_KEY)).toMatchObject({
			dryRun: true,
			phase: "done",
			totals: {
				scanned: 2,
				rewritten: 1,
				embeddedBytes: one.length + picture(2).length,
				failures: 0,
			},
		});
		// Only the state object was written: no image, no body, no pointer.
		expect([...f.objects.keys()].sort()).toEqual(
			[...stored.keys(), OUTPUT_ASSET_MIGRATION_STATE_KEY].sort(),
		);
		expect(
			(await getOsOutputRevision(f.db, {
				organizationId: ORG,
				revisionId: "deck-r1",
			}))!.contentSha256,
		).toBe(before.contentSha256);

		// A fresh state without `dryRun` is the real run.
		await f.start();
		expect(await tick()).toMatchObject({ dryRun: false, rewritten: 1 });
		expect(sources(await f.read("deck"))[0]).toMatch(/^tedix-asset:/);
	});

	it("leaves a body whose image the checks refuse and names it in the receipt", async () => {
		const f = fixture();
		await f.start();
		const unsafe = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg"><script>1</script>${" ".repeat(2_100)}</svg>`)}`;
		await f.output("unsafe", "presentation");
		const before = await f.revision("unsafe", deck(unsafe));
		const tick = await runOutputAssetMigrationTick({
			db: f.db,
			bucket: f.bucket,
			now: t0,
		});
		expect(tick.failures).toEqual([
			{ revisionId: "unsafe-r1", reason: "image_refused" },
		]);
		expect(sources(await f.read("unsafe"))).toEqual([unsafe]);
		expect(
			(await getOsOutputRevision(f.db, {
				organizationId: ORG,
				revisionId: "unsafe-r1",
			}))!.contentSha256,
		).toBe(before.contentSha256);
		expect(f.assets()).toEqual([]);
		expect(JSON.stringify(f.json(tick.receiptKey!))).not.toContain("svg");
	});

	it("walks in bounded steps and stops while paused", async () => {
		const f = fixture();
		await f.start();
		for (const id of ["a", "b", "c"]) {
			await f.output(id, "presentation");
			await f.revision(id, deck(picture(id.charCodeAt(0))));
		}
		const tick = () =>
			runOutputAssetMigrationTick({
				db: f.db,
				bucket: f.bucket,
				now: t0,
				limits: { maxRows: 2 },
			});
		expect(await tick()).toMatchObject({
			phase: "shared",
			cursor: 2,
			rewritten: 2,
		});
		const state = f.json(OUTPUT_ASSET_MIGRATION_STATE_KEY);
		await f.bucket.put(
			OUTPUT_ASSET_MIGRATION_STATE_KEY,
			new TextEncoder().encode(JSON.stringify({ ...state, paused: true }))
				.buffer as ArrayBuffer,
		);
		expect(await tick()).toMatchObject({ status: "paused", rewritten: 0 });
		expect(sources(await f.read("c"))[0]).toMatch(/^data:/);
		await f.bucket.put(
			OUTPUT_ASSET_MIGRATION_STATE_KEY,
			new TextEncoder().encode(JSON.stringify(state)).buffer as ArrayBuffer,
		);
		expect(await tick()).toMatchObject({ phase: "objects", rewritten: 1 });
		expect(sources(await f.read("c"))[0]).toMatch(/^tedix-asset:/);
	});

	it("rewrites a body a workspace object owns through the object and then its index row", async () => {
		const f = fixture();
		await f.start();
		const before = await storeOutputRevisionBody(
			f.bucket,
			ORG,
			deck(picture(9)),
		);
		await f.index("owned", before);
		// Owned here too: the first pass handles it, the second must skip it.
		await f.output("shared", "presentation");
		await f.index("shared", await f.revision("shared", deck(picture(8))));
		let held = before.contentSha256;
		const outputQuery = vi.fn(async (_scope: unknown, query: any) => {
			if (query.op === "revision") return { contentSha256: held };
			if (query.previousSha256 !== held) return false;
			held = query.contentSha256;
			return true;
		});
		const tick = () =>
			runOutputAssetMigrationTick({
				db: f.db,
				bucket: f.bucket,
				runtime: { outputQuery } as never,
				now: t0,
			});
		expect(await tick()).toMatchObject({ phase: "objects", rewritten: 1 });
		expect(outputQuery).not.toHaveBeenCalled();
		expect(await tick()).toMatchObject({
			phase: "done",
			scanned: 1,
			rewritten: 1,
			failures: [],
		});
		expect(outputQuery).toHaveBeenCalledExactlyOnceWith(
			{ organizationId: ORG, workspaceId: "workspace-1" },
			expect.objectContaining({
				op: "rebody",
				revisionId: "owned-r1",
				previousSha256: before.contentSha256,
			}),
		);
		const row = f.indexRow("owned");
		expect(row.content_sha256).toBe(held);
		expect(row.content_sha256).not.toBe(before.contentSha256);
		const body = await hydrateOutputRevision(
			{
				organizationId: ORG,
				content: "",
				contentSha256: row.content_sha256,
				contentBytes: row.content_bytes,
				bodyR2Key: row.body_r2_key,
			} as never,
			f.bucket,
		);
		expect(sources(body.content)[0]).toMatch(/^tedix-asset:/);
		expect(f.assets()).toContain(
			`os-output-assets/v1/${ORG}/owned/${sources(body.content)[0]!.slice(12)}`,
		);
	});

	it("finishes the index row when an earlier tick moved the object and stopped", async () => {
		const f = fixture();
		await f.start();
		const before = await storeOutputRevisionBody(
			f.bucket,
			ORG,
			deck(picture(7)),
		);
		await f.index("owned", before);
		const moved: { sha?: string } = {};
		const runtime = {
			outputQuery: vi.fn(async (_scope: unknown, query: any) => {
				if (query.op === "revision") return { contentSha256: moved.sha };
				// The object already holds the rewritten body.
				moved.sha = query.contentSha256;
				return false;
			}),
		};
		await runOutputAssetMigrationTick({
			db: f.db,
			bucket: f.bucket,
			now: t0,
		});
		expect(
			await runOutputAssetMigrationTick({
				db: f.db,
				bucket: f.bucket,
				runtime: runtime as never,
				now: t0,
			}),
		).toMatchObject({ rewritten: 1, failures: [] });
		expect(f.indexRow("owned").content_sha256).toBe(moved.sha);
		// Without the workspace objects nothing is repointed.
		const g = fixture();
		await g.start();
		const kept = await storeOutputRevisionBody(g.bucket, ORG, deck(picture(6)));
		await g.index("owned", kept);
		await runOutputAssetMigrationTick({ db: g.db, bucket: g.bucket, now: t0 });
		expect(
			(
				await runOutputAssetMigrationTick({
					db: g.db,
					bucket: g.bucket,
					now: t0,
				})
			).failures,
		).toEqual([
			{ revisionId: "owned-r1", reason: "workspace_object_unavailable" },
		]);
		expect(g.indexRow("owned").content_sha256).toBe(kept.contentSha256);
	});
});
