import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { createDurableSqliteFixture } from "../test/durable-sqlite-fixture";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import * as platformCognitive from "./cognitive-runtime";
import * as tenantCognitive from "./durable-sqlite/cognitive-runtime";
import * as tenantEvents from "./durable-sqlite/kernel-runtime-events";
import * as tenantRuns from "./durable-sqlite/kernel-runtime-runs";
import { createTenantStoreDb } from "./durable-sqlite/tenant-store";
import * as tenantToolResults from "./durable-sqlite/kernel-tool-results";
import * as platformEvents from "./kernel-runtime-events";
import * as platformRuns from "./kernel-runtime-runs";
import * as platformToolResults from "./kernel-tool-results";

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
	const platformDb = createDbClient(createD1Facade(sqlite));
	const tenantDb = createTenantStoreDb(createDurableSqliteFixture(sqlite));
	const scope = { organizationId, workspaceId };
	return {
		sqlite,
		scope,
		insertTedi: (
			input: Parameters<typeof platformCognitive.insertTediRuntimeEvent>[1],
		) =>
			plane === "tenant"
				? tenantCognitive.insertTediRuntimeEvent(tenantDb, input)
				: platformCognitive.insertTediRuntimeEvent(platformDb, input),
		updateTediPayload: (
			input: Parameters<
				typeof tenantCognitive.updateTediRuntimeEventPayload
			>[1],
		) =>
			plane === "tenant"
				? tenantCognitive.updateTediRuntimeEventPayload(tenantDb, input)
				: platformCognitive.updateTediRuntimeEventPayload(platformDb, input),
		listTediForRouter: (
			input: tenantCognitive.ListTediRuntimeEventsForRouterInput,
		) =>
			plane === "tenant"
				? tenantCognitive.listTediRuntimeEventsForRouter(tenantDb, input)
				: platformCognitive.listTediRuntimeEventsForRouter(platformDb, input),
		getTediEvent: (input: {
			organizationId: string;
			tediId: string;
			id: string;
		}) =>
			plane === "tenant"
				? tenantCognitive.getTediRuntimeEventById(tenantDb, input)
				: platformCognitive.getTediRuntimeEventById(
						platformDb,
						{ organizationId: input.organizationId, tediId: input.tediId },
						input.id,
					),
		insertRun: (input: platformRuns.NewKernelRuntimeRun) =>
			plane === "tenant"
				? tenantRuns.insertKernelRuntimeRunIfAbsent(tenantDb, input)
				: platformRuns.insertKernelRuntimeRunIfAbsent(platformDb, input),
		updateRun: (
			input: Parameters<typeof platformRuns.updateKernelRuntimeRunForOrg>[1],
		) =>
			plane === "tenant"
				? tenantRuns.updateKernelRuntimeRunForOrg(tenantDb, input)
				: platformRuns.updateKernelRuntimeRunForOrg(platformDb, input),
		listRuns: (
			input: Parameters<typeof tenantRuns.listKernelRuntimeRuns>[1],
		) =>
			plane === "tenant"
				? tenantRuns.listKernelRuntimeRuns(tenantDb, input)
				: platformRuns.listKernelRuntimeRuns(platformDb, input),
		getRunStatus: (
			input: Parameters<typeof tenantRuns.getKernelRuntimeRunStatus>[1],
		) =>
			plane === "tenant"
				? tenantRuns.getKernelRuntimeRunStatus(tenantDb, input)
				: platformRuns.getKernelRuntimeRunStatus(platformDb, input),
		findRunByChild: (
			input: Parameters<typeof tenantRuns.findKernelRuntimeRunByChild>[1],
		) =>
			plane === "tenant"
				? tenantRuns.findKernelRuntimeRunByChild(tenantDb, input)
				: platformRuns.findKernelRuntimeRunByChild(platformDb, input),
		transitionRun: (
			input: Parameters<typeof tenantRuns.transitionKernelRuntimeRunStatus>[1],
		) =>
			plane === "tenant"
				? tenantRuns.transitionKernelRuntimeRunStatus(tenantDb, input)
				: platformRuns.transitionKernelRuntimeRunStatus(platformDb, input),
		openTurn: (
			input: Parameters<typeof tenantRuns.openKernelRuntimeTurn>[1],
		) =>
			plane === "tenant"
				? tenantRuns.openKernelRuntimeTurn(tenantDb, input)
				: platformRuns.openKernelRuntimeTurn(platformDb, {
						...input,
						conversation: null,
						submission: null,
					}),
		settleTurn: (
			input: Parameters<typeof tenantRuns.settleKernelRuntimeTurn>[1],
		) =>
			plane === "tenant"
				? tenantRuns.settleKernelRuntimeTurn(tenantDb, input)
				: platformRuns.settleKernelRuntimeTurn(platformDb, input),
		compareAndTouchRun: (
			input: Parameters<typeof tenantRuns.compareAndTouchKernelRuntimeRun>[1],
		) =>
			plane === "tenant"
				? tenantRuns.compareAndTouchKernelRuntimeRun(tenantDb, input)
				: platformRuns.compareAndTouchKernelRuntimeRun(platformDb, input),
		insertKernelEvent: (input: platformEvents.NewKernelRuntimeEvent) =>
			plane === "tenant"
				? tenantEvents.insertKernelRuntimeEventIfAbsent(tenantDb, input)
				: platformEvents.insertKernelRuntimeEventIfAbsent(platformDb, input),
		listKernelEvents: (input: tenantEvents.ListKernelRuntimeEventsInput) =>
			plane === "tenant"
				? tenantEvents.listKernelRuntimeEvents(tenantDb, input)
				: platformEvents.listKernelRuntimeEvents(platformDb, input),
		listFinishedEvents: (
			input: Parameters<typeof tenantEvents.listHomeRunFinishedEvents>[1],
		) =>
			plane === "tenant"
				? tenantEvents.listHomeRunFinishedEvents(tenantDb, input)
				: platformEvents.listHomeRunFinishedEvents(platformDb, input),
		updateKernelEventMetadata: (
			input: Parameters<
				typeof tenantEvents.updateKernelRuntimeEventMetadata
			>[1],
		) =>
			plane === "tenant"
				? tenantEvents.updateKernelRuntimeEventMetadata(tenantDb, input)
				: platformEvents.updateKernelRuntimeEventMetadata(
						platformDb,
						{ organizationId: input.organizationId },
						input.id,
						input.runtimeMetadata,
					),
		listTediEvents: (input: tenantEvents.ListTediRuntimeEventsInput) =>
			plane === "tenant"
				? tenantEvents.listTediRuntimeEvents(tenantDb, input)
				: platformEvents.listTediRuntimeEvents(platformDb, input),
		countTediEvents: (
			input: Parameters<typeof tenantEvents.countTediRuntimeEvents>[1],
		) =>
			plane === "tenant"
				? tenantEvents.countTediRuntimeEvents(tenantDb, input)
				: platformEvents.countTediRuntimeEvents(platformDb, input),
		insertToolResult: (
			input: Parameters<
				typeof platformToolResults.insertKernelToolResultWithRetention
			>[1],
		) =>
			plane === "tenant"
				? tenantToolResults.insertKernelToolResultWithRetention(tenantDb, input)
				: platformToolResults.insertKernelToolResultWithRetention(
						platformDb,
						input,
					),
		readToolResult: (
			input: Parameters<
				typeof tenantToolResults.getReadableKernelToolResult
			>[1],
		) =>
			plane === "tenant"
				? tenantToolResults.getReadableKernelToolResult(tenantDb, input)
				: platformToolResults.getReadableKernelToolResult(platformDb, input),
		readToolResultBySource: (
			input: Parameters<
				typeof tenantToolResults.getReadableKernelToolResultBySource
			>[1],
		) =>
			plane === "tenant"
				? tenantToolResults.getReadableKernelToolResultBySource(tenantDb, input)
				: platformToolResults.getReadableKernelToolResultBySource(
						platformDb,
						input,
					),
		evictToolResults: (
			input: Parameters<
				typeof tenantToolResults.evictConversationToolResults
			>[1],
		) =>
			plane === "tenant"
				? tenantToolResults.evictConversationToolResults(tenantDb, input)
				: platformDb
						.batch([
							platformToolResults.buildEvictConversationToolResultsStatement(
								platformDb,
								input,
							),
						])
						.then(([rows]) => rows),
	};
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
			const queries = fixture(plane);
			const { scope } = queries;
			await queries.insertTedi({
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
			await queries.insertTedi({
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
			await queries.updateTediPayload(patch);
			await expect(
				queries.listTediForRouter({
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
			await expect(
				queries.getTediEvent({
					...scope,
					tediId: "tedi-one",
					id: "tedi-event-new",
				}),
			).resolves.toMatchObject({ id: "tedi-event-new" });
		});

		it("persists and lists kernel runs with scoped child resolution", async () => {
			const queries = fixture(plane);
			const { scope } = queries;
			await queries.insertRun({
				...runRow("run-old", {
					delegatedTediId: "tedi-one",
					childRunId: "child-run",
				}),
				...scope,
			});
			await queries.insertRun({
				...runRow("run-new", {
					createdAt: "2026-11-05T10:01:00.000Z",
					updatedAt: "2026-11-05T10:01:00.000Z",
				}),
				...scope,
			});
			await queries.updateRun({
				...scope,
				id: "run-old",
				patch: { status: "completed", preview: "finished" },
			});
			await expect(
				queries.listRuns({
					...scope,
					conversationId,
					limit: 10,
				}),
			).resolves.toMatchObject([{ id: "run-new" }, { id: "run-old" }]);
			await expect(
				queries.getRunStatus({ ...scope, id: "run-old" }),
			).resolves.toBe("completed");
			await expect(
				queries.findRunByChild({
					...scope,
					delegatedTediId: "tedi-one",
					childRunId: "child-run",
				}),
			).resolves.toMatchObject({ id: "run-old", preview: "finished" });
			await expect(
				queries.transitionRun({
					...scope,
					id: "run-new",
					fromStatus: "running",
					patch: { status: "completed" },
				}),
			).resolves.toBe(true);
		});

		it("opens, compare-and-touches and settles a run atomically", async () => {
			const queries = fixture(plane);
			const { scope } = queries;
			const opened = await queries.openTurn({
				run: { ...runRow("atomic-run"), ...scope },
				events: [
					{
						...scope,
						id: "atomic-received",
						kind: "message.received",
						conversationId,
						runId: "atomic-run",
						createdAt: "2026-11-05T10:00:00.000Z",
					},
					{
						...scope,
						id: "atomic-started",
						kind: "run.started",
						conversationId,
						runId: "atomic-run",
						causeEventId: "atomic-received",
						createdAt: "2026-11-05T10:00:01.000Z",
					},
				],
			});
			expect(opened.events).toMatchObject([
				{ inserted: true },
				{ inserted: true },
			]);
			await expect(
				queries.compareAndTouchRun({
					...scope,
					id: "atomic-run",
					status: "running",
					expectedUpdatedAt: "2026-11-05T10:00:00.000Z",
					updatedAt: "2026-11-05T10:01:00.000Z",
				}),
			).resolves.toBe(true);
			const settled = await queries.settleTurn({
				run: {
					...scope,
					id: "atomic-run",
					fromStatus: "running",
					expectedUpdatedAt: "2026-11-05T10:01:00.000Z",
					patch: {
						status: "completed",
						updatedAt: "2026-11-05T10:02:00.000Z",
					},
				},
				events: [
					{
						...scope,
						id: "atomic-completed",
						kind: "run.completed",
						conversationId,
						runId: "atomic-run",
						createdAt: "2026-11-05T10:02:00.000Z",
					},
				],
			});
			expect(settled).toMatchObject({
				runTransitioned: true,
				events: [{ inserted: true }],
			});
			await expect(
				queries.listFinishedEvents({ ...scope, limit: 10 }),
			).resolves.toMatchObject([{ runId: "atomic-run", status: "completed" }]);
		});

		it("keeps kernel event causes immutable and timelines ordered", async () => {
			const queries = fixture(plane);
			const { scope } = queries;
			await queries.insertKernelEvent({
				...scope,
				id: "cause",
				kind: "message.received",
				conversationId,
				runId: "home-run",
				createdAt: "2026-11-05T10:00:00.000Z",
			});
			await queries.insertKernelEvent({
				...scope,
				id: "started",
				kind: "run.started",
				conversationId,
				runId: "home-run",
				causeEventId: "cause",
				createdAt: "2026-11-05T10:01:00.000Z",
			});
			await queries.updateKernelEventMetadata({
				...scope,
				id: "started",
				runtimeMetadata: { traceId: "kernel-trace" },
			});
			await expect(
				queries.insertKernelEvent({
					...scope,
					id: "started",
					kind: "run.started",
					conversationId,
					runId: "home-run",
					causeEventId: "other",
				}),
			).rejects.toBeInstanceOf(platformEvents.KernelRuntimeEventConflictError);
			await expect(
				queries.listKernelEvents({
					...scope,
					runId: "home-run",
					order: "asc",
				}),
			).resolves.toMatchObject([
				{ id: "cause" },
				{ id: "started", traceId: "kernel-trace" },
			]);
		});

		it("preserves merged child timeline ordering, filtering and counts", async () => {
			const queries = fixture(plane);
			const { scope } = queries;
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
				await queries.insertTedi({
					...scope,
					...event,
					tediId: "tedi-one",
					conversationId,
					runtimeBackend: "custom",
				});
			await queries.insertTedi({
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
				queries.listTediEvents({
					...scope,
					tediId: "tedi-one",
					runIds: ["child-a", "child-b", "child-a"],
					kinds: ["message.completed"],
					order: "desc",
					limit: 2,
				}),
			).resolves.toMatchObject([{ id: "child-two" }, { id: "child-one" }]);
			await expect(
				queries.countTediEvents({
					...scope,
					tediId: "tedi-one",
					runId: "child-a",
				}),
			).resolves.toBe(2);
		});

		it("projects direct and planned child completions into the Home feed", async () => {
			const queries = fixture(plane);
			const { scope } = queries;
			await queries.insertRun({
				...runRow("direct-parent", {
					delegatedTediId: "tedi-one",
					childRunId: "direct-child",
				}),
				...scope,
			});
			await queries.insertRun({
				...runRow("plan-parent", {
					metadata: {
						homePlan: {
							assignments: [
								{ ownerTediId: "tedi-one", childRunId: "plan-child" },
							],
						},
					},
				}),
				...scope,
			});
			for (const [id, runId, createdAt] of [
				["direct-terminal", "direct-child", "2026-11-05T10:05:00.000Z"],
				["plan-terminal", "plan-child", "2026-11-05T10:06:00.000Z"],
			] as const)
				await queries.insertTedi({
					...scope,
					id,
					tediId: "tedi-one",
					conversationId,
					runId,
					kind: "run.completed",
					runtimeBackend: "custom",
					createdAt,
				});
			await expect(
				queries.listFinishedEvents({ ...scope, limit: 10 }),
			).resolves.toMatchObject([
				{ runId: "direct-child", parentRunId: "direct-parent" },
				{ runId: "plan-child", parentRunId: "plan-parent" },
			]);
		});

		it("retains and reads bounded kernel tool-result metadata", async () => {
			const queries = fixture(plane);
			queries.sqlite
				.prepare(
					"INSERT INTO kernel_conversations(id,organization_id,conversation_id,last_message_at) VALUES(?,?,?,?)",
				)
				.run(
					`${organizationId}:${conversationId}`,
					organizationId,
					conversationId,
					"2026-11-05T10:00:00.000Z",
				);
			for (let index = 0; index < 21; index++)
				await queries.insertToolResult(toolResultRow(index));
			const newest = toolResultRow(20);
			await expect(
				queries.readToolResultBySource({
					organizationId,
					conversationId,
					sourceKind: newest.sourceKind,
					sourceId: newest.sourceId,
					now: newest.now,
				}),
			).resolves.toMatchObject({ id: newest.id });
			await expect(
				queries.readToolResult({
					organizationId: "fictional-other-org",
					conversationId,
					id: newest.id,
					sha256: newest.sha256,
					now: newest.now,
				}),
			).resolves.toBeNull();
			await expect(
				queries.readToolResultBySource({
					organizationId,
					conversationId,
					sourceKind: "direct_read",
					sourceId: "result-00",
					now: newest.now,
				}),
			).resolves.toBeNull();
			await expect(
				queries.evictToolResults({
					organizationId,
					conversationId,
					evictedAt: newest.now,
				}),
			).resolves.toHaveLength(20);
			await expect(
				queries.readToolResult({
					organizationId,
					conversationId,
					id: newest.id,
					sha256: newest.sha256,
					now: newest.now,
				}),
			).resolves.toBeNull();
		});
	},
);
