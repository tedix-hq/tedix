import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	kernelConversations,
	kernelRuntimeEvents,
	kernelRuntimeRuns,
} from "../schema/cognitive-runtime";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import {
	insertTediRuntimeEvent,
	listTediRuntimeEventsForRouter,
	updateTediRuntimeEventPayload,
} from "./cognitive-runtime";
import {
	countTediRuntimeEvents,
	insertKernelRuntimeEventIfAbsent,
	KernelRuntimeEventConflictError,
	listKernelRuntimeEvents,
	listTediRuntimeEvents,
} from "./kernel-runtime-events";
import {
	findKernelRuntimeRunByChild,
	getKernelRuntimeRun,
	getKernelRuntimeRunStatus,
	insertKernelRuntimeRunIfAbsent,
	listKernelRuntimeRuns,
	updateKernelRuntimeRunForOrg,
} from "./kernel-runtime-runs";
import {
	getReadableKernelToolResult,
	getReadableKernelToolResultBySource,
	insertKernelToolResultWithRetention,
} from "./kernel-tool-results";
import {
	selectRuntimeStore,
	type TenantRuntimeStorage,
} from "./runtime-tenant-store";

const organizationId = "fictional-runtime-org";
const workspaceId = "fictional-runtime-workspace";
const conversationId = "conversation-one";
const databases: ReturnType<typeof createMigratedSqlite>[] = [];

afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture(plane: "d1" | "tenant") {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	databases.push(sqlite);
	const storage: TenantRuntimeStorage = {
		sql: {
			exec(query, ...bindings) {
				const statement = sqlite.prepare(query);
				const columnNames = statement.columns().map((column) => column.name);
				statement.setReturnArrays(true);
				const rows = statement.all(...bindings);
				return {
					columnNames,
					raw: () => rows.values(),
					rowsRead: rows.length,
					rowsWritten: 0,
				};
			},
		},
		transactionSync(callback) {
			sqlite.exec("BEGIN");
			try {
				const result = callback();
				sqlite.exec("COMMIT");
				return result;
			} catch (error) {
				sqlite.exec("ROLLBACK");
				throw error;
			}
		},
	};
	const db = selectRuntimeStore(
		plane === "tenant"
			? { plane, storage }
			: { plane, db: createDbClient(createD1Facade(sqlite)) },
	);
	return { db, scope: { organizationId, workspaceId } };
}

function runRow(id: string, more: Record<string, unknown> = {}) {
	return {
		id,
		organizationId,
		conversationId,
		status: "running" as const,
		createdAt: "2026-11-05T10:00:00.000Z",
		updatedAt: "2026-11-05T10:00:00.000Z",
		...more,
	};
}

function toolResultRow(index: number) {
	const id = `result-${index.toString().padStart(2, "0")}`;
	return {
		id,
		organizationId,
		conversationId,
		runId: "home-run",
		sourceKind: "direct_read" as const,
		sourceId: id,
		objectKey: `home-tool-results/${organizationId}/${id}`,
		sha256: index.toString(16).padStart(64, "0"),
		byteSize: 1,
		contentType: "application/json",
		createdAt: `2026-11-05T10:${index.toString().padStart(2, "0")}:00.000Z`,
		expiresAt: "2026-11-06T00:00:00.000Z",
		now: "2026-11-05T12:00:00.000Z",
	};
}

