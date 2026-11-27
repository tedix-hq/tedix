import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import {
	kernelRuntimeEvents,
	kernelRuntimeRuns,
	tediRuntimeEvents,
	tediArtifacts,
	chatDispatchIdempotency,
} from "../schema/cognitive-runtime";
import { workDue } from "../schema/work-due";
import { createD1Facade } from "../test/d1-facade";
import { createPGliteFacade } from "../test/pglite-facade";
import { tableDdl } from "../test/schema-ddl";
import {
	buildInsertKernelRuntimeEventStatement,
	countKernelConversationTitleGuardEvents,
	getKernelRuntimeEventById,
	insertKernelRuntimeEventIfAbsent,
	KernelRuntimeEventConflictError,
	listHomeRunFinishedEvents,
	listKernelRuntimeEvents,
	listTediArtifacts,
	listTediRuntimeEvents,
	updateKernelRuntimeEventMetadata,
} from "./kernel-runtime-events";

// Relative to now: the D1 work_due backfill only queues runs from the last
// seven days, so a fixed date made this test start failing a week later.
const base = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000;
const plus = (minutes: number) =>
	new Date(base + minutes * 60_000).toISOString();
const at = plus(0);
const scope = { organizationId: "org" };
const priorEvents = `
	INSERT INTO tedi_runtime_events(id,organization_id,tedi_id,run_id,kind,runtime_backend,created_at)
	VALUES ('backfill-start','org','tedi','backfill','run.started','custom','${at}'),
	 ('backfill-terminal','org','tedi','backfill','run.completed','custom','${at}'),
	 ('backfill-pending','org','tedi','backfill-pending','run.started','custom','${at}');
`;

