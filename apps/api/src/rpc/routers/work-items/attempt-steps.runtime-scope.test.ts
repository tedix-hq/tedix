/**
 * The tedi runtime's agent-run tools (`start_agent_run`, `read_agent_run`,
 * `send_agent_run_message`, `stop_agent_run`) reach `workItems.accept`,
 * `listAttemptSteps`, `sendAttemptMessage` and `stopAttempt` over the trusted
 * service binding, delegating exactly `TEDI_RUNTIME_SERVICE_BINDING_SCOPES`.
 * These tests build that context with the real list (imported, never copied),
 * so a scope dropped from either side fails here instead of in a live chat.
 */

import { createRouterClient } from "@orpc/server";
import { WORK_RUN_STEER_SCOPE } from "@tedix/api-contract/schemas/work-attempt-steps";
import { createDbClient } from "@tedix/db/client";
import { apiKeys } from "@tedix/db/schema/api-keys";
import {
	externalAgentMcpCredentials,
	externalAgentPrincipals,
	externalAgentSessions,
} from "@tedix/db/schema/external-agent-identity";
import { dispatcherHealthReports } from "@tedix/db/schema/dispatcher-health";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { tedis } from "@tedix/db/schema/tedis";
import { workAdmissions } from "@tedix/db/schema/work-factory";
import {
	workAttemptMessages,
	workAttemptSteps,
	workEvents,
} from "@tedix/db/schema/work-items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "@tedix/db/test/schema-ddl";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { TEDI_RUNTIME_SERVICE_BINDING_SCOPES } from "../../../../../tedi-runtime/src/platform-client-factory";
import type { BaseContext } from "../../orpc";
import {
	appendAttemptStepsProcedure,
	listAttemptStepsProcedure,
	sendAttemptMessageProcedure,
	stopAttemptProcedure,
} from "./attempt-steps";
import {
	listAgentRunsProcedure,
	tellPersonAboutAgentRunProcedure,
} from "./agent-runs";
import { createProcedure, listCliProjectionProcedure } from "./creation-reads";
import { acceptProcedure } from "./factory-lifecycle";

const ORG_ID = "00000000-0000-4000-8000-000000000301";
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000000302";
const WORK_ITEM_ID = "00000000-0000-4000-8000-000000000303";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000304";
const PROJECT_ID = "00000000-0000-4000-8000-000000000305";
const STARTER_TEDI_ID = "starter-tedi-id";
const BYSTANDER_TEDI_ID = "bystander-tedi-id";
const OTHER_ORG_TEDI_ID = "other-org-tedi-id";

const router = {
	create: createProcedure,
	accept: acceptProcedure,
	listAttemptSteps: listAttemptStepsProcedure,
	sendAttemptMessage: sendAttemptMessageProcedure,
	stopAttempt: stopAttemptProcedure,
	appendAttemptSteps: appendAttemptStepsProcedure,
	listCliProjection: listCliProjectionProcedure,
	listAgentRuns: listAgentRunsProcedure,
	tellPersonAboutAgentRun: tellPersonAboutAgentRunProcedure,
};

