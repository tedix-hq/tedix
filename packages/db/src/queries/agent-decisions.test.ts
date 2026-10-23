import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { listAgentDecisionJournal } from "./agent-decisions";

function fixture() {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
	const statement = sqlite.prepare(`INSERT INTO learning_interaction_events
		(id, organization_id, actor_type, actor_id, client_event_id, event_kind,
		 scope_kind, scope_id, surface, thread_id, occurred_at, issue_key, target_type, target_id)
		VALUES (?, ?, 'user', ?, ?, ?, 'organization', ?, 'agent_decision', ?, ?, 'review', ?, ?)`);
	function insert(
		id: string,
		actorId: string,
		threadId: string,
		seconds: number,
		organizationId = "example-org",
		targetId: string | null = null,
	) {
		statement.run(
			id,
			organizationId,
			actorId,
			id,
			targetId ? "accepted" : "decided",
			organizationId,
			threadId,
			new Date(Date.UTC(2026, 9, 22) + seconds * 1000).toISOString(),
			targetId ? "agent_decision" : null,
			targetId,
		);
	}
	return { db, insert };
}

describe("agent decision journal identity scopes", () => {
	it("keeps all identity scopes within D1 limits and merges the newest decisions once", async () => {
		const { db, insert } = fixture();
		for (let index = 0; index < 120; index++) {
			insert(
				`d${index}`,
				`person-${index % 60}`,
				`session-${index % 100}`,
				index,
			);
		}
		insert("session-only", "another-person", "session-99", 300);
		insert("other-tenant", "person-59", "session-99", 500, "another-org");
		insert("other-person", "another-person", "another-session", 600);
		insert("outcome", "reviewer", "review-session", 400, "example-org", "d119");
		insert(
			"foreign-outcome",
			"reviewer",
			"review-session",
			400,
			"another-org",
			"d119",
		);
		const rows = await listAgentDecisionJournal(db, {
			organizationId: "example-org",
			since: "2026-10-21T00:00:00.000Z",
			limit: 20,
			issueKey: "review",
			recordedBy: {
				actors: Array.from({ length: 60 }, (_, index) => ({
					actorType: "user" as const,
					actorId: `person-${index}`,
				})),
				threadIds: Array.from(
					{ length: 100 },
					(_, index) => `session-${index}`,
				),
			},
		});
		expect(rows.map((row) => row.id)).toEqual([
			"session-only",
			...Array.from({ length: 19 }, (_, index) => `d${119 - index}`),
			"outcome",
		]);
	});

	it("returns no decisions for an explicitly empty identity scope", async () => {
		const { db, insert } = fixture();
		insert("private", "another-person", "another-session", 0);
		expect(
			await listAgentDecisionJournal(db, {
				organizationId: "example-org",
				since: "2026-10-21T00:00:00.000Z",
				limit: 20,
				recordedBy: { actors: [], threadIds: [] },
			}),
		).toEqual([]);
	});
});