for (const store of ["d1", "postgres"] as const)
	describe(`runtime events ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = new DatabaseSync(":memory:");
				sqlite.exec(`
					PRAGMA foreign_keys = ON;
					CREATE TABLE organizations(id TEXT PRIMARY KEY);
					CREATE TABLE tedis(id TEXT PRIMARY KEY);
					INSERT INTO organizations VALUES ('org'),('other');
					INSERT INTO tedis VALUES ('tedi'),('other-tedi');
				`);
				for (const table of [
					kernelRuntimeRuns,
					kernelRuntimeEvents,
					tediRuntimeEvents,
					tediArtifacts,
					chatDispatchIdempotency,
					workDue,
				])
					for (const ddl of tableDdl(table)) sqlite.exec(ddl);
				sqlite.exec(priorEvents);
				// Use the installed D1 trigger definitions, not a simplified test copy.
				const recovery = readFileSync(
					new URL(
						"../../drizzle/20261116000545_d1_recovery_read_indexes/migration.sql",
						import.meta.url,
					),
					"utf8",
				);
				for (const statement of recovery.split("--> statement-breakpoint"))
					if (
						statement.includes("CREATE TRIGGER") ||
						/^\s*UPDATE tedi_runtime_events AS started/.test(statement)
					)
						sqlite.exec(statement);
				const due = readFileSync(
					new URL(
						"../../drizzle/20261125155337_work_due/migration.sql",
						import.meta.url,
					),
					"utf8",
				);
				for (const statement of due.split("--> statement-breakpoint"))
					if (
						/CREATE TRIGGER work_due_orphan_run_sweep_/.test(statement) ||
						(/^\s*INSERT INTO work_due/.test(statement) &&
							statement.includes("'orphan-run-sweep'"))
					)
						sqlite.exec(statement);
				db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				// The entire generated migration keeps real constraints and parent tables.
				const eventDdl: string[] = [];
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql)
						if (ddl.includes("CREATE FUNCTION tedi_runtime_mark_terminal_seen"))
							eventDdl.push(ddl);
						else await fixture.engine.exec(ddl);
				await fixture.engine.exec(`
					INSERT INTO organizations(id,name,slug) VALUES ('org','Org','org'),('other','Other','other');
					INSERT INTO tedis(id,organization_id,name,slug) VALUES
					 ('tedi','org','Tedi','tedi'),('other-tedi','other','Other','other');
				`);
				await fixture.engine.exec(priorEvents);
				for (const ddl of eventDdl) await fixture.engine.exec(ddl);
			}
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("backfills existing starts without reopening terminal runs", async () => {
			const events = coreTable(db, tediRuntimeEvents);
			const due = coreTable(db, workDue);
			expect(
				await db.select().from(events).where(eq(events.id, "backfill-start")),
			).toMatchObject([{ terminalSeen: 1 }]);
			expect(
				await db.select().from(due).where(eq(due.objectId, "backfill-start")),
			).toEqual([]);
			expect(
				await db.select().from(due).where(eq(due.objectId, "backfill-pending")),
			).toMatchObject([{ dueAt: plus(12) }]);
		});

		it("composes cause-bound inserts, preserves JSON/nulls and fences replay across tenants", async () => {
			const cause = {
				id: "cause",
				...scope,
				kind: "message.received" as const,
				conversationId: "conversation",
				runId: "run",
				createdAt: at,
			};
			const child = {
				id: "child",
				...scope,
				kind: "message.completed" as const,
				conversationId: "conversation",
				runId: "run",
				causeEventId: "cause",
				payload: { message: { content: "Hello Ä" } },
				runtimeMetadata: { traceId: "trace" },
				createdAt: at,
			};
			const [first, second] = await db.batch([
				buildInsertKernelRuntimeEventStatement(db, cause),
				buildInsertKernelRuntimeEventStatement(db, child),
			]);
			expect(first[0]).toMatchObject({
				id: "cause",
				payload: null,
				runtimeMetadata: null,
			});
			expect(second[0]).toMatchObject({
				causeEventId: "cause",
				payload: child.payload,
				traceId: "trace",
			});
			expect(await insertKernelRuntimeEventIfAbsent(db, child)).toMatchObject({
				inserted: false,
				row: { id: "child" },
			});
			await expect(
				insertKernelRuntimeEventIfAbsent(db, {
					...child,
					organizationId: "other",
				}),
			).rejects.toBeInstanceOf(KernelRuntimeEventConflictError);
			await expect(
				insertKernelRuntimeEventIfAbsent(db, {
					...child,
					id: "missing",
					causeEventId: "absent",
				}),
			).rejects.toBeInstanceOf(KernelRuntimeEventConflictError);
			expect(
				await getKernelRuntimeEventById(
					db,
					{ organizationId: "other" },
					"child",
				),
			).toBeUndefined();
			await updateKernelRuntimeEventMetadata(db, scope, "child", {
				traceId: "updated",
			});
			expect(await getKernelRuntimeEventById(db, scope, "child")).toMatchObject(
				{ traceId: "updated" },
			);
		});

		it("searches nested message JSON, keeps ASCII folding and offset-only pagination", async () => {
			const search = (query: string) =>
				listKernelRuntimeEvents(db, {
					...scope,
					messageSearch: { conversationIds: ["conversation"], query },
					order: "asc",
				});
			expect((await search("HELLO")).map((row) => row.id)).toEqual(["child"]);
			expect((await search("Ä")).map((row) => row.id)).toEqual(["child"]);
			expect(await search("ä")).toEqual([]);
			expect(
				(
					await listKernelRuntimeEvents(db, {
						...scope,
						order: "asc",
						offset: 1,
					})
				).map((row) => row.id),
			).toEqual(["child"]);
			await insertKernelRuntimeEventIfAbsent(db, {
				id: "title",
				...scope,
				kind: "conversation.updated",
				conversationId: "conversation",
				payload: { conversation: { title: "Title" } },
				createdAt: at,
			});
			expect(
				await countKernelConversationTitleGuardEvents(db, {
					...scope,
					conversationId: "conversation",
				}),
			).toEqual(
				new Map([
					["conversation.updated", 1],
					["message.completed", 1],
				]),
			);
		});

		it("reads large run sets once with global ordering and scope", async () => {
			const events = coreTable(db, tediRuntimeEvents);
			await db.insert(events).values([
				{
					id: "set-a",
					...scope,
					tediId: "tedi",
					runId: "set-a",
					kind: "message.completed",
					runtimeBackend: "custom",
					createdAt: at,
				},
				{
					id: "set-b",
					...scope,
					tediId: "tedi",
					runId: "set-b",
					kind: "message.completed",
					runtimeBackend: "custom",
					createdAt: plus(1),
				},
				{
					id: "set-foreign",
					organizationId: "other",
					tediId: "other-tedi",
					runId: "set-b",
					kind: "message.completed",
					runtimeBackend: "custom",
					createdAt: plus(2),
				},
			]);
			const ids = [
				...Array.from({ length: 150 }, (_, i) => `absent-${i}`),
				"set-a",
				"set-b",
				"set-b",
			];
			expect(
				(
					await listTediRuntimeEvents(db, {
						...scope,
						tediId: "tedi",
						runIds: ids,
						order: "desc",
						offset: 1,
						limit: 1,
					})
				).map((row) => row.id),
			).toEqual(["set-a"]);
			expect(
				await listTediRuntimeEvents(db, {
					...scope,
					tediId: "tedi",
					runIds: [],
				}),
			).toEqual([]);
			await db.insert(coreTable(db, tediArtifacts)).values([
				{
					id: "artifact-a",
					...scope,
					tediId: "tedi",
					runId: "set-a",
					kind: "file",
					name: "A",
					createdAt: at,
				},
				{
					id: "artifact-b",
					...scope,
					tediId: "tedi",
					runId: "set-b",
					kind: "file",
					name: "B",
					createdAt: at,
				},
			]);
			expect(
				(
					await listTediArtifacts(db, {
						...scope,
						tediId: "tedi",
						runIds: ids,
						limit: 1,
					})
				).map((row) => row.id),
			).toEqual(["artifact-b"]);
		});

		it("groups parent, direct-child and planned-child notices with owner/cursor filters", async () => {
			await db.insert(coreTable(db, kernelRuntimeRuns)).values({
				id: "parent",
				...scope,
				conversationId: "feed",
				delegatedTediId: "tedi",
				childRunId: "direct",
				metadata: {
					ownerHostSessionId: "owner",
					homePlan: {
						assignments: [{ childRunId: "planned", ownerTediId: "tedi" }],
					},
				},
			});
			await insertKernelRuntimeEventIfAbsent(db, {
				id: "own-finish",
				...scope,
				kind: "run.completed",
				conversationId: "feed",
				runId: "parent",
				createdAt: at,
			});
			await db.insert(coreTable(db, tediRuntimeEvents)).values([
				{
					id: "direct-finish",
					...scope,
					tediId: "tedi",
					runId: "direct",
					kind: "run.completed",
					runtimeBackend: "custom",
					createdAt: at,
				},
				{
					id: "planned-finish",
					...scope,
					tediId: "tedi",
					runId: "planned",
					kind: "run.failed",
					runtimeBackend: "custom",
					createdAt: at,
				},
			]);
			const rows = await listHomeRunFinishedEvents(db, {
				...scope,
				conversationId: "feed",
				ownerHostSessionId: "owner",
				limit: 10,
			});
			expect(rows.map((row) => row.id)).toEqual([
				"direct-finish",
				"own-finish",
				"planned-finish",
			]);
			expect(
				await listHomeRunFinishedEvents(db, {
					...scope,
					runId: "planned",
					ownerHostSessionId: "owner",
					limit: 10,
				}),
			).toMatchObject([{ parentRunId: "parent", status: "failed" }]);
			expect(
				await listHomeRunFinishedEvents(db, {
					...scope,
					ownerHostSessionId: "foreign",
					limit: 10,
				}),
			).toEqual([]);
			expect(
				(
					await listHomeRunFinishedEvents(db, {
						...scope,
						after: { at, id: "own-finish" },
						limit: 10,
					})
				).map((row) => row.id),
			).toEqual(["planned-finish"]);
		});

		it("maintains monotonic terminal markers and due rows across rotation and rollback", async () => {
			const events = coreTable(db, tediRuntimeEvents);
			const due = coreTable(db, workDue);
			const event = (
				id: string,
				runId: string,
				kind: "run.started" | "run.completed",
			) => ({
				id,
				runId,
				kind,
				...scope,
				tediId: "tedi",
				runtimeBackend: "custom" as const,
				createdAt: at,
			});
			await db.insert(events).values(event("start", "terminal", "run.started"));
			expect(
				await db.select().from(due).where(eq(due.objectId, "start")),
			).toMatchObject([{ dueAt: plus(12) }]);
			await db
				.insert(events)
				.values(event("terminal", "terminal", "run.completed"));
			expect(
				await db.select().from(events).where(eq(events.id, "start")),
			).toMatchObject([{ terminalSeen: 1 }]);
			expect(
				await db.select().from(due).where(eq(due.objectId, "start")),
			).toEqual([]);
			await db.delete(events).where(eq(events.id, "terminal"));
			expect(
				await db.select().from(events).where(eq(events.id, "start")),
			).toMatchObject([{ terminalSeen: 1 }]);
			await db
				.insert(events)
				.values(event("early-terminal", "late-start", "run.completed"));
			await db
				.insert(events)
				.values(event("late-start", "late-start", "run.started"));
			expect(
				await db.select().from(due).where(eq(due.objectId, "late-start")),
			).toEqual([]);
			await expect(
				db.batch([
					db
						.insert(events)
						.values(event("rolled-back", "rollback", "run.started")),
					db.insert(events).values(event("start", "conflict", "run.started")),
				]),
			).rejects.toThrow();
			expect(
				await db.select().from(events).where(eq(events.id, "rolled-back")),
			).toEqual([]);
			expect(
				await db.select().from(due).where(eq(due.objectId, "rolled-back")),
			).toEqual([]);
			await db.delete(events).where(sql`${events.id} = 'start'`);
			expect(
				await db.select().from(due).where(eq(due.objectId, "start")),
			).toEqual([]);
		});
	});
