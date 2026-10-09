import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	kernelRuntimeEvents,
	kernelRuntimeRuns,
} from "../schema/cognitive-runtime";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { listKernelRuntimeEvents } from "./kernel-runtime-events";
import {
	getKernelRuntimeRun,
	settleKernelRuntimeTurn,
} from "./kernel-runtime-runs";

const SETTLED_AT = "2026-10-09T10:00:05.000Z";

async function setup(status: "running" | "canceled" = "running") {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(kernelRuntimeRuns, kernelRuntimeEvents));
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(kernelRuntimeRuns).values({
		id: "run-1",
		organizationId: "org-1",
		conversationId: "home:main",
		status,
		createdAt: "2026-10-09T10:00:00.000Z",
		updatedAt: "2026-10-09T10:00:00.000Z",
	});
	return db;
}

function turnParams() {
	return {
		run: {
			id: "run-1",
			organizationId: "org-1",
			fromStatus: "running" as const,
			patch: { status: "completed" as const, updatedAt: SETTLED_AT },
		},
		events: [
			{
				id: "evt-message",
				organizationId: "org-1",
				kind: "message.completed" as const,
				conversationId: "home:main",
				runId: "run-1",
				payload: { role: "assistant", content: "Done." },
				createdAt: SETTLED_AT,
			},
			{
				id: "evt-terminal",
				organizationId: "org-1",
				kind: "run.completed" as const,
				conversationId: "home:main",
				runId: "run-1",
				payload: { status: "completed" },
				createdAt: "2026-10-09T10:00:05.001Z",
			},
		],
	};
}

describe("settleKernelRuntimeTurn", () => {
	it("lands the run patch and both transcript events in one batch", async () => {
		const db = await setup();
		const result = await settleKernelRuntimeTurn(db, turnParams());
		expect(result.runTransitioned).toBe(true);
		expect(result.events.map((event) => event.inserted)).toEqual([true, true]);
		expect(result.events.map((event) => event.row.kind)).toEqual([
			"message.completed",
			"run.completed",
		]);
		expect((await getKernelRuntimeRun(db, { id: "run-1" }))?.status).toBe(
			"completed",
		);
		const rows = await listKernelRuntimeEvents(db, {
			runId: "run-1",
			order: "asc",
		});
		expect(rows.map((row) => row.id)).toEqual(["evt-message", "evt-terminal"]);
	});

	it("keeps the transcript when an operator cancel already won the run row", async () => {
		const db = await setup("canceled");
		const result = await settleKernelRuntimeTurn(db, turnParams());
		expect(result.runTransitioned).toBe(false);
		expect((await getKernelRuntimeRun(db, { id: "run-1" }))?.status).toBe(
			"canceled",
		);
		expect((await listKernelRuntimeEvents(db, { runId: "run-1" })).length).toBe(
			2,
		);
	});

	it("resolves a replayed event to its existing row without double-inserting", async () => {
		const db = await setup();
		await settleKernelRuntimeTurn(db, turnParams());
		const replay = await settleKernelRuntimeTurn(db, turnParams());
		expect(replay.runTransitioned).toBe(false);
		expect(replay.events.map((event) => event.inserted)).toEqual([
			false,
			false,
		]);
		expect(replay.events[0]?.row.id).toBe("evt-message");
		expect((await listKernelRuntimeEvents(db, { runId: "run-1" })).length).toBe(
			2,
		);
	});
});
