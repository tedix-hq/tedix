import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	workItems,
	workAttempts,
	workItemComments,
} from "../../schema/work-items";
import { workInteractions } from "../../schema/work-factory";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { reassignIdleWork } from "./idle-reassignment";

const now = "2026-11-07T22:00:00.000Z";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(workItems, workAttempts, workItemComments, workInteractions),
	);
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,description,created_at,disposition,version,project_id,acceptance_contract,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)",
		)
		.run(
			"work",
			"org-acme",
			"Fix widget",
			"Correct widget sizing",
			now,
			"accepted",
			3,
			"project",
			JSON.stringify({ version: 1, doneLooksLike: "Sizing corrected" }),
			JSON.stringify({ executor: "codex", laneDispatch: { state: "ready" } }),
		);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const input = {
		orgId: "org-acme",
		workItemId: "work",
		expectedVersion: 3,
		executor: "opencode",
		fromExecutor: "codex",
		unavailableSince: "2026-11-07T21:45:00.000Z",
		minimumIdleMinutes: 15,
		reason: "busy" as const,
		now,
	};
	const attempt = (n: number, outcome: string | null = "failed", version = 3) =>
		sqlite
			.prepare(
				"INSERT INTO work_attempts(id,org_id,work_item_id,attempt_number,runtime_state,outcome,executor_type,executor_id,started_at,heartbeat_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
			)
			.run(
				`attempt-${n}`,
				"org-acme",
				"work",
				n,
				outcome ? "settled" : "running",
				outcome,
				"external_agent",
				"example-agent",
				now,
				now,
				JSON.stringify({ dispatchVersion: version }),
			);
	return { sqlite, db, input, attempt };
}

it("reassigns at the threshold with one visible reason while preserving revision and two failures", async () => {
	const { sqlite, db, input, attempt } = fixture();
	try {
		attempt(1);
		attempt(2, "expired");
		const result = await reassignIdleWork(db, input);
		expect(result.version).toBe(3);
		expect(result.admissionSpecRevision).not.toBe("legacy");
		expect(result.metadata?.executor).toBe("opencode");
		expect(sqlite.prepare("SELECT body FROM work_item_comments").all()).toEqual(
			[
				{
					body: expect.stringContaining(
						"Reassigned from codex to opencode: assigned runner busy",
					),
				},
			],
		);
		await expect(reassignIdleWork(db, input)).rejects.toThrow();
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_item_comments").get()?.n,
		).toBe(1);
		// A third failure on this same revision still holds after reassignment.
		attempt(3);
		await expect(
			reassignIdleWork(db, {
				...input,
				executor: "devin",
				fromExecutor: "opencode",
			}),
		).rejects.toThrow();
	} finally {
		sqlite.close();
	}
});

it.each([
	"threshold",
	"version",
	"executor",
	"three failures",
	"live attempt",
	"human wait",
	"deferred",
	"capability",
	"authority",
	"named harness",
	"harness tag",
	"explicit requirement",
	"reserved",
	"held coordinator",
	"future",
	"unaccepted",
	"wrong org",
])("preserves assignment and leaves no receipt for %s", async (reason) => {
	const { sqlite, db, input, attempt } = fixture();
	try {
		if (reason === "threshold")
			input.unavailableSince = "2026-11-07T21:46:00.000Z";
		if (reason === "version") input.expectedVersion = 2;
		if (reason === "executor") input.fromExecutor = "devin";
		if (reason === "wrong org") input.orgId = "other-org";
		if (reason === "three failures") {
			attempt(1);
			attempt(2);
			attempt(3);
		}
		if (reason === "live attempt") attempt(1, null);
		if (reason === "deferred") attempt(1, "cancelled");
		if (reason === "human wait")
			sqlite
				.prepare(
					"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,created_at) VALUES('ask','org-acme','work','question','Owner input','Need input','user','example-owner',?)",
				)
				.run(now);
		if (reason === "capability")
			sqlite.exec(`UPDATE work_items SET required_capabilities='["browser"]'`);
		if (reason === "authority")
			sqlite.exec(`UPDATE work_items SET required_authorities='["owner"]'`);
		if (reason === "named harness")
			sqlite.exec("UPDATE work_items SET description='Use Claude Code only'");
		if (reason === "harness tag")
			sqlite.exec(
				`UPDATE work_items SET metadata=json_set(metadata,'$.tags',json('["requires:codex"]'))`,
			);
		if (reason === "explicit requirement")
			sqlite.exec(
				`UPDATE work_items SET metadata=json_set(metadata,'$.requiredExecutor','codex')`,
			);
		if (reason === "reserved")
			sqlite.exec("UPDATE work_items SET description='Complete OAuth consent'");
		if (reason === "held coordinator")
			sqlite.exec(
				`UPDATE work_items SET metadata=json_set(metadata,'$.laneDispatch.state','held')`,
			);
		if (reason === "future")
			sqlite.exec("UPDATE work_items SET start_at='2026-11-08T00:00:00.000Z'");
		if (reason === "unaccepted")
			sqlite.exec("UPDATE work_items SET disposition='proposed'");
		await expect(reassignIdleWork(db, input)).rejects.toThrow();
		expect(
			sqlite
				.prepare(
					"SELECT json_extract(metadata,'$.executor') AS executor FROM work_items",
				)
				.get()?.executor,
		).toBe("codex");
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_item_comments").get()?.n,
		).toBe(0);
	} finally {
		sqlite.close();
	}
});