describe.each(["d1", "tenant"] as const)(
	"runtime store parity: %s",
	(plane) => {
		it("records, patches and pages tedi runtime events", async () => {
			const { db, scope } = fixture(plane);
			await insertTediRuntimeEvent(db, {
				...scope,
				id: "tedi-event-old",
				tediId: "tedi-one",
				kind: "message.delta",
				conversationId,
				runId: "child-run",
				delta: "old",
				runtimeBackend: "custom",
				createdAt: "2026-11-05T10:00:00.000Z",
			});
			await insertTediRuntimeEvent(db, {
				...scope,
				id: "tedi-event-new",
				tediId: "tedi-one",
				kind: "run.completed",
				conversationId,
				runId: "child-run",
				runtimeBackend: "custom",
				runtimeMetadata: { traceId: "trace-one" },
				createdAt: "2026-11-05T10:01:00.000Z",
			});
			const patch = {
				...scope,
				id: "tedi-event-new",
				payload: { status: "completed" },
			};
			await updateTediRuntimeEventPayload(db, patch);
			await expect(
				listTediRuntimeEventsForRouter(db, {
					...scope,
					tediId: "tedi-one",
					runId: "child-run",
					order: "desc",
					limit: 1,
				}),
			).resolves.toMatchObject([
				{
					id: "tedi-event-new",
					payload: { status: "completed" },
					traceId: "trace-one",
				},
			]);
		});

		it("persists and lists kernel runs with scoped child resolution", async () => {
			const { db, scope } = fixture(plane);
			await insertKernelRuntimeRunIfAbsent(db, {
				...runRow("run-old", {
					delegatedTediId: "tedi-one",
					childRunId: "child-run",
				}),
				...scope,
			});
			await insertKernelRuntimeRunIfAbsent(db, {
				...runRow("run-new", {
					createdAt: "2026-11-05T10:01:00.000Z",
					updatedAt: "2026-11-05T10:01:00.000Z",
				}),
				...scope,
			});
			await updateKernelRuntimeRunForOrg(db, {
				...scope,
				id: "run-old",
				patch: { status: "completed", preview: "finished" },
			});
			await expect(
				listKernelRuntimeRuns(db, {
					...scope,
					conversationId,
					limit: 10,
				}),
			).resolves.toMatchObject([{ id: "run-new" }, { id: "run-old" }]);
			await expect(
				getKernelRuntimeRunStatus(db, { ...scope, id: "run-old" }),
			).resolves.toBe("completed");
			await expect(
				findKernelRuntimeRunByChild(db, {
					...scope,
					delegatedTediId: "tedi-one",
					childRunId: "child-run",
				}),
			).resolves.toMatchObject({ id: "run-old", preview: "finished" });
		});

		it("keeps kernel event causes immutable and timelines ordered", async () => {
			const { db, scope } = fixture(plane);
			await insertKernelRuntimeEventIfAbsent(db, {
				...scope,
				id: "cause",
				kind: "message.received",
				conversationId,
				runId: "home-run",
				createdAt: "2026-11-05T10:00:00.000Z",
			});
			await insertKernelRuntimeEventIfAbsent(db, {
				...scope,
				id: "started",
				kind: "run.started",
				conversationId,
				runId: "home-run",
				causeEventId: "cause",
				createdAt: "2026-11-05T10:01:00.000Z",
			});
			await expect(
				insertKernelRuntimeEventIfAbsent(db, {
					...scope,
					id: "started",
					kind: "run.started",
					conversationId,
					runId: "home-run",
					causeEventId: "other",
				}),
			).rejects.toBeInstanceOf(KernelRuntimeEventConflictError);
			await expect(
				listKernelRuntimeEvents(db, {
					...scope,
					runId: "home-run",
					order: "asc",
				}),
			).resolves.toMatchObject([{ id: "cause" }, { id: "started" }]);
		});

		it("preserves merged child timeline ordering, filtering and counts", async () => {
			const { db, scope } = fixture(plane);
			for (const event of [
				{
					id: "child-one",
					runId: "child-a",
					kind: "message.completed" as const,
					createdAt: "2026-11-05T10:00:00.000Z",
				},
				{
					id: "child-two",
					runId: "child-b",
					kind: "message.completed" as const,
					createdAt: "2026-11-05T10:02:00.000Z",
				},
				{
					id: "child-delta",
					runId: "child-a",
					kind: "message.delta" as const,
					createdAt: "2026-11-05T10:03:00.000Z",
				},
			])
				await insertTediRuntimeEvent(db, {
					...scope,
					...event,
					tediId: "tedi-one",
					conversationId,
					runtimeBackend: "custom",
				});
			await insertTediRuntimeEvent(db, {
				...scope,
				organizationId: "fictional-other-org",
				id: "foreign-child",
				tediId: "tedi-one",
				conversationId,
				runId: "child-a",
				kind: "message.completed",
				runtimeBackend: "custom",
				createdAt: "2026-11-05T10:04:00.000Z",
			});
			await expect(
				listTediRuntimeEvents(db, {
					...scope,
					tediId: "tedi-one",
					runIds: ["child-a", "child-b", "child-a"],
					kinds: ["message.completed"],
					order: "desc",
					limit: 2,
				}),
			).resolves.toMatchObject([{ id: "child-two" }, { id: "child-one" }]);
			await expect(
				countTediRuntimeEvents(db, {
					...scope,
					tediId: "tedi-one",
					runId: "child-a",
				}),
			).resolves.toBe(2);
		});

		it("retains and reads bounded kernel tool-result metadata", async () => {
			const { db } = fixture(plane);
			await db.insert(kernelConversations).values({
				id: `${organizationId}:${conversationId}`,
				organizationId,
				conversationId,
				lastMessageAt: "2026-11-05T10:00:00.000Z",
			});
			for (let index = 0; index < 21; index++)
				await insertKernelToolResultWithRetention(db, toolResultRow(index));
			const newest = toolResultRow(20);
			await expect(
				getReadableKernelToolResultBySource(db, {
					organizationId,
					conversationId,
					sourceKind: newest.sourceKind,
					sourceId: newest.sourceId,
					now: newest.now,
				}),
			).resolves.toMatchObject({ id: newest.id });
			await expect(
				getReadableKernelToolResult(db, {
					organizationId: "fictional-other-org",
					conversationId,
					id: newest.id,
					sha256: newest.sha256,
					now: newest.now,
				}),
			).resolves.toBeNull();
			await expect(
				getReadableKernelToolResultBySource(db, {
					organizationId,
					conversationId,
					sourceKind: "direct_read",
					sourceId: "result-00",
					now: newest.now,
				}),
			).resolves.toBeNull();
		});

		it("rolls back a complete runtime batch on failure", async () => {
			const { db } = fixture(plane);
			await expect(
				db.batch([
					db.insert(kernelRuntimeRuns).values(runRow("rollback-run")),
					db.insert(kernelRuntimeEvents).values({
						id: "rollback-event",
						organizationId,
						conversationId,
						kind: "run.started",
					}),
					db.insert(kernelRuntimeEvents).values({
						id: "rollback-event",
						organizationId,
						conversationId,
						kind: "run.started",
					}),
				]),
			).rejects.toThrow();
			await expect(
				getKernelRuntimeRun(db, { id: "rollback-run", organizationId }),
			).resolves.toBeUndefined();
		});
	},
);
