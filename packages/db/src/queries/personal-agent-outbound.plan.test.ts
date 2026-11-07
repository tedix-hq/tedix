import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { listPendingPersonalAgentEmails } from "./personal-agent-outbound";

it("sweeps pending personal-agent emails through the outcome index, not every work event", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				if (query.includes('"enrollment"'))
					plans.push(
						...sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
							.map((row) => String(row.detail)),
					);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}) as never,
	);
	await listPendingPersonalAgentEmails(db as never);
	expect(plans[0], plans.join("\n")).toMatch(
		/^SCAN o USING INDEX idx_work_events_personal_outcome_sequence/,
	);
});
