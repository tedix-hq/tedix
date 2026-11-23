import { readFileSync } from "node:fs";
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
import { canonicalWorkFactoryDdl, tableDdl } from "../../test/schema-ddl";
import {
	listLastRelatedDecisions,
	listWorkInteractionInbox,
} from "./interactions";

it("pages the inbox without related history and evaluates history only for requested cards", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		`${canonicalWorkFactoryDdl()}\n${[workInteractions, workInteractionResponses, workInteractionAttention, workInteractionDeliveries].flatMap((table) => tableDdl(table)).join("\n")}`,
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
	// Apply the actual migration over existing answers, then exercise its write triggers below.
	sqlite.exec(
		readFileSync(
			new URL(
				"../../../drizzle/20261123091513_related_decision_history/migration.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	const plans: string[] = [];
	const statements: string[] = [];
	const returned: number[] = [];
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
				const statement = sqlite.prepare(query);
				return {
					all(...params: unknown[]) {
						const rows = statement.all(
							...(params as Parameters<typeof statement.all>),
						);
						returned.push(rows.length);
						return rows;
					},
					get: (...params: unknown[]) =>
						statement.get(...(params as Parameters<typeof statement.get>)),
					run: (...params: unknown[]) =>
						statement.run(...(params as Parameters<typeof statement.run>)),
				};
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
	expect(statements).toHaveLength(1);
	expect(statements.some((query) => query.includes("json_each"))).toBe(false);
	statements.length = 0;
	returned.length = 0;
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
	expect(statements).toHaveLength(1);
	expect(returned).toEqual([50]);
	expect(plans).toContainEqual(
		expect.stringMatching(
			/SEARCH work_interaction_decision_history USING COVERING INDEX idx_work_interaction_decision_history_latest \(org_id=\? AND target_type=\? AND target_id=\? AND relation_key=\?\)/,
		),
	);
	expect(
		plans.some((plan) =>
			/SCAN (?:p|work_interaction_decision_history)\b/.test(plan),
		),
	).toBe(false);
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
	sqlite.exec(`UPDATE work_interactions SET work_item_id='unrelated',
		metadata=json_object('unused', printf('%.*c',10000,'x')) WHERE id LIKE 'history-%';
		INSERT INTO work_interaction_responses
		(id,org_id,interaction_id,response_kind,body,responder_type,responder_id,resolves_request,responded_at,resolved_request_version,resolution_fence)
		SELECT 'answer-' || id,org_id,id,'answer',printf('%.*c',10000,'x'),'tedi','cto',1,'2026-01-02',1,id
		FROM work_interactions WHERE id LIKE 'history-%'`);
	statements.length = 0;
	returned.length = 0;
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
	expect(statements).toHaveLength(1);
	expect(returned).toEqual([50]);
	insert.run("old-slide", "expired", "2025-12-01");
	sqlite.exec(
		"UPDATE work_interactions SET subject='Keep the slide preview?' WHERE id='old-slide'",
	);
	const matches = await listWorkInteractionInbox(db, {
		orgId: "org",
		targetType: "tedi",
		targetId: "cto",
		states: ["resolved", "expired"],
		subjectSearch: "SLIDE preview",
		observedAt: "2026-01-03",
		limit: 1,
	});
	expect(matches.data.map((row) => row.request.id)).toEqual(["old-slide"]);
	sqlite.close();
});
