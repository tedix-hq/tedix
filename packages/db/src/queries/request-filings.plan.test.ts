import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { listRequestFilings } from "./request-filings";

it("seeks private filing history by tenant and ledger owner in chronological order", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const insert = sqlite.prepare(`INSERT INTO learning_interaction_events
		(id, organization_id, actor_type, client_event_id, event_kind, scope_kind, scope_id, surface, metadata, occurred_at, created_at)
		VALUES (?, ?, 'user', ?, 'edited', ?, ?, ?, ?, ?, ?)`);
	const now = "2026-10-10T10:00:00.000Z";
	for (let i = 0; i < 4000; i++) {
		insert.run(
			`noise-${i}`,
			"org-example",
			`noise-${i}`,
			"personal",
			"grace",
			"other",
			'{"ledgerOwnerId":"grace"}',
			now,
			now,
		);
	}
	for (const [id, org, owner, scope, surface] of [
		["private", "org-example", "ada", "personal", "request_filing"],
		["shared", "org-example", "ada", "project", "request_filing"],
		["foreign-owner", "org-example", "grace", "personal", "request_filing"],
		["foreign-tenant", "org-other", "ada", "personal", "request_filing"],
		["foreign-surface", "org-example", "ada", "personal", "other"],
	]) {
		insert.run(
			id,
			org,
			id,
			scope,
			scope === "project" ? "project-example" : owner,
			surface,
			JSON.stringify({ ledgerOwnerId: owner }),
			now,
			now,
		);
	}
	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
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
	const rows = await listRequestFilings(db, {
		organizationId: "org-example",
		userId: "ada",
	});
	expect(rows.map((row) => row.id)).toEqual(["shared", "private"]);
	expect(plans).toContainEqual(
		expect.stringMatching(
			/idx_learning_event_filing_owner_occurred.*organization_id=\? AND <expr>=\? AND surface=\?/,
		),
	);
	expect(
		plans.some((plan) =>
			/TEMP B-TREE|^SCAN learning_interaction_events/.test(plan),
		),
	).toBe(false);
	sqlite.close();
});
