import { DatabaseSync } from "node:sqlite";
import { PollHomeRunFinishedResultSchema } from "@tedix/api-contract/schemas/mcp-events";
import { createDbClient } from "@tedix/db/client";
import {
	kernelConversationGrants,
	kernelRuntimeEvents,
	kernelRuntimeRuns,
	tediRuntimeEvents,
} from "@tedix/db/schema/cognitive-runtime";
import { describe, expect, it } from "vite-plus/test";
import { createD1Facade } from "../../../../packages/db/src/test/d1-facade";
import { schemaDdl } from "../../../../packages/db/src/test/schema-ddl";
import type { BaseContext } from "../rpc/orpc";
import { pollHomeRunFinished } from "./home-run-finished";

function fixture(onPrepare?: (query: string) => void) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			kernelRuntimeEvents,
			kernelRuntimeRuns,
			tediRuntimeEvents,
			kernelConversationGrants,
		),
	);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	const db = createDbClient(createD1Facade(sqlite, { onPrepare }));
	const context = (sub: string) => ({ db, user: { sub } }) as BaseContext;
	const event = (
		id: string,
		run: string,
		kind = "run.completed",
		org = "org-example",
	) =>
		sqlite
			.prepare(
				"INSERT INTO kernel_runtime_events (id, organization_id, conversation_id, run_id, kind, created_at) VALUES (?,?,'private-chat',?,?,?)",
			)
			.run(id, org, run, kind, "2026-10-15T12:00:00.000Z");
	for (const [user, access] of [
		["owner-example", "owner"],
		["reader-example", "read"],
	]) {
		sqlite
			.prepare(
				"INSERT INTO kernel_conversation_grants (id,organization_id,conversation_id,grantee_descope_user_id,access,created_at,updated_at) VALUES (?,'org-example','private-chat',?,?,?,?)",
			)
			.run(user, user, access, "2026-10-15", "2026-10-15");
	}
	return { sqlite, context, event };
}

const start = { after: { at: "", id: "" }, limit: 10 };

