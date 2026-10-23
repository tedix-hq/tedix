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
import { projects } from "../../schema/projects";
import { tediObjectives } from "../../schema/tedi-objectives";
import { decisionEdges } from "../../schema/decision-graph";
import {
	listCardObjectives,
	listDeckSourceObjectives,
	listDeckSourceStates,
} from "./deck-sweep";
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

it("resolves the objective each Work item serves, own before project", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(workItems, projects, tediObjectives, decisionEdges));
	const db = createDbQueryClient(createD1Facade(sqlite));
	const objective = sqlite.prepare(
		"INSERT INTO tedi_objectives(id,tedi_id,org_id,title,status,priority,created_at) VALUES(?,?,?,?,?,?,?)",
	);
	objective.run(
		"grow",
		"t",
		"fictional-maple",
		"Grow orchard sales",
		"active",
		1,
		now.toISOString(),
	);
	objective.run(
		"keep",
		"t",
		"fictional-maple",
		"Keep the cellar dry",
		"active",
		2,
		now.toISOString(),
	);
	objective.run(
		"old",
		"t",
		"fictional-maple",
		"Old harvest",
		"completed",
		0,
		now.toISOString(),
	);
	objective.run(
		"foreign",
		"t",
		"fictional-river",
		"Other tenant",
		"active",
		0,
		now.toISOString(),
	);
	const project = sqlite.prepare(
		"INSERT INTO projects(id,org_id,key,name,objective_id,created_at) VALUES(?,?,?,?,?,?)",
	);
	project.run(
		"cellar",
		"fictional-maple",
		"CEL",
		"Cellar",
		"keep",
		now.toISOString(),
	);
	project.run(
		"archive",
		"fictional-maple",
		"ARC",
		"Archive",
		"old",
		now.toISOString(),
	);
	const item = sqlite.prepare(
		"INSERT INTO work_items(id,org_id,title,disposition,work_class,objective_id,project_id,created_at) VALUES(?,?,?,?,?,?,?,?)",
	);
	item.run(
		"own",
		"fictional-maple",
		"Pitch",
		"accepted",
		"objective",
		"grow",
		"cellar",
		now.toISOString(),
	);
	item.run(
		"inherits",
		"fictional-maple",
		"Fix pump",
		"accepted",
		"maintenance",
		"grow",
		"cellar",
		now.toISOString(),
	);
	item.run(
		"inactive",
		"fictional-maple",
		"Tidy",
		"accepted",
		null,
		null,
		"archive",
		now.toISOString(),
	);
	item.run(
		"none",
		"fictional-maple",
		"Loose",
		"accepted",
		null,
		null,
		null,
		now.toISOString(),
	);
	item.run(
		"cross",
		"fictional-maple",
		"Leak",
		"accepted",
		"objective",
		"foreign",
		null,
		now.toISOString(),
	);
	const served = await listDeckSourceObjectives(db, "fictional-maple", [
		"own",
		"inherits",
		"inactive",
		"none",
		"cross",
	]);
	expect(Object.fromEntries(served)).toEqual({
		own: { id: "grow", title: "Grow orchard sales", priority: 1, top: true },
		inherits: {
			id: "keep",
			title: "Keep the cellar dry",
			priority: 2,
			top: false,
		},
	});
	// The top objective is the organization's, even when no card serves it.
	objective.run(
		"north",
		"t",
		"fictional-maple",
		"Unlinked north star",
		"active",
		0,
		now.toISOString(),
	);
	expect(
		(await listDeckSourceObjectives(db, "fictional-maple", ["own"])).get("own")
			?.top,
	).toBe(false);
	sqlite.exec("UPDATE tedi_objectives SET status='paused' WHERE id='north'");
	sqlite
		.prepare(
			"INSERT INTO decision_edges(id,org_id,kind,from_kind,from_id,to_kind,to_id,source,confidence,occurred_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
		)
		.run(
			"edge",
			"fictional-maple",
			"card_from_work",
			"deck_card",
			"card-edge",
			"work_item",
			"own",
			"backfill",
			1,
			now.toISOString(),
			now.toISOString(),
			now.toISOString(),
		);
	const cards = await listCardObjectives(db, "fictional-maple", [
		{ id: "card-edge", workItemId: null },
		{ id: "card-own", workItemId: "inherits" },
		{ id: "card-none" },
	]);
	expect(Object.fromEntries(cards)).toEqual({
		"card-edge": {
			id: "grow",
			title: "Grow orchard sales",
			priority: 1,
			top: true,
		},
		"card-own": {
			id: "keep",
			title: "Keep the cellar dry",
			priority: 2,
			top: false,
		},
	});
	sqlite.close();
});
