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
	let evaluations = 0;
	sqlite.function("observe_related_decision", (value) => {
		evaluations++;
		return value;
	});
	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (query.includes("work_interaction_inbox_page"))
					plans.push(
						...sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
							.map((row) => String(row.detail)),
					);
				if (query.includes('"last_related_decision"')) {
					// An identity function counts actual SQLite evaluations without replacing JSON or the query's joins.
					query = query
						.replace(
							"SELECT json_object('requestId'",
							"SELECT observe_related_decision(json_object('requestId'",
						)
						.replace(
							"'decidedAt', answer.responded_at)",
							"'decidedAt', answer.responded_at))",
						);
				}
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
	expect(evaluations).toBe(0);
	const [decision] = await listLastRelatedDecisions(db, "org", [
		"request-0499",
	]);
	expect(JSON.parse(decision!.decision!).body).toBe("Keep the service");
	expect(evaluations).toBe(1);
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
	expect(evaluations).toBe(1);
	sqlite.close();
});
