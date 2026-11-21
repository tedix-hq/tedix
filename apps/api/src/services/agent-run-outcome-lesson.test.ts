import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { installOrganizationLogFixture } from "../../test/organization-log-fixture";
import type { BaseContext } from "../rpc/orpc";
import {
	agentRunOutcomeLesson,
	OUTCOME_LESSON_LIMIT,
	recordAgentRunOutcomeLesson,
} from "./agent-run-outcome-lesson";

const ORG = "00000000-0000-4000-8000-000000000501";
const TEDI = "starting-tedi";
const RUN = "00000000-0000-4000-8000-000000000502";
const ATTEMPT = "00000000-0000-4000-8000-000000000503";
const SHA = "a".repeat(40);

const work = {
	id: RUN,
	orgId: ORG,
	title: "Fix the date filter",
	executorId: "codex",
	stewardType: "tedi" as const,
	stewardId: TEDI,
	metadata: { source: "tedi.start_agent_run" },
};
const attempt = {
	id: ATTEMPT,
	executorType: "external_agent" as const,
	outcome: "succeeded" as const,
	summary: "Result:\nFixed the off-by-one in the range and added a test.",
	attemptNumber: 1,
	startedAt: "2026-10-10T12:00:00.000Z",
	finishedAt: "2026-10-10T12:14:00.000Z",
	metadata: { laneResult: { commitSha: SHA } },
};

createMigratedSqlite({ foreignKeys: false }).close();
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

describe("agentRunOutcomeLesson", () => {
	it("says what was asked, how it ended, what the run reported and the commit", () => {
		expect(agentRunOutcomeLesson(work, attempt)).toEqual({
			tediId: TEDI,
			summary: "Agent run succeeded: Fix the date filter",
			content: `Agent run I started: asked codex to "Fix the date filter". Outcome: succeeded after 14 min (run 1). Commit the run declared: ${SHA}. What the run reported: Fixed the off-by-one in the range and added a test. Task: /work/items/${RUN}`,
			source: `work-attempt://${ATTEMPT}/outcome`,
			topicKey: `agent-run-outcome:${ATTEMPT}`,
			metadata: {
				producer: "agent-run-outcome",
				workItemId: RUN,
				attemptId: ATTEMPT,
				outcome: "succeeded",
				executor: "codex",
			},
		});
		expect(
			agentRunOutcomeLesson(work, {
				...attempt,
				outcome: "failed",
				summary: "Failed: the type-check did not pass",
				metadata: {},
			})?.content,
		).toBe(
			`Agent run I started: asked codex to "Fix the date filter". Outcome: failed after 14 min (run 1). What went wrong, as the run reported it: the type-check did not pass Task: /work/items/${RUN}`,
		);
	});

	it("stays bounded and keeps out code blocks and anything that looks like a secret", () => {
		const long = agentRunOutcomeLesson(
			{ ...work, title: "t".repeat(900) },
			{
				...attempt,
				summary: `Done. \`\`\`\n$ cat .env\nDATABASE_URL=postgres://example\n\`\`\` ${"word ".repeat(400)}`,
			},
		)!;
		expect(long.content.length).toBeLessThanOrEqual(OUTCOME_LESSON_LIMIT);
		expect(long.content).not.toContain("DATABASE_URL");
		expect(long.content).not.toContain("cat .env");
		const leaked = agentRunOutcomeLesson(work, {
			...attempt,
			summary: "Used api_key=abcdefghijklmnopqrstuvwxyz012345 to call it",
		})!;
		expect(leaked.content).not.toContain("abcdefghijklmnop");
		expect(leaked.content).toContain("Outcome: succeeded");
	});

	it("is only for an ended agent run that a tedi started", () => {
		for (const [w, a] of [
			[{ ...work, metadata: { source: "elsewhere" } }, attempt],
			[{ ...work, stewardType: "user" as const }, attempt],
			[work, { ...attempt, outcome: null }],
			[work, { ...attempt, executorType: "tedi" as const }],
		] as const)
			expect(agentRunOutcomeLesson(w, a)).toBeNull();
	});
});

describe("recordAgentRunOutcomeLesson", () => {
	function fixture() {
		const sqlite = createMigratedSqlite({ foreignKeys: false });
		databases.push(sqlite);
		sqlite.exec("PRAGMA recursive_triggers = OFF");
		for (const { name } of sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
			.all() as { name: string }[])
			sqlite.exec(`DROP TRIGGER "${name}"`);
		sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES('${ORG}','Example','example');
			INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('${TEDI}','${ORG}','Lead','lead','active');
			INSERT INTO work_items(id,org_id,title,disposition,admission_spec_revision,created_at) VALUES('${RUN}','${ORG}','Fix the date filter','accepted','fixture','2026-10-10T12:00:00.000Z');
			INSERT INTO work_attempts(id,work_item_id,org_id,executor_type,executor_id,executor_session_id,external_session_key,runtime_state,outcome,attempt_number,started_at,heartbeat_at,finished_at)
				VALUES('${ATTEMPT}','${RUN}','${ORG}','external_agent','agent','session','codex:session','finished','succeeded',1,'2026-10-10T12:00:00.000Z','2026-10-10T12:00:00.000Z','2026-10-10T12:14:00.000Z');`);
		const facade = createD1Facade(sqlite);
		const context = {
			db: createDbClient(facade),
			env: { ENVIRONMENT: "test", DB: facade } as CloudflareEnv,
			headers: new Headers(),
			url: new URL("https://api.tedix.test/rpc/workItems"),
		} as BaseContext;
		return { sqlite, context };
	}

	it("stores the lesson for the Attempt's tedi", async () => {
		const { context } = fixture();
		const learn = vi.fn(async () => undefined);
		expect(
			await recordAgentRunOutcomeLesson(context, work, attempt, learn),
		).toBe("stored");
		expect(learn).toHaveBeenCalledTimes(1);
		expect(learn.mock.calls[0]![1]).toMatchObject({ tediId: TEDI });
	});

	it("writes through the memory learn path as the tedi's own private fact, then wakes the tedi once to update its memory", async () => {
		const { sqlite, context } = fixture();
		installOrganizationLogFixture();
		const wakes: Record<string, unknown>[] = [];
		context.env.TEDI_SERVICE = {
			fetch: async (request: Request) => {
				wakes.push((await request.json()) as Record<string, unknown>);
				return Response.json({ accepted: true, run_id: "run" });
			},
		} as unknown as CloudflareEnv["TEDI_SERVICE"];
		expect(await recordAgentRunOutcomeLesson(context, work, attempt)).toBe(
			"stored",
		);
		expect(wakes).toHaveLength(1);
		expect(wakes[0]).toMatchObject({
			session_key: `core-memory-reflection:${TEDI}`,
			client_request_id: `core-memory-reflection:${ORG}:${TEDI}:run:${ATTEMPT}`,
			text: expect.stringContaining("Outcome: succeeded after 14 min"),
		});
		const facts = sqlite
			.prepare(
				"SELECT tedi_id, visibility, memory_scope, fact_type, topic_key, source, content FROM memory_facts WHERE organization_id = ?",
			)
			.all(ORG);
		expect(facts).toMatchObject([
			{
				tedi_id: TEDI,
				visibility: "private",
				memory_scope: "tedi",
				fact_type: "episode",
				topic_key: `agent-run-outcome:${ATTEMPT}`,
				source: `work-attempt://${ATTEMPT}/outcome`,
				content: expect.stringContaining("Outcome: succeeded after 14 min"),
			},
		]);
	});
});
