import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { workItems, workAttempts } from "../../schema/work-items";
import { recordWorkDecisionContinuation } from "./comments";
import { findAgentApprovalWork } from "./attempts";

it("preserves the Work version, admission fence, executor, and terminal Work while advancing each decision once", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	try {
		sqlite.exec(schemaDdl(workItems));
		sqlite.exec(`INSERT INTO work_items(id,org_id,title,disposition,created_at,admission_spec_revision,metadata)
			VALUES('work','org','Cleanup','accepted','2026-11-01','fence','{"executor":"codex"}'),
			('closed','org','Done','completed','2026-11-01','closed-fence','{}')`);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const signal = {
			orgId: "org",
			workItemId: "work",
			kind: "answer" as const,
			requestId: "request",
			responseId: "response",
			at: "2026-11-13T12:00:00.000Z",
		};
		expect(await recordWorkDecisionContinuation(db, signal)).toHaveLength(1);
		expect(await recordWorkDecisionContinuation(db, signal)).toHaveLength(0);
		expect(
			await recordWorkDecisionContinuation(db, {
				...signal,
				responseId: "older",
				at: "2026-11-12T12:00:00.000Z",
			}),
		).toHaveLength(0);
		expect(
			await recordWorkDecisionContinuation(db, { ...signal, orgId: "foreign" }),
		).toHaveLength(0);
		expect(
			await recordWorkDecisionContinuation(db, {
				...signal,
				workItemId: "closed",
			}),
		).toHaveLength(0);
		const row = sqlite
			.prepare(
				"SELECT version,admission_spec_revision,metadata FROM work_items WHERE id='work'",
			)
			.get()!;
		expect(row.version).toBe(1);
		expect(row.admission_spec_revision).toBe("fence");
		expect(JSON.parse(String(row.metadata))).toEqual({
			executor: "codex",
			decisionContinuation: {
				kind: "answer",
				requestId: "request",
				responseId: "response",
				at: signal.at,
			},
		});
	} finally {
		sqlite.close();
	}
});

it("links an agent request only to its unique live exact-session Attempt", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	try {
		sqlite.exec(schemaDdl(workAttempts));
		sqlite.exec(`INSERT INTO work_attempts(id,org_id,work_item_id,admission_id,executor_type,executor_id,external_session_key,runtime_state,attempt_number,started_at,heartbeat_at,expires_at)
			VALUES('attempt','org','work','admission','external_agent','agent','codex:session','running',1,'2026-11-13','2026-11-13','2026-11-14')`);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const p = {
			orgId: "org",
			principalId: "agent",
			externalSessionKey: "codex:session",
			now: "2026-11-13T12:00:00.000Z",
		};
		expect(await findAgentApprovalWork(db, p)).toBe("work");
		expect(
			await findAgentApprovalWork(db, { ...p, externalSessionKey: "other" }),
		).toBeUndefined();
		expect(
			await findAgentApprovalWork(db, { ...p, orgId: "foreign" }),
		).toBeUndefined();
		expect(
			await findAgentApprovalWork(db, { ...p, now: "2026-11-15" }),
		).toBeUndefined();
		sqlite.exec("UPDATE work_attempts SET runtime_state='cancelled'");
		expect(await findAgentApprovalWork(db, p)).toBeUndefined();
	} finally {
		sqlite.close();
	}
});
