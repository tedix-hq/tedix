/**
 * `tedi_runtime_events` identity contract.
 *
 * `insertTediRuntimeEvent` writes with `onConflictDoNothing` on `id`, so an
 * event id a run has already written is discarded without an error and without
 * a trace. That is the correct behaviour for a retried publish, and it is also
 * how a run's telemetry can stop while the run keeps going: if a Durable
 * Object restarts and the runtime's per-run call counter restarts with it,
 * every later `tool.started` / `tool.completed` row carries an id the run has
 * already used.
 *
 * Both halves are pinned here: the drop is real, and distinct ids are all
 * enumerable however many a turn produces.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { createDbClient } from "../client";
import {
	insertTediRuntimeEvent,
	listTediRuntimeEventsForRouter,
	type TediRuntimeEventInsert,
} from "./cognitive-runtime";

const TEDI_ID = "tedi-1";
const RUN_ID = "tedi-1:mcp:delegate-1";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	// The org/tedi parents are out of scope; D1 does not enforce foreign keys.
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(tediRuntimeEvents));
	return createDbClient(createD1Facade(sqlite));
}

function toolEvent(
	id: string,
	overrides: Partial<TediRuntimeEventInsert> = {},
): TediRuntimeEventInsert {
	return {
		id,
		organizationId: "org-1",
		tediId: TEDI_ID,
		kind: "tool.started",
		conversationId: "cto:agent:main:delegation-1",
		runId: RUN_ID,
		runtimeBackend: "cloudflare-agents",
		createdAt: "2026-09-17T09:34:20.960Z",
		...overrides,
	};
}

describe("tedi runtime event identity", () => {
	it("drops a re-issued event id and keeps the row already written", async () => {
		const db = fixture();
		const first = await insertTediRuntimeEvent(
			db,
			toolEvent(`${RUN_ID}:native-tool.0.started`, {
				payload: { name: "open_computer" },
			}),
		);
		expect(first?.payload).toMatchObject({ name: "open_computer" });

		// What a restarted per-run counter did: the same id, a different call.
		const second = await insertTediRuntimeEvent(
			db,
			toolEvent(`${RUN_ID}:native-tool.0.started`, {
				payload: { name: "exec" },
				createdAt: "2026-09-17T09:40:50.000Z",
			}),
		);
		expect(second).toBeNull();

		const rows = await listTediRuntimeEventsForRouter(db, {
			tediId: TEDI_ID,
			runId: RUN_ID,
			limit: 100,
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.payload).toMatchObject({ name: "open_computer" });
	});

	it("enumerates every distinct id a long turn writes", async () => {
		const db = fixture();
		const calls = 60;
		for (let call = 0; call < calls; call += 1) {
			const key = `toolu_${call.toString().padStart(4, "0")}`;
			await insertTediRuntimeEvent(
				db,
				toolEvent(`${RUN_ID}:native-tool.${key}.started`, {
					payload: { name: "exec" },
				}),
			);
			await insertTediRuntimeEvent(
				db,
				toolEvent(`${RUN_ID}:native-tool.${key}.completed`, {
					kind: "tool.completed",
					payload: { name: "exec" },
				}),
			);
		}

		const rows = await listTediRuntimeEventsForRouter(db, {
			tediId: TEDI_ID,
			runId: RUN_ID,
			limit: 500,
		});
		expect(rows).toHaveLength(calls * 2);
		expect(rows.filter((row) => row.kind === "tool.started")).toHaveLength(
			calls,
		);

		// The read path itself imposes no per-run ceiling below its `limit`.
		const kindOnly = await listTediRuntimeEventsForRouter(db, {
			tediId: TEDI_ID,
			runId: RUN_ID,
			kind: "tool.started",
			limit: 500,
		});
		expect(kindOnly).toHaveLength(calls);
	});
});
