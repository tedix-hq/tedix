import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { OS_OUTPUT_AUTOSAVE_NOTE } from "@tedix/api-contract/utils/os-output-limits";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	osOutputRevisions,
	osOutputs,
	osWorkspaces,
} from "@tedix/db/schema/os-workspaces";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createDurableSqliteFixture } from "@tedix/db/test/durable-sqlite-fixture";
import { createTenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import {
	executeOutputQuery,
	type WorkspaceOutputRuntime,
} from "@tedix/db/queries/durable-sqlite/output-rpc";
import { unreferencedObjectOutputRevisions } from "@tedix/db/queries/os-workspaces/output-revision-thinning";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	OUTPUT_THINNING_STATE_KEY,
	runOutputRevisionThinningTick,
	type OutputThinningMode,
} from "./os-output-revision-thinning";

const DAY = "2026-11-11";
const now = new Date(`${DAY}T14:00:00.000Z`);

function createFixture(
	options: { failRead?: () => Error | null; objectOwned?: boolean } = {},
) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("CREATE TABLE organizations (id TEXT PRIMARY KEY);");
	sqlite.exec(schemaDdl(osWorkspaces, osOutputs, osOutputRevisions));
	// The tables that may point at a revision, with the columns the check reads.
	sqlite.exec(`
		CREATE TABLE workspace_output_index (id TEXT PRIMARY KEY, revision INTEGER, revision_id TEXT, is_current INTEGER, organization_id TEXT, workspace_id TEXT, output_id TEXT, revision_created_by_kind TEXT, revision_created_by_id TEXT, revision_created_at TEXT, skill_run_id TEXT, note TEXT, content_bytes INTEGER);
		CREATE TABLE workspace_activity (entity_id TEXT, revision INTEGER, change_record_id TEXT);
		CREATE TABLE os_share_links (pinned_revision_id TEXT);
		CREATE TABLE os_collaboration_proposals (base_revision_id TEXT, result_revision_id TEXT);
		CREATE TABLE kernel_runtime_runs (output_revision_id TEXT);
		CREATE TABLE os_review_batches (source_revision_id TEXT);
		CREATE TABLE work_evidence (uri TEXT);
		INSERT INTO organizations VALUES ('org-1');
	`);
	const revisionSqlite = options.objectOwned
		? new DatabaseSync(":memory:")
		: sqlite;
	if (options.objectOwned) {
		revisionSqlite.exec(
			"CREATE TABLE organizations (id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org-1');",
		);
		revisionSqlite.exec(schemaDdl(osWorkspaces, osOutputs, osOutputRevisions));
	}
	const tenant = createTenantStoreDb(
		createDurableSqliteFixture(revisionSqlite),
	);
	const runtime: Pick<WorkspaceOutputRuntime, "outputQuery"> = {
		outputQuery: (async (scope, query) =>
			query.op === "authority"
				? "object"
				: executeOutputQuery(
						tenant,
						scope,
						query.op === "thin"
							? {
									...query,
									revisionIds: await unreferencedObjectOutputRevisions(
										db,
										{ ...scope, outputId: query.outputId },
										query.revisionIds,
									),
								}
							: query,
					)) as WorkspaceOutputRuntime["outputQuery"],
	};
	const facade = createD1Facade(sqlite);
	const d1 = options.failRead
		? ({
				...facade,
				prepare(query: string) {
					const error = /^\s*select/i.test(query) ? options.failRead!() : null;
					if (error) throw error;
					return facade.prepare(query);
				},
				batch: facade.batch.bind(facade),
			} as typeof facade)
		: facade;
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
	const arm = (mode: OutputThinningMode) =>
		bucket.put(
			OUTPUT_THINNING_STATE_KEY,
			new TextEncoder().encode(JSON.stringify({ version: 1, mode }))
				.buffer as ArrayBuffer,
		);
	const json = (key: string) =>
		JSON.parse(new TextDecoder().decode(objects.get(key)));
	const file = (outputId: string, currentRevisionId: string) =>
		revisionSqlite
			.prepare(
				"INSERT INTO os_outputs (id, organization_id, workspace_id, kind, title, status, current_revision_id, created_by_kind, created_by_id, created_at, updated_at) VALUES (?, 'org-1', 'ws-1', 'document', 'Notes', 'active', ?, 'user', 'u1', ?, ?)",
			)
			.run(outputId, currentRevisionId, `${DAY}T12:00:00.000Z`, DAY);
	let number = 0;
	/** One revision; `at` is a time of day, `by` a person or `agent`. */
	const save = (
		id: string,
		at: string,
		row: {
			outputId?: string;
			by?: string;
			note?: string | null;
			skillRunId?: string;
		} = {},
	) => {
		const by = row.by ?? "u1";
		revisionSqlite
			.prepare(
				"INSERT INTO os_output_revisions (id, organization_id, output_id, revision, content, note, created_by_kind, created_by_id, created_at, skill_run_id, content_sha256, content_bytes, body_r2_key) VALUES (?, 'org-1', ?, ?, '', ?, ?, ?, ?, ?, ?, 100, ?)",
			)
			.run(
				id,
				row.outputId ?? "file",
				++number,
				row.note === undefined ? OS_OUTPUT_AUTOSAVE_NOTE : row.note,
				by === "agent" ? "tedi" : "user",
				by,
				`${DAY}T${at}.000Z`,
				row.skillRunId ?? null,
				`sha-${id}`,
				`body-${id}`,
			);
		sqlite
			.prepare(
				"INSERT INTO workspace_output_index VALUES (?, ?, ?, 0, 'org-1', 'ws-1', ?, ?, ?, ?, ?, ?, 100)",
			)
			.run(
				`${row.outputId ?? "file"}:${number}`,
				number,
				id,
				row.outputId ?? "file",
				by === "agent" ? "tedi" : "user",
				by,
				`${DAY}T${at}.000Z`,
				row.skillRunId ?? null,
				row.note === undefined ? OS_OUTPUT_AUTOSAVE_NOTE : row.note,
			);
	};
	const kept = (outputId = "file") =>
		(
			revisionSqlite
				.prepare(
					"SELECT id FROM os_output_revisions WHERE output_id = ? ORDER BY revision",
				)
				.all(outputId) as { id: string }[]
		).map((row) => row.id);
	const indexed = () =>
		(
			sqlite
				.prepare(
					"SELECT revision_id FROM workspace_output_index ORDER BY revision",
				)
				.all() as { revision_id: string }[]
		).map((row) => row.revision_id);
	const tick = (at = now, limits = {}) =>
		runOutputRevisionThinningTick({
			db,
			bucket,
			now: at,
			limits,
			runtime: options.objectOwned ? runtime : undefined,
		});
	return {
		sqlite,
		revisionSqlite,
		runtime,
		db,
		bucket,
		arm,
		json,
		file,
		save,
		kept,
		indexed,
		tick,
		objects,
	};
}

