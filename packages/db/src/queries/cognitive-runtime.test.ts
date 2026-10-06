import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	insertTediRuntimeEvent,
	listTediRuntimeEventsForRouter,
	type TediRuntimeEventInsert,
} from "./cognitive-runtime";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(tediRuntimeEvents));
	return createDbClient(createD1Facade(sqlite));
}

function event(
	id: string,
	overrides: Partial<TediRuntimeEventInsert> = {},
): TediRuntimeEventInsert {
	return {
		id,
		organizationId: "org-1",
		tediId: "tedi-1",
		kind: "tool.completed",
		conversationId: "conversation-1",
		runId: "run-1",
		runtimeBackend: "cloudflare-agents",
		createdAt: "2026-09-22T12:00:00.000Z",
		...overrides,
	};
}

describe("runtime event pagination", () => {
	it("walks tied timestamps exactly once while preserving tedi and event filters", async () => {
		const db = fixture();
		for (const row of [
			event("event-a"),
			event("event-b"),
			event("event-c"),
			event("other-tedi", { tediId: "tedi-2" }),
			event("other-conversation", { conversationId: "conversation-2" }),
			event("other-run", { runId: "run-2" }),
			event("other-kind", { kind: "tool.started" }),
		]) {
			await insertTediRuntimeEvent(db, row);
		}

		const first = await listTediRuntimeEventsForRouter(db, {
			tediId: "tedi-1",
			conversationId: "conversation-1",
			runId: "run-1",
			kind: "tool.completed",
			order: "desc",
			limit: 2,
		});
		const last = first.at(-1)!;
		const second = await listTediRuntimeEventsForRouter(db, {
			tediId: "tedi-1",
			conversationId: "conversation-1",
			runId: "run-1",
			kind: "tool.completed",
			before: { createdAt: last.createdAt, id: last.id },
			order: "desc",
			limit: 2,
		});

		expect([...first, ...second].map((row) => row.id)).toEqual([
			"event-c",
			"event-b",
			"event-a",
		]);
	});
});