// The two chat deliveries of the run-ended notice; the update reuses them.
const chat = vi.hoisted(() => ({
	tedi: vi.fn(async () => ({ status: "queued" })),
	home: vi.fn(async () => ({ status: "queued" })),
}));
vi.mock("../../../services/agent-run-ended-notice", () => ({
	enqueueTediMessage: chat.tedi,
	enqueueHomeMessage: chat.home,
}));

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
				apiKeys,
				externalAgentPrincipals,
				externalAgentSessions,
				externalAgentMcpCredentials,
				organizationMembers,
				tedis,
				workEvents,
				workAttemptSteps,
				workAttemptMessages,
				dispatcherHealthReports,
				workAdmissions,
			),
	);
	// What `start_agent_run` creates: the starting tedi owns and stewards the
	// task, and an agent on one of the organization's machines runs it.
	sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES('${ORG_ID}','Example','example'),('${OTHER_ORG_ID}','Other','other');
		INSERT INTO tedis(id,organization_id,name,slug,status,mcp_capability_profile) VALUES
			('${STARTER_TEDI_ID}','${ORG_ID}','Starter','starter','active','standard'),
			('${BYSTANDER_TEDI_ID}','${ORG_ID}','Bystander','bystander','active','standard'),
			('${OTHER_ORG_TEDI_ID}','${OTHER_ORG_ID}','Elsewhere','elsewhere','active','standard');
		INSERT INTO projects(id,org_id,key,name,status,metadata,created_at) VALUES('${PROJECT_ID}','${ORG_ID}','P','Project','active','{}','2026-11-19');
		INSERT INTO work_items(id,org_id,project_id,title,description,work_kind,disposition,accountable_owner_type,accountable_owner_id,steward_type,steward_id,created_at)
			VALUES('${WORK_ITEM_ID}','${ORG_ID}','${PROJECT_ID}','Agent run','Fix the flaky test','coding','proposed','tedi','${STARTER_TEDI_ID}','tedi','${STARTER_TEDI_ID}','2026-11-19T00:00:00.000Z');`);
	const facade = createD1Facade(sqlite);
	const base = {
		db: createDbClient(facade),
		env: { ENVIRONMENT: "test", DB: facade } as CloudflareEnv,
		url: new URL("https://api.tedix.test/rpc/workItems"),
	};
	/** Exactly what `HttpPlatformClient` sends over the runtime service binding. */
	const runtimeClient = (
		tediId: string,
		organizationId = ORG_ID,
		scopes: readonly string[] = TEDI_RUNTIME_SERVICE_BINDING_SCOPES,
	) =>
		createRouterClient(router, {
			context: {
				...base,
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": organizationId,
					"X-Tedix-Tedi-Id": tediId,
					"X-Tedix-Caller": "brain-bridge",
					"X-Tedix-Caller-Source": "http-platform-client",
					"X-Tedix-Tedi-Scopes": scopes.join(" "),
				}),
			} as BaseContext,
		});
	/** A connected machine has picked the accepted task up. */
	const startRun = () =>
		sqlite.exec(
			`INSERT INTO work_attempts(id,work_item_id,org_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at,expires_at) VALUES('${ATTEMPT_ID}','${WORK_ITEM_ID}','${ORG_ID}','external_agent','codex','running',1,'2026-11-19T00:00:00.000Z','2026-11-19T00:00:00.000Z','${new Date(Date.now() + 300_000).toISOString()}')`,
		);
	return { sqlite, runtimeClient, startRun };
}

const acceptance = {
	id: WORK_ITEM_ID,
	acceptanceContract: { version: 1 as const, doneLooksLike: "The test passes" },
};

describe("agent runs through the tedi runtime service binding", () => {
	it("lets the starting tedi accept its task, read the run, send a follow-up and stop it", async () => {
		const { sqlite, runtimeClient, startRun } = fixture();
		const runtime = runtimeClient(STARTER_TEDI_ID);

		await expect(runtime.accept(acceptance)).resolves.toMatchObject({
			id: WORK_ITEM_ID,
			disposition: "accepted",
		});
		expect(
			sqlite
				.prepare("SELECT disposition FROM work_items WHERE id = ?")
				.get(WORK_ITEM_ID),
		).toEqual({ disposition: "accepted" });

		startRun();
		const sent = await runtime.sendAttemptMessage({
			id: WORK_ITEM_ID,
			body: "Also update the guide",
		});
		expect(sent).toMatchObject({
			kind: "follow_up",
			senderType: "tedi",
			senderId: STARTER_TEDI_ID,
		});
		await expect(
			runtime.listAttemptSteps({ id: WORK_ITEM_ID, limit: 200 }),
		).resolves.toMatchObject({
			attemptId: ATTEMPT_ID,
			live: true,
			steps: [],
			messages: [{ id: sent.id, body: "Also update the guide" }],
		});
		await expect(
			runtime.stopAttempt({ id: WORK_ITEM_ID }),
		).resolves.toMatchObject({
			kind: "stop",
			senderType: "tedi",
			senderId: STARTER_TEDI_ID,
		});
	});

	it("starts a run from the turn of a tedi a person picked in the chat", async () => {
		const { sqlite, runtimeClient } = fixture();
		// The task the chat made for this very turn, keyed by the turn's run id.
		sqlite.exec(
			`INSERT INTO work_items(id,org_id,title,work_kind,disposition,accountable_owner_type,accountable_owner_id,steward_type,steward_id,source_session_key,source_intent_id,created_at)
				VALUES('00000000-0000-4000-8000-000000000306','${ORG_ID}','Picked tedi turn','operations','accepted','tedi','${STARTER_TEDI_ID}','system','home','home:os:chat-7','turn-run-7','2026-11-19T00:00:00.000Z')`,
		);
		const runtime = runtimeClient(STARTER_TEDI_ID);
		const start = (sourceIntentId: string) =>
			runtime.create({
				title: "Fix the date filter",
				description: "The date filter drops the last day.",
				workKind: "coding",
				riskLevel: "medium",
				priority: "medium",
				accountableOwnerType: "tedi",
				accountableOwnerId: STARTER_TEDI_ID,
				stewardType: "tedi",
				stewardId: STARTER_TEDI_ID,
				workClass: "maintenance",
				purposeExceptionExpiresAt: new Date(
					Date.now() + 86_400_000,
				).toISOString(),
				projectId: PROJECT_ID,
				sourceSessionKey: "home:os:chat-7",
				sourceIntentId,
				executorReference: { type: "external_agent", id: "codex" },
				provenance: { source: "tedi.start_agent_run", runId: "turn-run-7" },
				metadata: {
					source: "tedi.start_agent_run",
					homeRunId: "turn-run-7",
					purposeContext: "tedi_task",
				},
			});

		// A key another task already holds is refused with a reason, not a 500.
		await expect(start("turn-run-7")).rejects.toMatchObject({
			code: "CONFLICT",
		});
		const created = await start("turn-run-7:start_agent_run:call-1");
		expect(created).toMatchObject({
			disposition: "proposed",
			executorType: "external_agent",
			executorId: "codex",
			dispatchState: "ready",
		});
		await expect(
			runtime.accept({ ...acceptance, id: created.id }),
		).resolves.toMatchObject({ disposition: "accepted" });
	});

	it("refuses each call when the runtime's list loses the scope that call needs", async () => {
		const { runtimeClient, startRun } = fixture();
		const without = (scope: string) =>
			runtimeClient(
				STARTER_TEDI_ID,
				ORG_ID,
				TEDI_RUNTIME_SERVICE_BINDING_SCOPES.filter((held) => held !== scope),
			);
		await expect(
			without("work:accept").accept(acceptance),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message:
				"Work Item acceptance by a tedi principal requires the work:accept scope",
		});
		startRun();
		const noSteer = without(WORK_RUN_STEER_SCOPE);
		for (const refused of [
			() => noSteer.listAttemptSteps({ id: WORK_ITEM_ID, limit: 200 }),
			() => noSteer.sendAttemptMessage({ id: WORK_ITEM_ID, body: "Hi" }),
			() => noSteer.stopAttempt({ id: WORK_ITEM_ID }),
		])
			await expect(refused()).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: expect.stringMatching(/^Delegated service-binding scope /),
			});
	});

	it("refuses a tedi that neither owns nor stewards the task", async () => {
		const { sqlite, runtimeClient, startRun } = fixture();
		await runtimeClient(STARTER_TEDI_ID).accept(acceptance);
		startRun();
		const bystander = runtimeClient(BYSTANDER_TEDI_ID);
		await expect(
			bystander.sendAttemptMessage({ id: WORK_ITEM_ID, body: "Hi" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			bystander.stopAttempt({ id: WORK_ITEM_ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_attempt_messages").get(),
		).toEqual({ n: 0 });
	});

	it("keeps another organization's tedi out of the task and its run", async () => {
		const { runtimeClient, startRun } = fixture();
		startRun();
		const outsider = runtimeClient(OTHER_ORG_TEDI_ID, OTHER_ORG_ID);
		for (const refused of [
			() => outsider.accept(acceptance),
			() => outsider.listAttemptSteps({ id: WORK_ITEM_ID, limit: 200 }),
			() => outsider.sendAttemptMessage({ id: WORK_ITEM_ID, body: "Hi" }),
			() => outsider.stopAttempt({ id: WORK_ITEM_ID }),
		])
			await expect(refused()).rejects.toMatchObject({ code: "FORBIDDEN" });
		// The binding names the organization. A tedi that is not active in the
		// task's organization cannot accept, follow up or stop there either.
		const misnamed = runtimeClient(OTHER_ORG_TEDI_ID, ORG_ID);
		for (const refused of [
			() => misnamed.accept(acceptance),
			() => misnamed.sendAttemptMessage({ id: WORK_ITEM_ID, body: "Hi" }),
			() => misnamed.stopAttempt({ id: WORK_ITEM_ID }),
		])
			await expect(refused()).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("lists a tedi's own runs with the reason one is not running, and no other tedi's", async () => {
		const { sqlite, runtimeClient, startRun } = fixture();
		// What `start_agent_run` stores besides the owner and steward.
		sqlite.exec(
			`UPDATE work_items SET executor_type='external_agent', executor_id='codex', source_session_key='agent:main:chat-7', metadata='{"source":"tedi.start_agent_run"}', created_at='${new Date().toISOString()}'`,
		);
		const starter = runtimeClient(STARTER_TEDI_ID);
		const only = async () => (await starter.listAgentRuns({})).runs;
		expect(await only()).toMatchObject([
			{ state: "waiting_for_runner", reason: { code: "not_accepted" } },
		]);
		await starter.accept(acceptance);
		// An accepted task that a readiness gate still blocks says which one.
		expect(await only()).toMatchObject([
			{
				reason: {
					code: "not_ready",
					detail: expect.stringContaining("purpose_blocked"),
				},
			},
		]);
		sqlite.exec(
			`UPDATE work_items SET work_class='maintenance', purpose_exception_expires_at='${new Date(Date.now() + 86_400_000).toISOString()}'`,
		);
		expect(await only()).toMatchObject([
			{
				workItemId: WORK_ITEM_ID,
				tediId: STARTER_TEDI_ID,
				state: "waiting_for_runner",
				attemptId: null,
				reason: { code: "no_runner" },
			},
		]);
		// A runner on a connected machine reports in; the task is only queued.
		const reportedAt = new Date().toISOString();
		sqlite.exec(
			`INSERT INTO dispatcher_health_reports(org_id,reporter_id,executor,lane,running,observed_at,reported_at) VALUES('${ORG_ID}','machine','codex','lane',1,'${reportedAt}','${reportedAt}')`,
		);
		expect(await only()).toMatchObject([
			{ reason: { code: "queued" }, unknown: expect.any(String) },
		]);
		const entry = {
			workItemId: WORK_ITEM_ID,
			reason: "Work has no ready coordinator selection",
			since: reportedAt,
		};
		const storeSkips = (workItemId: string, observedAt: string) =>
			sqlite.prepare("UPDATE dispatcher_health_reports SET duty = ?").run(
				JSON.stringify({
					skips: { observedAt, entries: [{ ...entry, workItemId }] },
				}),
			);
		storeSkips(ATTEMPT_ID, reportedAt);
		expect(await only()).toMatchObject([{ reason: { code: "queued" } }]);
		storeSkips(WORK_ITEM_ID, new Date(Date.now() - 360_000).toISOString());
		expect(await only()).toMatchObject([{ reason: { code: "queued" } }]);
		storeSkips(WORK_ITEM_ID, reportedAt);
		sqlite.exec("UPDATE dispatcher_health_reports SET executor='opencode'");
		expect(await only()).toMatchObject([{ reason: { code: "no_runner" } }]);
		sqlite.exec("UPDATE dispatcher_health_reports SET executor='any-local'");
		expect(await only()).toMatchObject([
			{
				reason: {
					code: "runner_skipped",
					detail: `A runner has skipped this task since ${reportedAt}: ${entry.reason}`,
				},
				unknown: null,
			},
		]);
		// A hold with its stored reason wins over everything else.
		sqlite.exec(
			`UPDATE work_items SET dispatch_state='held', metadata=json_set(metadata,'$.laneDispatch',json('{"reason":"Needs the owner"}'))`,
		);
		expect(await only()).toMatchObject([
			{ reason: { code: "held", detail: "Needs the owner" } },
		]);
		startRun();
		await starter.stopAttempt({ id: WORK_ITEM_ID });
		expect(await only()).toMatchObject([
			{ state: "running", attemptId: ATTEMPT_ID, reason: null },
		]);
		sqlite.exec(
			`UPDATE work_attempts SET runtime_state='cancelled', outcome='cancelled', finished_at='${reportedAt}', summary='Stopped'`,
		);
		expect(await only()).toEqual([]);
		expect(
			(await starter.listAgentRuns({ state: "ended" })).runs,
		).toMatchObject([
			{
				state: "ended",
				outcome: "cancelled",
				reason: {
					code: "stopped",
					detail: expect.stringContaining(STARTER_TEDI_ID),
				},
			},
		]);

		// Another tedi sees none of them, even when it names the starter; an
		// outsider reads only its own organization; the scope is required.
		await expect(
			runtimeClient(BYSTANDER_TEDI_ID).listAgentRuns({
				state: "all",
				tediId: STARTER_TEDI_ID,
			}),
		).resolves.toMatchObject({ runs: [] });
		await expect(
			runtimeClient(OTHER_ORG_TEDI_ID, OTHER_ORG_ID).listAgentRuns({
				state: "all",
			}),
		).resolves.toMatchObject({ runs: [] });
		await expect(
			runtimeClient(OTHER_ORG_TEDI_ID, ORG_ID).listAgentRuns({ state: "all" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			runtimeClient(
				STARTER_TEDI_ID,
				ORG_ID,
				TEDI_RUNTIME_SERVICE_BINDING_SCOPES.filter(
					(held) => held !== WORK_RUN_STEER_SCOPE,
				),
			).listAgentRuns({}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("lets only the starting tedi tell the person about its run, once in five minutes", async () => {
		const { sqlite, runtimeClient } = fixture();
		chat.tedi.mockClear();
		chat.home.mockClear();
		const update = {
			id: WORK_ITEM_ID,
			message: "The run waits for a machine.",
		};
		const starter = runtimeClient(STARTER_TEDI_ID);
		// Not an agent run yet: a task the tedi merely stewards gets no update.
		await expect(starter.tellPersonAboutAgentRun(update)).rejects.toMatchObject(
			{ code: "FORBIDDEN" },
		);
		sqlite.exec(
			`UPDATE work_items SET executor_type='external_agent', executor_id='codex', source_session_key='agent:main:chat-7', metadata='{"source":"tedi.start_agent_run"}'`,
		);
		for (const refused of [
			() => runtimeClient(BYSTANDER_TEDI_ID).tellPersonAboutAgentRun(update),
			() =>
				runtimeClient(OTHER_ORG_TEDI_ID, OTHER_ORG_ID).tellPersonAboutAgentRun(
					update,
				),
			() =>
				runtimeClient(OTHER_ORG_TEDI_ID, ORG_ID).tellPersonAboutAgentRun(
					update,
				),
			() =>
				runtimeClient(
					STARTER_TEDI_ID,
					ORG_ID,
					TEDI_RUNTIME_SERVICE_BINDING_SCOPES.filter(
						(held) => held !== WORK_RUN_STEER_SCOPE,
					),
				).tellPersonAboutAgentRun(update),
		])
			await expect(refused()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(chat.tedi).not.toHaveBeenCalled();

		await expect(starter.tellPersonAboutAgentRun(update)).resolves.toEqual({
			status: "sent",
			chat: "tedi",
		});
		expect(chat.tedi).toHaveBeenCalledTimes(1);
		expect(chat.tedi.mock.calls[0]).toMatchObject([
			expect.anything(),
			{
				tediId: STARTER_TEDI_ID,
				conversationId: "agent:main:chat-7",
				content: expect.stringContaining("The run waits for a machine."),
			},
			"agent-run-update",
		]);
		await expect(starter.tellPersonAboutAgentRun(update)).resolves.toEqual({
			status: "too_soon",
			chat: "tedi",
		});
		expect(chat.tedi).toHaveBeenCalledTimes(1);

		// A run started by a tedi the person picked in the chat reports to Home
		// in that chat, the same way its end is reported.
		sqlite.exec(
			`UPDATE work_items SET source_session_key='home:person:thread', metadata=json_remove(metadata,'$.agentRunUpdateAt')`,
		);
		await expect(starter.tellPersonAboutAgentRun(update)).resolves.toEqual({
			status: "sent",
			chat: "home",
		});
		expect(chat.home.mock.calls[0]).toMatchObject([
			expect.anything(),
			{ organizationId: ORG_ID, conversationId: "home:person:thread" },
			{ agentRunUpdate: true },
		]);
	});

	it("opens nothing else behind the wider Work scopes", async () => {
		const { runtimeClient, startRun } = fixture();
		for (const scope of [
			"mcp:work.read",
			"mcp:work.write",
			"mcp:work.admin",
			"work:read",
			"work:write",
			"work:cancel",
			"work:review",
			"work:complete",
		])
			expect(TEDI_RUNTIME_SERVICE_BINDING_SCOPES).not.toContain(scope);
		startRun();
		const runtime = runtimeClient(STARTER_TEDI_ID);
		// Reporting a run's steps needs `mcp:work.write`.
		await expect(
			runtime.appendAttemptSteps({
				id: WORK_ITEM_ID,
				attemptId: ATTEMPT_ID,
				steps: [],
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Delegated service-binding scope 'mcp:work.write' required",
		});
		// The board's command-line rows need `mcp:work.read`.
		await expect(runtime.listCliProjection({})).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Delegated service-binding scope 'mcp:work.read' required",
		});
	});
});