/** A morning of editing: who saved what, and when. */
function morning(f: ReturnType<typeof createFixture>) {
	f.file("file", "current");
	f.save("first", "12:00:01", { by: "agent", note: null });
	// 12:00 to 12:10, one person.
	f.save("a1", "12:00:10");
	f.save("a2", "12:01:00");
	f.save("a3", "12:05:00");
	f.save("a4", "12:09:59");
	// 12:10 to 12:20: auto-saves, a save someone asked for, a second person.
	f.save("b1", "12:11:00");
	f.save("b2", "12:15:00");
	f.save("asked", "12:16:00", { note: "Saved from workspace app" });
	f.save("c1", "12:17:00", { by: "u2" });
	f.save("c2", "12:18:00", { by: "u2" });
	f.save("agent", "12:18:30", { by: "agent", note: OS_OUTPUT_AUTOSAVE_NOTE });
	f.save("run", "12:18:40", { skillRunId: "run-1" });
	f.save("b3", "12:19:00");
	// Within the last hour: kept whatever they are.
	f.save("young1", "13:10:00");
	f.save("young2", "13:11:00");
	f.save("current", "13:12:00");
}

describe.each(["shared", "objects"])(
	"thinning auto-save revisions in %s",
	(store) => {
		const fixture = (options: { failRead?: () => Error | null } = {}) =>
			createFixture({ ...options, objectOwned: store === "objects" });
		it("does nothing until an operator arms it", async () => {
			const f = fixture();
			morning(f);
			expect(await f.tick()).toMatchObject({ status: "off" });
			expect(f.kept()).toHaveLength(16);
			expect(f.objects.size).toBe(0);
		});

		it("keeps one auto-save per ten minutes per person after the first hour, and everything that is not an auto-save", async () => {
			const f = fixture();
			morning(f);
			await f.arm("apply");
			const result = await f.tick();
			expect(result).toMatchObject({
				status: "completed",
				mode: "apply",
				tick: { revisions: 6, bytes: 600, files: 1 },
			});
			expect(f.kept()).toEqual([
				"first", // the file's first revision
				"a4", // the last auto-save of 12:00 to 12:10
				"asked", // a save someone asked for
				"c2", // the second person's last auto-save of that window
				"agent", // written by an agent, whatever its note says
				"run", // written by a skill run
				"b3", // the first person's last auto-save of 12:10 to 12:20
				"young1",
				"young2",
				"current",
			]);
			// The index rows of removed revisions went with them; others stayed.
			expect(f.indexed()).toEqual(f.kept());
			// Revision numbers are not reused: the gaps stay, the newest is intact.
			const numbers = f.revisionSqlite
				.prepare(
					"SELECT revision FROM os_output_revisions WHERE output_id = 'file' ORDER BY revision",
				)
				.all()
				.map((row) => (row as { revision: number }).revision);
			expect(numbers).toEqual([1, 5, 8, 10, 11, 12, 13, 14, 15, 16]);
			const report = f.json(result.reportKey!);
			expect(report).toMatchObject({ mode: "apply", revisions: 6, bytes: 600 });
			// A second pass an hour later finds nothing more of that morning.
			expect(await f.tick()).toMatchObject({ status: "waiting" });
			const later = await f.tick(new Date(now.getTime() + 61 * 60_000));
			// By then the last hour's saves have aged; the current revision is the
			// one that stays for their ten minutes.
			expect(later.tick.revisions).toBe(2);
			expect(f.kept().slice(-2)).toEqual(["b3", "current"]);
		});

		it("reports what it would remove in a dry run, removes nothing and turns itself off", async () => {
			const f = fixture();
			morning(f);
			await f.arm("dry_run");
			const result = await f.tick();
			expect(result).toMatchObject({
				status: "completed",
				mode: "dry_run",
				tick: { revisions: 6, bytes: 600 },
			});
			expect(f.kept()).toHaveLength(16);
			expect(f.indexed()).toHaveLength(16);
			expect(f.json(result.reportKey!)).toMatchObject({
				mode: "dry_run",
				revisions: 6,
			});
			expect(f.json(OUTPUT_THINNING_STATE_KEY).mode).toBe("off");
			expect(await f.tick()).toMatchObject({ status: "off" });
		});

		it("keeps every revision something points at", async () => {
			const f = fixture();
			morning(f);
			f.sqlite.exec(`
			INSERT INTO workspace_activity VALUES ('file', 2, 'a1');
			INSERT INTO os_share_links VALUES ('a2');
			INSERT INTO os_collaboration_proposals VALUES ('a3', NULL);
			INSERT INTO os_collaboration_proposals VALUES ('other', 'b1');
			INSERT INTO kernel_runtime_runs VALUES ('b2');
			INSERT INTO os_review_batches VALUES ('c1');
		`);
			await f.arm("apply");
			expect((await f.tick()).tick.revisions).toBe(0);
			expect(f.kept()).toHaveLength(16);
			// Work evidence names a revision by its address or by an export's number.
			const g = fixture();
			morning(g);
			g.sqlite.exec(`
			INSERT INTO work_evidence VALUES ('output://file/revisions/a1');
			INSERT INTO work_evidence VALUES ('/os-exports/file/rev-3.pdf');
		`);
			await g.arm("apply");
			expect((await g.tick()).tick.revisions).toBe(4);
			expect(g.kept()).toEqual(expect.arrayContaining(["a1", "a2"]));
			expect(g.kept()).not.toContain("a3");
		});

		it("never removes a file's current or newest revision, even an old auto-save", async () => {
			const f = fixture();
			// The pointer names an older revision than the newest: both stay.
			f.file("file", "p2");
			f.save("p1", "12:00:00", { note: null });
			f.save("p2", "12:01:00");
			f.save("p3", "12:02:00");
			f.save("p4", "12:03:00");
			await f.arm("apply");
			expect((await f.tick()).tick.revisions).toBe(1);
			expect(f.kept()).toEqual(["p1", "p2", "p4"]);
		});

		it("works through a large history a batch per tick and stops when the database is busy", async () => {
			const f = fixture();
			f.file("file", "current");
			f.save("first", "10:00:00", { note: null });
			for (let index = 0; index < 100; index++)
				f.save(
					`s${index}`,
					`10:0${Math.floor(index / 20)}:${String(index % 20).padStart(2, "0")}`,
				);
			f.save("current", "13:30:00");
			await f.arm("apply");
			const first = await f.tick();
			expect(first).toMatchObject({
				status: "swept",
				stoppedBy: "budget",
				tick: { revisions: 40 },
			});
			expect((await f.tick()).tick.revisions).toBe(40);
			const last = await f.tick();
			expect(last).toMatchObject({
				status: "completed",
				tick: { revisions: 19 },
			});
			expect(f.kept()).toEqual(["first", "s99", "current"]);
			expect(last.pass.revisions).toBe(99);

			let busy = true;
			const g = fixture({
				failRead: () =>
					busy
						? new Error(
								"D1_ERROR: D1 DB is overloaded. Too many requests queued.",
							)
						: null,
			});
			morning(g);
			await g.arm("apply");
			expect(await g.tick()).toMatchObject({
				status: "swept",
				stoppedBy: "database_busy",
				tick: { revisions: 0 },
			});
			expect(g.kept()).toHaveLength(16);
			busy = false;
			expect((await g.tick()).tick.revisions).toBe(6);
		});
	},
);

