import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { listSkillRetrievalUtility } from "./skill-retrieval-utility";

const ORG = "11111111-1111-4111-8111-111111111111";
const TEDI = "22222222-2222-4222-8222-222222222222";
const SKILL = "33333333-3333-4333-8333-333333333333";
const TURN = "44444444-4444-4444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555";
const INJECTION = "66666666-6666-4666-8666-666666666666";
const FROM = "2026-09-24T00:00:00.000Z";
const TO = "2026-09-24T01:00:00.000Z";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE tedi_runtime_events (
			id TEXT PRIMARY KEY, organization_id TEXT, tedi_id TEXT,
			conversation_id TEXT, run_id TEXT, kind TEXT, payload TEXT,
			created_at TEXT
		);
		CREATE TABLE skill_runs (
			id TEXT PRIMARY KEY, organization_id TEXT, tedi_id TEXT,
			skill_id TEXT, origin_tedi_run_id TEXT
		);
		CREATE TABLE skill_usage_events (
			id TEXT PRIMARY KEY, organization_id TEXT, tedi_id TEXT,
			skill_id TEXT, run_id TEXT, source TEXT, outcome TEXT
		);
	`);
	const db = createDbClient(createD1Facade(sqlite));
	const insertEvent = (
		id: string,
		runId: string,
		kind: string,
		payload: unknown,
	) =>
		sqlite
			.prepare(`INSERT INTO tedi_runtime_events
			(id, organization_id, tedi_id, conversation_id, run_id, kind, payload, created_at)
			VALUES (?, ?, ?, 'conversation-1', ?, ?, ?, '2026-09-24T00:30:00.000Z')`)
			.run(id, ORG, TEDI, runId, kind, JSON.stringify(payload));
	insertEvent(INJECTION, TURN, "context.injected", {
		source: "skill-retrieval",
		phase: "pre-turn-injection",
		skills: [{ skillId: SKILL }],
	});
	return { sqlite, db, insertEvent };
}

describe("skill retrieval utility", () => {
	it("requires same-turn completion, canonical origin, skill, and terminal usage", async () => {
		const { sqlite, db, insertEvent } = fixture();
		insertEvent(
			"77777777-7777-4777-8777-777777777777",
			TURN,
			"tool.completed",
			{
				name: "tedix_mcp_code",
				resultIdentity: { skillWorkflowRuns: [RUN] },
			},
		);
		sqlite
			.prepare(`INSERT INTO skill_runs VALUES (?, ?, ?, ?, ?)`)
			.run(RUN, ORG, TEDI, SKILL, TURN);
		sqlite
			.prepare(`INSERT INTO skill_usage_events VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run(
				"88888888-8888-4888-8888-888888888888",
				ORG,
				TEDI,
				SKILL,
				RUN,
				"workflow_run",
				"success",
			);
		const result = await listSkillRetrievalUtility(db, {
			organizationId: ORG,
			tediId: TEDI,
			from: FROM,
			to: TO,
		});
		expect(result.rows).toMatchObject([{ status: "success", skillRunId: RUN }]);
		expect(result.truncated).toBe(false);
	});

	it("keeps injection unknown when a completed workflow belongs to another turn", async () => {
		const { sqlite, db, insertEvent } = fixture();
		insertEvent(
			"77777777-7777-4777-8777-777777777777",
			TURN,
			"tool.completed",
			{
				name: "tedix_mcp_code",
				resultIdentity: { skillWorkflowRuns: [RUN] },
			},
		);
		sqlite
			.prepare(`INSERT INTO skill_runs VALUES (?, ?, ?, ?, ?)`)
			.run(RUN, ORG, TEDI, SKILL, "99999999-9999-4999-8999-999999999999");
		sqlite
			.prepare(`INSERT INTO skill_usage_events VALUES (?, ?, ?, ?, ?, ?, ?)`)
			.run(
				"88888888-8888-4888-8888-888888888888",
				ORG,
				TEDI,
				SKILL,
				RUN,
				"workflow_run",
				"success",
			);
		const result = await listSkillRetrievalUtility(db, {
			organizationId: ORG,
			tediId: TEDI,
			from: FROM,
			to: TO,
		});
		expect(result.rows).toMatchObject([
			{ status: "unknown", skillRunId: null },
		]);
	});
});
