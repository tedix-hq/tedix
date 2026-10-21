import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	workItems,
	workAttempts,
	workItemRelations,
} from "../../schema/work-items";
import { listDeckSourceStates } from "./deck-sweep";
const now = new Date("2026-10-22T12:00:00Z");
it("uses tenant-scoped dependencies and latest Attempts with D1-safe chunks", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(workItems, workAttempts, workItemRelations));
	// schemaDdl omits index predicates; restore the real active-Attempt uniqueness rule.
	sqlite.exec(
		"DROP INDEX uniq_work_attempt_active; CREATE UNIQUE INDEX uniq_work_attempt_active ON work_attempts(org_id,work_item_id) WHERE runtime_state IN ('queued','running','waiting','retrying')",
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const insert = sqlite.prepare(
		"INSERT INTO work_items(id,org_id,title,disposition,created_at) VALUES(?,?,?,?,?)",
	);
	for (let i = 0; i < 105; i++)
		insert.run(
			`maple-${i}`,
			"fictional-maple",
			"Orchard audit",
			"accepted",
			now.toISOString(),
		);
	insert.run(
		"other",
		"fictional-river",
		"Other tenant",
		"completed",
		now.toISOString(),
	);
	sqlite
		.prepare(
			"INSERT INTO work_item_relations(id,org_id,from_work_item_id,to_work_item_id,relation_type,created_at) VALUES(?,?,?,?,?,?)",
		)
		.run(
			"dep",
			"fictional-maple",
			"maple-1",
			"maple-0",
			"blocks",
			now.toISOString(),
		);
	const attempt = sqlite.prepare(
		"INSERT INTO work_attempts(id,org_id,work_item_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at,expires_at,finished_at,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
	);
	attempt.run(
		"expired",
		"fictional-maple",
		"maple-2",
		"external_agent",
		"orchard",
		"expired",
		1,
		now.toISOString(),
		now.toISOString(),
		"2026-10-21T12:00:00Z",
		now.toISOString(),
		"expired",
	);
	attempt.run(
		"renewed",
		"fictional-maple",
		"maple-2",
		"external_agent",
		"orchard",
		"running",
		2,
		now.toISOString(),
		now.toISOString(),
		"2026-10-23T12:00:00Z",
		null,
		null,
	);
	attempt.run(
		"lease-lapsed",
		"fictional-maple",
		"maple-3",
		"external_agent",
		"orchard",
		"running",
		1,
		now.toISOString(),
		now.toISOString(),
		"2026-10-21T12:00:00Z",
		null,
		null,
	);
	const states = await listDeckSourceStates(
		db,
		"fictional-maple",
		[...Array.from({ length: 105 }, (_, i) => `maple-${i}`), "other"],
		now,
	);
	expect(states.size).toBe(105);
	expect(states.get("maple-0")).toBe("blocked");
	expect(states.get("maple-2")).toBe("accepted");
	expect(states.get("maple-3")).toBe("expired");
	expect(states.has("other")).toBe(false);
	sqlite
		.prepare("UPDATE work_items SET disposition='completed' WHERE id='maple-1'")
		.run();
	expect(
		(
			await listDeckSourceStates(
				db,
				"fictional-maple",
				["maple-0", "maple-1"],
				now,
			)
		).get("maple-0"),
	).toBe("accepted");
	sqlite.close();
});