describe("workspace owner fences", () => {
	it("ignores retained core copies and thins only the authoritative workspace", async () => {
		const f = createFixture({ objectOwned: true });
		morning(f);
		const output = f.revisionSqlite.prepare("SELECT * FROM os_outputs").get()!;
		const keys = Object.keys(output);
		f.sqlite
			.prepare(
				`INSERT INTO os_outputs (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
			)
			.run(...Object.values(output));
		for (const revision of f.revisionSqlite
			.prepare("SELECT * FROM os_output_revisions")
			.all()) {
			const keys = Object.keys(revision);
			f.sqlite
				.prepare(
					`INSERT INTO os_output_revisions (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
				)
				.run(...Object.values(revision));
		}
		await f.arm("apply");
		expect((await f.tick()).tick.revisions).toBe(6);
		expect(
			f.sqlite.prepare("SELECT count(*) AS n FROM os_output_revisions").get(),
		).toMatchObject({ n: 16 });
		expect(f.kept()).toHaveLength(10);
		expect(f.indexed()).toEqual(f.kept());
	});
	it("rechecks pins and current pointers added after candidate discovery", async () => {
		const f = createFixture({ objectOwned: true });
		morning(f);
		const runtime: Pick<WorkspaceOutputRuntime, "outputQuery"> = {
			outputQuery: (async (scope, query) => {
				if (query.op === "thin") {
					f.sqlite.exec("INSERT INTO os_share_links VALUES ('a1')");
					f.revisionSqlite.exec(
						"UPDATE os_outputs SET current_revision_id = 'a2'",
					);
				}
				return f.runtime.outputQuery(scope, query);
			}) as WorkspaceOutputRuntime["outputQuery"],
		};
		await f.arm("apply");
		const result = await runOutputRevisionThinningTick({
			db: f.db,
			bucket: f.bucket,
			now,
			runtime,
		});
		expect(result.tick.revisions).toBe(4);
		expect(f.kept()).toEqual(expect.arrayContaining(["a1", "a2"]));
	});
});

