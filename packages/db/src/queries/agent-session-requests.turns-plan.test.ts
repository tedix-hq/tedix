import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { agentSessionEvents } from "../schema/agent-session-requests";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	listAgentSessionBodiesForRetention,
	listRecentAgentSessionTurns,
} from "./agent-session-requests";

it("seeks a session's last turns without walking every turn body", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec("PRAGMA foreign_keys=OFF");
		sqlite.exec(schemaDdl(agentSessionEvents));
		const insert = sqlite.prepare(`INSERT INTO agent_session_events
			(id, organization_id, user_id, harness, session_key, kind, body, source_at, source_key, status, created_at)
			VALUES (?, 'org-example', 'user-example', 'claude-code', 'session-example', ?, 'turn text', ?, ?, 'processed', ?)`);
		sqlite.exec("BEGIN");
		for (let i = 0; i < 3_000; i++) {
			const at = new Date(Date.UTC(2026, 0, 1) + i * 1_000).toISOString();
			insert.run(
				`event-${i}`,
				i % 3 === 0 ? "turn" : "tool",
				at,
				`key-${i}`,
				at,
			);
		}
		sqlite.exec("COMMIT; ANALYZE");
		const statements: string[] = [];
		const db = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare: (statement) => statements.push(statement),
			}),
		);
		const turns = await listRecentAgentSessionTurns(db, {
			organizationId: "org-example",
			userId: "user-example",
			harness: "claude-code",
			sessionKey: "session-example",
			before: "2027-01-01T00:00:00.000Z",
		});
		expect(turns).toHaveLength(3);
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${statements[0]}`)
			.all(...Array((statements[0]!.match(/\?/g) ?? []).length).fill("x"))
			.map((row) => String(row.detail))
			.join(" | ");
		expect(plan).toContain("idx_agent_session_events_session_kind_order");
		expect(plan).not.toContain("TEMP B-TREE");
	} finally {
		sqlite.close();
	}
});

it("seeks old processed bodies through the partial retention index", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(schemaDdl(agentSessionEvents));
		const statements: string[] = [];
		const db = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare: (statement) => statements.push(statement),
			}),
		);
		const before = "2026-10-01T00:00:00.000Z";
		await listAgentSessionBodiesForRetention(db, before);
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${statements[0]}`)
			.all("processed", before, 100)
			.map((row) => String(row.detail))
			.join(" | ");
		expect(plan).toContain("idx_agent_session_events_body_retention");
		expect(plan).not.toContain("TEMP B-TREE");
	} finally {
		sqlite.close();
	}
});
