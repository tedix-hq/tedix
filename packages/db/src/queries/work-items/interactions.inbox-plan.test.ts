import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	workInteractionAttention,
	workInteractionDeliveries,
	workInteractionResponses,
	workInteractions,
} from "../../schema/work-factory";
import { createD1Facade } from "../../test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "../../test/schema-ddl";
import {
	listLastRelatedDecisions,
	listWorkInteractionInbox,
} from "./interactions";

it("pages the inbox without related history and evaluates history only for requested cards", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		`${canonicalWorkFactoryDdl()}\n${schemaDdl(workInteractions, workInteractionResponses, workInteractionAttention, workInteractionDeliveries)}`,
	);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		"INSERT INTO work_items(id,org_id,title,created_at) VALUES ('work','org','Example','2026-01-01')",
	);
	const insert = sqlite.prepare(`INSERT INTO work_interactions
		(id,org_id,work_item_id,kind,status,subject,prompt,creator_type,creator_id,target_type,target_id,created_at)
		VALUES (?,'org','work','question',?,'Example','?','system','example','tedi','cto',?)`);
	for (let i = 0; i < 500; i++) {
		insert.run(`request-${String(i).padStart(4, "0")}`, "open", "2026-01-02");
	}
	insert.run("previous", "resolved", "2026-01-01");
	sqlite.exec(`INSERT INTO work_interaction_responses
		(id,org_id,interaction_id,response_kind,body,responder_type,responder_id,resolves_request,responded_at,resolved_request_version,resolution_fence)
		VALUES ('answer','org','previous','answer','Keep the service','tedi','cto',1,'2026-01-01',1,'fence')`);
	const plans: string[] = [];
	const statements: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				statements.push(query);
				plans.push(
					...sqlite
						.prepare(`EXPLAIN QUERY PLAN ${query}`)
						.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
						.map((row) => String(row.detail)),
				);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	const first = await listWorkInteractionInbox(db, {
		orgId: "org",
		targetType: "tedi",
		targetId: "cto",
		states: ["open"],
		observedAt: "2026-01-03",
		limit: 1,
	});
	expect(first.data.map((row) => row.request.id)).toEqual(["request-0499"]);
	expect(first.hasMore).toBe(true);
	expect(statements.some((query) => query.includes("json_each"))).toBe(false);
	statements.length = 0;
	const decisions = await listLastRelatedDecisions(
		db,
		"org",
		Array.from(
			{ length: 50 },
			(_, i) => `request-${String(i).padStart(4, "0")}`,
		),
	);
	expect(decisions).toHaveLength(50);
	expect(
		decisions.every((row) => row.decision?.body === "Keep the service"),
	).toBe(true);
	// Cards, then the recipient's requests and their answers, however many cards.
	expect(statements).toHaveLength(3);
	const historyPlan = sqlite
		.prepare(`EXPLAIN QUERY PLAN ${statements[1]}`)
		.all(...Array((statements[1]!.match(/\?/g) ?? []).length).fill(null))
		.map((row) => String(row.detail));
	expect(historyPlan[0]).toMatch(
		/^SEARCH prior USING INDEX idx_work_interactions_target_status/,
	);
	expect(historyPlan.some((plan) => plan.includes("TEMP B-TREE"))).toBe(false);
	expect(plans).toContainEqual(
		expect.stringMatching(
			/(?:CO-ROUTINE|MATERIALIZE) work_interaction_inbox_page/,
		),
	);
	const next = await listWorkInteractionInbox(db, {
		orgId: "org",
		targetType: "tedi",
		targetId: "cto",
		states: ["open"],
		observedAt: "2026-01-03",
		limit: 1,
		cursor: first.nextCursor!,
	});
	expect(next.data.map((row) => row.request.id)).toEqual(["request-0498"]);
	for (let i = 0; i < 501; i++) {
		insert.run(`history-${i}`, "resolved", "2026-01-02");
	}
	statements.length = 0;
	const olderDecisions = await listLastRelatedDecisions(
		db,
		"org",
		Array.from(
			{ length: 50 },
			(_, i) => `request-${String(i).padStart(4, "0")}`,
		),
	);
	expect(olderDecisions).toHaveLength(50);
	expect(
		olderDecisions.every((row) => row.decision?.requestId === "previous"),
	).toBe(true);
	// One card read, one recipient read, and six answer batches for 502 requests.
	expect(statements).toHaveLength(8);
	expect(
		statements.filter((query) => query.includes('"work_interactions" "prior"')),
	).toHaveLength(1);
	expect(statements.some((query) => query.includes("json_each"))).toBe(false);
	sqlite.close();
});