it("does not finish a pass while its workspace store is unavailable", async () => {
	const f = createFixture({ objectOwned: true });
	morning(f);
	await f.arm("apply");
	await expect(
		runOutputRevisionThinningTick({ db: f.db, bucket: f.bucket, now }),
	).rejects.toThrow("Workspace output store unavailable");
	expect(f.kept()).toHaveLength(16);
	expect(f.json(OUTPUT_THINNING_STATE_KEY)).not.toHaveProperty("lastReportKey");
	expect((await f.tick()).tick.revisions).toBe(6);
});
it("resumes an object pass after the owner's database is busy", async () => {
	const f = createFixture({ objectOwned: true });
	morning(f);
	await f.arm("apply");
	const runtime: Pick<WorkspaceOutputRuntime, "outputQuery"> = {
		outputQuery: (async () => {
			throw new Error(
				"D1_ERROR: D1 DB is overloaded. Too many requests queued.",
			);
		}) as WorkspaceOutputRuntime["outputQuery"],
	};
	const failed = await runOutputRevisionThinningTick({
		db: f.db,
		bucket: f.bucket,
		runtime,
		now,
	});
	expect(failed).toMatchObject({
		status: "swept",
		stoppedBy: "database_busy",
		tick: { revisions: 0 },
	});
	expect(f.json(OUTPUT_THINNING_STATE_KEY)).toMatchObject({
		phase: "objects",
		cursor: 0,
	});
	expect((await f.tick()).tick.revisions).toBe(6);
});

