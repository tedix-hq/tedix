import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	kernelConversations,
	kernelRuntimeEvents,
	kernelRuntimeRuns,
} from "../schema/cognitive-runtime";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { getKernelConversation } from "./kernel-conversations";
import {
	KernelRuntimeEventConflictError,
	listKernelRuntimeEvents,
} from "./kernel-runtime-events";
import {
	getKernelRuntimeRun,
	openKernelRuntimeTurn,
} from "./kernel-runtime-runs";

const CREATED_AT = "2026-10-11T10:00:00.000Z";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(kernelRuntimeRuns, kernelRuntimeEvents, kernelConversations),
	);
	return createDbClient(createD1Facade(sqlite));
}

function turnParams(options?: { causeEventId?: string; replay?: boolean }) {
	return {
		run: {
			id: "run-1",
			organizationId: "org-1",
			conversationId: "home:topic",
			status: "running" as const,
			createdAt: CREATED_AT,
			updatedAt: CREATED_AT,
		},
		events: [
			{
				id: "evt-received",
				organizationId: "org-1",
				kind: "message.received" as const,
				conversationId: "home:topic",
				runId: "run-1",
				messageId: "run-1:input",
				payload: { role: "user", content: "hello" },
				createdAt: CREATED_AT,
			},
			{
				id: "evt-started",
				organizationId: "org-1",
				kind: "run.started" as const,
				conversationId: "home:topic",
				runId: "run-1",
				messageId: "run-1:input",
				causeEventId: options?.causeEventId ?? "evt-received",
				payload: { status: "running" },
				createdAt: CREATED_AT,
			},
		] as const,
		conversation: options?.replay
			? null
			: {
					organizationId: "org-1",
					conversationId: "home:topic",
					channel: "home",
					createdAt: CREATED_AT,
					provisionalTitle: "hello",
				},
	};
}

describe("openKernelRuntimeTurn", () => {
	it("lands the index bump, both events and the run row in one batch", async () => {
		const db = setup();
		const result = await openKernelRuntimeTurn(db, turnParams());
		expect(result.events.map((event) => event.inserted)).toEqual([true, true]);
		const rows = await listKernelRuntimeEvents(db, {
			runId: "run-1",
			order: "asc",
		});
		expect(rows.map((row) => [row.kind, row.causeEventId])).toEqual([
			["message.received", null],
			["run.started", "evt-received"],
		]);
		expect((await getKernelRuntimeRun(db, { id: "run-1" }))?.status).toBe(
			"running",
		);
		const conversation = await getKernelConversation(db, {
			organizationId: "org-1",
			conversationId: "home:topic",
		});
		expect(conversation?.messageCount).toBe(1);
		expect(conversation?.title).toBe("hello");
	});

	it("resolves a replay to the existing rows without a second index bump", async () => {
		const db = setup();
		await openKernelRuntimeTurn(db, turnParams());
		const replay = await openKernelRuntimeTurn(
			db,
			turnParams({ replay: true }),
		);
		expect(replay.events.map((event) => event.inserted)).toEqual([
			false,
			false,
		]);
		expect(replay.events[1]?.row.causeEventId).toBe("evt-received");
		expect((await listKernelRuntimeEvents(db, { runId: "run-1" })).length).toBe(
			2,
		);
		expect(
			(
				await getKernelConversation(db, {
					organizationId: "org-1",
					conversationId: "home:topic",
				})
			)?.messageCount,
		).toBe(1);
	});

	it("rejects a run.started whose cause row does not exist", async () => {
		const db = setup();
		await expect(
			openKernelRuntimeTurn(db, turnParams({ causeEventId: "evt-missing" })),
		).rejects.toBeInstanceOf(KernelRuntimeEventConflictError);
	});
});
