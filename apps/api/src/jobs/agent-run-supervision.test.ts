import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { tediRuntimeEvents } from "@tedix/db/schema/cognitive-runtime";
import { dispatcherHealthReports } from "@tedix/db/schema/dispatcher-health";
import { tedis } from "@tedix/db/schema/tedis";
import {
	workAttemptMessages,
	workAttemptSteps,
} from "@tedix/db/schema/work-items";
import { canonicalWorkFactoryDdl, schemaDdl } from "@tedix/db/test/schema-ddl";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { superviseAgentRuns } from "./agent-run-supervision";

const ORG = "00000000-0000-4000-8000-000000000401";
const TEDI = "supervising-tedi";
const RUN = "00000000-0000-4000-8000-000000000402";
const ATTEMPT = "00000000-0000-4000-8000-000000000403";
const T0 = Date.parse("2026-10-10T12:00:00.000Z");
const minutes = (n: number) => n * 60_000;
const at = (ms: number) => new Date(ms).toISOString();

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		canonicalWorkFactoryDdl() +
			schemaDdl(
				tedis,
				workAttemptSteps,
				workAttemptMessages,
				dispatcherHealthReports,
				tediRuntimeEvents,
			),
	);
	sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES('${ORG}','Example','example');
		INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('${TEDI}','${ORG}','Lead','lead','active');
		INSERT INTO work_items(id,org_id,title,work_kind,disposition,executor_type,executor_id,dispatch_state,steward_type,steward_id,source_session_key,metadata,work_class,purpose_exception_expires_at,admission_spec_revision,created_at)
			VALUES('${RUN}','${ORG}','Fix the date filter','coding','accepted','external_agent','codex','ready','tedi','${TEDI}','agent:main:chat-7','{"source":"tedi.start_agent_run"}','maintenance','2099-01-01T00:00:00.000Z','fixture','${at(T0)}');
		INSERT INTO work_attempts(id,work_item_id,org_id,executor_type,executor_id,executor_session_id,external_session_key,runtime_state,attempt_number,started_at,heartbeat_at,expires_at)
			VALUES('${ATTEMPT}','${RUN}','${ORG}','external_agent','agent','session','codex:session','running',1,'${at(T0)}','${at(T0)}','${at(T0 + minutes(600))}');`);
	const sent: {
		session_key: string;
		client_request_id: string;
		text: string;
	}[] = [];
	let failing = false;
	const tick = (now: number) =>
		superviseAgentRuns({
			db: createDbClient(createD1Facade(sqlite)),
			env: { ENVIRONMENT: "test" } as CloudflareEnv,
			now,
			send: async (request) => {
				if (failing) return new Response("down", { status: 503 });
				sent.push(await request.json());
				return Response.json(
					{ accepted: true, run_id: `run-${sent.length}` },
					{ status: 202 },
				);
			},
		});
	const step = (seq: number, when: number) =>
		sqlite.exec(
			`INSERT INTO work_attempt_steps(id,org_id,work_item_id,attempt_id,seq,at,kind,text) VALUES('step-${seq}','${ORG}','${RUN}','${ATTEMPT}',${seq},${when},'command','cat .env')`,
		);
	const stored = () =>
		JSON.parse(
			(
				sqlite
					.prepare(
						"SELECT json_extract(metadata,'$.agentRunSupervision') AS s FROM work_items WHERE id = ?",
					)
					.get(RUN) as { s: string | null }
			).s ?? "null",
		) as { rounds: number } | null;
	return {
		sqlite,
		sent,
		tick,
		step,
		stored,
		fail: (value: boolean) => (failing = value),
	};
}

describe("agent run supervision tick", () => {
	it("wakes the tedi in its supervision session, then only when a run changed or went silent", async () => {
		const { sent, tick, step, stored } = fixture();
		step(1, T0 + minutes(1));
		// Too early: the run is four minutes old.
		expect(await tick(T0 + minutes(4))).toMatchObject({
			supervisors: 1,
			notDue: 1,
			rounds: 0,
		});
		expect(await tick(T0 + minutes(6))).toMatchObject({ rounds: 1 });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			session_key: `agent-run-supervision:${TEDI}`,
			client_request_id: expect.stringContaining(`${ORG}:${TEDI}:`),
		});
		expect(sent[0]!.text).toContain(RUN);
		// The digest never carries what the agent wrote.
		expect(sent[0]!.text).not.toContain("cat .env");
		expect(stored()).toMatchObject({ rounds: 1 });

		// Nothing changed: the next ticks send nothing.
		for (const minute of [8, 10])
			expect(await tick(T0 + minutes(minute))).toMatchObject({
				notDue: 1,
				rounds: 0,
			});
		expect(sent).toHaveLength(1);

		// A new step: one more round, and the count is stored once.
		step(2, T0 + minutes(11));
		expect(await tick(T0 + minutes(12))).toMatchObject({ rounds: 1 });
		expect(stored()).toMatchObject({ rounds: 2 });

		// Silent for more than ten minutes: a reminder round.
		expect(await tick(T0 + minutes(20))).toMatchObject({ notDue: 1 });
		expect(await tick(T0 + minutes(22))).toMatchObject({ rounds: 1 });
		expect(sent).toHaveLength(3);
	});

	it("stops at the cap for a run and when the run ends", async () => {
		const { sqlite, sent, tick, stored } = fixture();
		sqlite.exec(
			`UPDATE work_items SET metadata=json_set(metadata,'$.agentRunSupervision',json('{"rounds":12,"lastRoundAt":"${at(T0)}","seen":"old"}'))`,
		);
		expect(await tick(T0 + minutes(30))).toMatchObject({ notDue: 1 });
		sqlite.exec(
			"UPDATE work_items SET metadata=json_remove(metadata,'$.agentRunSupervision')",
		);
		sqlite.exec(
			`UPDATE work_attempts SET runtime_state='finished', outcome='succeeded', finished_at='${at(T0 + minutes(20))}'`,
		);
		expect(await tick(T0 + minutes(30))).toMatchObject({
			supervisors: 1,
			notDue: 1,
		});
		sqlite.exec("UPDATE work_items SET disposition='completed'");
		expect(await tick(T0 + minutes(32))).toMatchObject({ supervisors: 0 });
		expect(sent).toHaveLength(0);
		expect(stored()).toBeNull();
	});

	it("sends nothing to a tedi whose stored overrides turn supervision off", async () => {
		const { sqlite, sent, tick } = fixture();
		sqlite.exec(
			`UPDATE tedis SET runtime_overrides='{"agentRunSupervision":{"enabled":false}}'`,
		);
		expect(await tick(T0 + minutes(30))).toMatchObject({ off: 1, rounds: 0 });
		sqlite.exec("UPDATE tedis SET runtime_overrides=NULL, status='paused'");
		expect(await tick(T0 + minutes(30))).toMatchObject({ supervisors: 0 });
		expect(sent).toHaveLength(0);
	});

	it("records nothing when the wake fails, and tries again on the next tick", async () => {
		const { sent, tick, stored, fail } = fixture();
		fail(true);
		expect(await tick(T0 + minutes(6))).toMatchObject({ failed: 1, rounds: 0 });
		expect(stored()).toBeNull();
		fail(false);
		expect(await tick(T0 + minutes(8))).toMatchObject({ rounds: 1 });
		expect(sent).toHaveLength(1);
		expect(stored()).toMatchObject({ rounds: 1 });
	});
});
