import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import {
	workAttemptMessages,
	workAttemptSteps,
} from "@tedix/db/schema/work-items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "@tedix/db/test/schema-ddl";
import type { BaseContext } from "../../orpc";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	appendAttemptStepsProcedure,
	listAttemptStepsProcedure,
	sendAttemptMessageProcedure,
	stopAttemptProcedure,
} from "./attempt-steps";

const org = "11111111-1111-4111-8111-111111111111";
const otherOrg = "22222222-2222-4222-8222-222222222222";
const work = "33333333-3333-4333-8333-333333333333";
const attempt = "44444444-4444-4444-8444-444444444444";
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		canonicalWorkFactoryDdl() +
			schemaDdl(
				organizationMembers,
				tedis,
				workAttemptSteps,
				workAttemptMessages,
			),
	);
	const expiresAt = new Date(Date.now() + 300_000).toISOString();
	sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES('${org}','Example','example'),('${otherOrg}','Other','other');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status) VALUES
			('m1','${org}','owner-subject','owner','owner@example.test','owner','active'),
			('m2','${org}','member-subject','member','member@example.test','member','active'),
			('m3','${otherOrg}','outsider-subject','outsider','outsider@example.test','owner','active');
		INSERT INTO tedis(id,organization_id,name,slug) VALUES
			('runner','${org}','Runner','runner'),
			('steward','${org}','Steward','steward'),
			('bystander','${org}','Bystander','bystander');
		INSERT INTO work_items(id,org_id,title,disposition,steward_type,steward_id,created_at) VALUES('${work}','${org}','Steered task','accepted','tedi','steward','2026-10-19T00:00:00.000Z');
		INSERT INTO work_attempts(id,work_item_id,org_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at,expires_at) VALUES('${attempt}','${work}','${org}','tedi','runner','running',1,'2026-10-19T00:00:00.000Z','2026-10-19T00:00:00.000Z','${expiresAt}');`);
	const db = createDbClient(createD1Facade(sqlite));
	const base = { db, organizationId: org, headers: new Headers() };
	const person = (sub: string, organizationId = org) =>
		({
			...base,
			organizationId,
			authType: "user",
			user: { sub },
		}) as BaseContext;
	const tedi = (tediId: string) =>
		({ ...base, authType: "tedi", tediId }) as BaseContext;
	return { sqlite, person, tedi };
}

function call<Input, Output>(
	procedure: {
		"~orpc": { handler?: (options: never) => Output | Promise<Output> };
	},
	context: BaseContext,
	input: Input,
) {
	return Promise.resolve().then(() =>
		procedure["~orpc"].handler!({
			context,
			input,
			path: [],
			procedure,
			signal: undefined,
			lastEventId: undefined,
		} as never),
	);
}

describe("run log and steering", () => {
	it("delivers an owner's follow-up to the runner and shows it in the log", async () => {
		const { person, tedi } = fixture();
		const sent = await call(
			sendAttemptMessageProcedure,
			person("owner-subject"),
			{
				id: work,
				body: "Also update the guide",
			},
		);
		expect(sent).toMatchObject({
			kind: "follow_up",
			senderType: "user",
			senderId: "owner",
			deliveredAt: null,
		});
		const report = await call(appendAttemptStepsProcedure, tedi("runner"), {
			id: work,
			attemptId: attempt,
			steps: [{ seq: 0, at: 1, kind: "started", text: "codex" }],
		});
		expect(report).toMatchObject({
			accepted: 1,
			pending: [{ id: sent.id, kind: "follow_up" }],
		});
		const log = await call(
			listAttemptStepsProcedure,
			person("member-subject"),
			{
				id: work,
				limit: 200,
			},
		);
		expect(log).toMatchObject({
			attemptId: attempt,
			live: true,
			steps: [{ seq: 0, at: 1, kind: "started", text: "codex" }],
			messages: [{ id: sent.id, appliedAt: null }],
		});
		expect(log.messages[0]?.deliveredAt).not.toBeNull();

		// The runner may never have seen that answer: it gets the follow-up
		// again until it reports it applied, and not after.
		const report2 = { id: work, attemptId: attempt, steps: [] };
		await expect(
			call(appendAttemptStepsProcedure, tedi("runner"), report2),
		).resolves.toEqual({
			accepted: 0,
			pending: [
				{
					id: sent.id,
					kind: "follow_up",
					body: "Also update the guide",
					senderType: "user",
					senderId: "owner",
					interrupt: false,
					createdAt: sent.createdAt,
				},
			],
		});
		await expect(
			call(appendAttemptStepsProcedure, tedi("runner"), {
				...report2,
				appliedMessageIds: [sent.id],
			}),
		).resolves.toEqual({ accepted: 0, pending: [] });
		await expect(
			call(appendAttemptStepsProcedure, tedi("runner"), report2),
		).resolves.toEqual({ accepted: 0, pending: [] });
		const after = await call(
			listAttemptStepsProcedure,
			person("member-subject"),
			{ id: work, limit: 200 },
		);
		expect(after.messages).toMatchObject([
			{ id: sent.id, deliveredAt: log.messages[0]!.deliveredAt },
		]);
		expect(after.messages[0]?.appliedAt).not.toBeNull();
	});

	it("tells the runner which follow-up should interrupt the current turn", async () => {
		const { person, tedi } = fixture();
		const urgent = await call(
			sendAttemptMessageProcedure,
			person("owner-subject"),
			{ id: work, body: "Stop, use the other branch", interrupt: true },
		);
		const stop = await call(stopAttemptProcedure, person("owner-subject"), {
			id: work,
		});
		expect(urgent.interrupt).toBe(true);
		const report = await call(appendAttemptStepsProcedure, tedi("runner"), {
			id: work,
			attemptId: attempt,
			steps: [],
		});
		// Both were sent within the same millisecond, so their order is by id.
		expect(
			Object.fromEntries(
				report.pending.map((message) => [message.id, message.interrupt]),
			),
		).toEqual({ [urgent.id]: true, [stop.id]: false });
	});

	it("stores a question with its offered answers and returns them in the log", async () => {
		const { person, tedi } = fixture();
		const report = {
			id: work,
			attemptId: attempt,
			steps: [
				{
					seq: 0,
					at: 1,
					kind: "question" as const,
					text: "Which table holds the plan?",
					choices: ["accounts", "subscriptions"],
				},
				{ seq: 1, at: 2, kind: "message" as const, text: "Waiting." },
			],
		};
		await expect(
			call(appendAttemptStepsProcedure, tedi("runner"), report),
		).resolves.toMatchObject({ accepted: 2 });
		await expect(
			call(appendAttemptStepsProcedure, tedi("runner"), report),
		).resolves.toMatchObject({ accepted: 0 });
		const log = await call(
			listAttemptStepsProcedure,
			person("member-subject"),
			{ id: work, limit: 200 },
		);
		expect(log.steps).toEqual([
			{ ...report.steps[0], choices: ["accounts", "subscriptions"] },
			report.steps[1],
		]);
	});

	it("lets only the Work Item's owner or steward send or stop", async () => {
		const { person, tedi } = fixture();
		for (const caller of [
			person("member-subject"),
			tedi("bystander"),
			// The agent doing the run cannot steer it.
			tedi("runner"),
		]) {
			await expect(
				call(sendAttemptMessageProcedure, caller, { id: work, body: "Hi" }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(
				call(stopAttemptProcedure, caller, { id: work }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		await expect(
			call(stopAttemptProcedure, tedi("steward"), { id: work }),
		).resolves.toMatchObject({
			kind: "stop",
			body: "",
			senderType: "tedi",
			senderId: "steward",
		});
	});

	it("refuses steps from an executor that does not hold the Attempt", async () => {
		const { tedi } = fixture();
		await expect(
			call(appendAttemptStepsProcedure, tedi("bystander"), {
				id: work,
				attemptId: attempt,
				steps: [{ seq: 0, at: 1, kind: "message", text: "not mine" }],
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("answers CONFLICT when no run is in progress", async () => {
		const { sqlite, person } = fixture();
		sqlite.exec(
			"UPDATE work_attempts SET runtime_state='finished', outcome='succeeded', finished_at='2026-10-19T00:01:00.000Z'",
		);
		for (const attemptCall of [
			call(sendAttemptMessageProcedure, person("owner-subject"), {
				id: work,
				body: "Hi",
			}),
			call(stopAttemptProcedure, person("owner-subject"), { id: work }),
		])
			await expect(attemptCall).rejects.toMatchObject({
				code: "CONFLICT",
				message: "No run is in progress",
			});
	});

	it("keeps another organization out of the log and the controls", async () => {
		const { person } = fixture();
		const outsider = person("outsider-subject", otherOrg);
		await expect(
			call(listAttemptStepsProcedure, outsider, { id: work, limit: 200 }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			call(sendAttemptMessageProcedure, outsider, { id: work, body: "Hi" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			call(stopAttemptProcedure, outsider, { id: work }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			call(appendAttemptStepsProcedure, outsider, {
				id: work,
				attemptId: attempt,
				steps: [],
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