describe("Home completion feed visibility", () => {
	it("keeps long private ledger IDs out of bounded cursors and resumes across timestamp ties", async () => {
		const { context, event } = fixture();
		for (let i = 0; i < 105; i++)
			event(
				`private-ledger-${"x".repeat(180)}-${String(i).padStart(3, "0")}`,
				`run-${i}`,
			);
		const head = await pollHomeRunFinished(
			context("owner-example"),
			{ limit: 10 },
			"org-example",
		);
		expect(PollHomeRunFinishedResultSchema.safeParse(head).success).toBe(true);
		expect(head.after.id).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(head)).not.toContain("private-ledger");
		expect(
			(
				await pollHomeRunFinished(
					context("owner-example"),
					{ limit: 10, after: head.after },
					"org-example",
				)
			).events,
		).toEqual([]);
		const first = await pollHomeRunFinished(
			context("owner-example"),
			{ ...start, limit: 1 },
			"org-example",
		);
		const second = await pollHomeRunFinished(
			context("owner-example"),
			{ limit: 1, after: first.after },
			"org-example",
		);
		expect(first.events[0]?.data.run_id).not.toBe(
			second.events[0]?.data.run_id,
		);
	});
	it("looks up delegated terminal events by run instead of a correlated org-wide join", async () => {
		let query = "";
		const { sqlite, context } = fixture((sql) => {
			if (sql.includes("AS home_finished")) query = sql;
		});
		await pollHomeRunFinished(context("owner-example"), start, "org-example");
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...Array(query.match(/\?/g)?.length ?? 0).fill(null));
		const details = plan.map((row) => String(row.detail)).join("\n");
		expect(details).not.toContain("CORRELATED SCALAR SUBQUERY");
		expect(details).toContain("idx_tedi_runtime_events_run_kind_created");
	});
	it("allows owner and shared readers, denies another member and a tedi, and isolates organizations", async () => {
		const { context, event } = fixture();
		event("event-example", "run-example");
		for (const user of ["owner-example", "reader-example"]) {
			const page = await pollHomeRunFinished(
				context(user),
				start,
				"org-example",
			);
			expect(page.events.map((e) => e.data.run_id)).toEqual(["run-example"]);
		}
		for (const user of ["other-member", "finance-tedi"]) {
			expect(
				(await pollHomeRunFinished(context(user), start, "org-example")).events,
			).toEqual([]);
		}
		expect(
			(await pollHomeRunFinished(context("owner-example"), start, "other-org"))
				.events,
		).toEqual([]);
	});

	it("uses the parent grants for direct and plan-delegated children", async () => {
		const { sqlite, context } = fixture();
		for (const plan of [false, true]) {
			const parent = plan ? "plan-parent" : "direct-parent";
			const child = plan ? "plan-child" : "direct-child";
			sqlite
				.prepare(
					"INSERT INTO kernel_runtime_runs (id,organization_id,conversation_id,delegated_tedi_id,child_run_id,metadata,created_at,updated_at) VALUES (?,'org-example','private-chat',?,?,?,'2026-10-15','2026-10-15')",
				)
				.run(
					parent,
					plan ? null : "worker-example",
					plan ? null : child,
					JSON.stringify(
						plan
							? {
									homePlan: {
										assignments: [
											{ ownerTediId: "worker-example", childRunId: child },
										],
									},
								}
							: {},
					),
				);
			sqlite
				.prepare(
					"INSERT INTO tedi_runtime_events (id,organization_id,tedi_id,conversation_id,run_id,kind,runtime_backend,created_at) VALUES (?,'org-example','worker-example','child-chat',?,'run.completed','custom','2026-10-15T12:00:00.000Z')",
				)
				.run(child, child);
		}
		const page = await pollHomeRunFinished(
			context("owner-example"),
			start,
			"org-example",
		);
		expect(
			page.events.map((e) => [e.data.run_id, e.data.parent_run_id]).sort(),
		).toEqual([
			["direct-child", "direct-parent"],
			["plan-child", "plan-parent"],
		]);
		expect(
			(await pollHomeRunFinished(context("other-member"), start, "org-example"))
				.events,
		).toEqual([]);
	});

	it("maps Home questions and failed dispatches without announcing queued delegations as finished", async () => {
		const { sqlite, context, event } = fixture();
		for (const [id, status] of [
			["waiting", "queued"],
			["dispatch-failed", "failed"],
			["question", "needs_delegation"],
			["approval", "requires_approval"],
		]) {
			event(id, id);
			sqlite
				.prepare("UPDATE kernel_runtime_events SET payload=? WHERE id=?")
				.run(JSON.stringify({ status }), id);
		}
		const page = await pollHomeRunFinished(
			context("owner-example"),
			start,
			"org-example",
		);
		expect(
			page.events.map((e) => [e.data.run_id, e.data.status]).sort(),
		).toEqual([
			["approval", "needs_input"],
			["dispatch-failed", "failed"],
			["question", "needs_input"],
		]);
	});

	it("dedupes repeated ledger records and resumes after pauses and failures", async () => {
		const { context, event } = fixture();
		event("a", "done");
		event("duplicate", "done");
		event("b", "failed", "run.failed");
		event("c", "paused", "approval.requested");
		const page = await pollHomeRunFinished(
			context("owner-example"),
			start,
			"org-example",
		);
		expect(page.events.map((e) => e.data.status).sort()).toEqual([
			"completed",
			"failed",
			"needs_input",
		]);
		expect(
			(
				await pollHomeRunFinished(
					context("owner-example"),
					{ ...start, after: page.after },
					"org-example",
				)
			).events,
		).toEqual([]);
		expect(
			(
				await pollHomeRunFinished(
					context("owner-example"),
					{ limit: 10 },
					"org-example",
				)
			).events,
		).toEqual([]);
	});
});