it("stops between workspace files at its time budget and resumes without skipping history", async () => {
	const f = createFixture({ objectOwned: true });
	morning(f);
	f.file("second", "second-current");
	f.save("second-first", "12:00:00", { outputId: "second", note: null });
	f.save("second-a", "12:01:00", { outputId: "second" });
	f.save("second-b", "12:02:00", { outputId: "second" });
	f.save("second-current", "13:00:00", { outputId: "second" });
	await f.arm("apply");
	let elapsed = 0;
	const clock = vi.spyOn(Date, "now").mockImplementation(() => elapsed);
	const runtime: Pick<WorkspaceOutputRuntime, "outputQuery"> = {
		outputQuery: (async (scope, query) => {
			const result = await f.runtime.outputQuery(scope, query);
			if (query.op === "thin") elapsed = 2000;
			return result;
		}) as WorkspaceOutputRuntime["outputQuery"],
	};
	try {
		const first = await runOutputRevisionThinningTick({
			db: f.db,
			bucket: f.bucket,
			now,
			runtime,
			limits: { maxMs: 1000 },
		});
		expect(first).toMatchObject({
			status: "swept",
			stoppedBy: "budget",
			tick: { revisions: 6 },
		});
		expect(f.kept("second")).toContain("second-a");
	} finally {
		clock.mockRestore();
	}
	expect((await f.tick()).tick.revisions).toBe(1);
	expect(f.kept("second")).toEqual([
		"second-first",
		"second-b",
		"second-current",
	]);
});
