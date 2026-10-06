/**
 * Unit coverage for the pure Agent-runtime cron helpers: `sessionTarget`
 * resolution and the SDK-Schedule → cron-job mapping. The DO-bound dispatch + scheduling is
 * validated live (a fired cron must actually inject a turn).
 * Run: `bun run src/cron.test.ts`.
 */
import assert from "node:assert/strict";
import { DEFAULT_CRON_TEMPLATES } from "@tedix/db/schema/control-plane";
import { DEFAULT_SESSION_KEY } from "@tedix/tedi-session/session-harness";
import {
	facetWorkflowTurnProbe,
	MCP_FACET_TURN_INPUT,
	mcpFacetTurnProbe,
	tediDo,
} from "../test/tedi-do";
import { buildFacetWorkflowTurnInput } from "./chat-turn-input";
import { ChatTurnWorkflow } from "./chat-turn-workflow";
import {
	applyCronReconcileActions,
	applyTediCronPolicyOverrides,
	buildCronExecutionStart,
	buildCronPreDispatchFailure,
	buildCronStabilityTimeoutFailure,
	type CronTemplateLike,
	cronScheduleCeilingError,
	cronSchedulesSupersededByName,
	cronTemplateSessionKey,
	conversationalScheduleCreationReceipt,
	DEFAULT_TOOL_CRON_TTL_MS,
	isCronFireExpired,
	isOrphanedIsolateDo,
	MAX_SCHEDULED_JOBS,
	MAX_TOOL_CRON_TTL_MS,
	MIN_RECURRING_INTERVAL_MS,
	planCronReconcile,
	protectedCronNameError,
	resolveCronExpiry,
	resolveCronSessionKey,
	type ScheduleLike,
	SKILL_DEVELOPMENT_CRON_NAME,
	scheduleToAdminSchedule,
	scheduleToCronJob,
	shouldRunTrajectoryMining,
	summarizeCronTurnTransitions,
	withCognitiveCronDefaults,
	writeConversationalSchedule,
} from "./cron";
import { wrapUntrustedInput } from "./untrusted-input";

// resolveCronSessionKey ------------------------------------------------------
assert.equal(
	resolveCronSessionKey(undefined),
	DEFAULT_SESSION_KEY,
	"absent target → default main session",
);
assert.equal(
	resolveCronSessionKey("main"),
	DEFAULT_SESSION_KEY,
	"'main' → default main session",
);
assert.equal(
	resolveCronSessionKey("session:agent:main:work"),
	"agent:main:work",
	"'session:<key>' strips the prefix",
);
assert.equal(
	resolveCronSessionKey("session:"),
	DEFAULT_SESSION_KEY,
	"empty 'session:' falls back to default",
);
assert.equal(
	resolveCronSessionKey(undefined, "agent:main:project-red"),
	"agent:main:project-red",
	"an in-turn cron add stays in its non-main conversation",
);
assert.equal(
	resolveCronSessionKey("session:other", "agent:main:project-red"),
	"agent:main:project-red",
	"an in-turn call cannot redirect a schedule outside its bound conversation",
);
console.log("PASS: resolveCronSessionKey");

// scheduleToCronJob — cron kind ----------------------------------------------
// SDK persists Schedule.time in unix SECONDS (floors getTime()/1000 on insert)
// — the mapper must convert to ms. 1_900_000_000 s ≈ 2030-03-17.
const cronRow: ScheduleLike = {
	id: "sched-1",
	callback: "onCronFire",
	type: "cron",
	cron: "0 9 * * 1-5",
	time: 1_900_000_000,
	payload: {
		message: "daily standup check",
		name: "standup",
		sessionKey: "agent:main:main",
	},
};
const cronJob = scheduleToCronJob(cronRow);
assert.equal(cronJob.id, "sched-1");
assert.equal(cronJob.kind, "cron", "cron type → kind=cron");
assert.equal(cronJob.expr, "0 9 * * 1-5", "cron expr surfaced");
assert.equal(cronJob.name, "standup");
assert.equal(cronJob.message, "daily standup check");
assert.equal(cronJob.sessionTarget, "agent:main:main");
assert.equal(
	cronJob.nextRunMs,
	1_900_000_000_000,
	"SDK seconds → ms (treating seconds as ms renders 1970)",
);
assert.equal(
	cronJob.nextRunIso,
	new Date(1_900_000_000_000).toISOString(),
	"nextRunIso mirrors nextRunMs",
);
assert.ok(
	String(cronJob.nextRunIso).startsWith("2030-"),
	"next run is a real future date, not 1970",
);
console.log("PASS: scheduleToCronJob cron");

// scheduleToCronJob — interval (every) ---------------------------------------
const everyRow: ScheduleLike = {
	id: "sched-2",
	callback: "onCronFire",
	type: "interval",
	intervalSeconds: 900,
	time: 123,
	payload: { message: "poll inbox" },
};
const everyJob = scheduleToCronJob(everyRow);
assert.equal(everyJob.kind, "every", "interval type → kind=every");
assert.equal(everyJob.everyMs, 900_000, "intervalSeconds → everyMs");
assert.equal(everyJob.expr, undefined, "no cron expr on interval jobs");
assert.equal(everyJob.name, null, "missing name → null");
console.log("PASS: scheduleToCronJob every");

// scheduleToCronJob — one-shot (at) ------------------------------------------
const atRow: ScheduleLike = {
	id: "sched-3",
	callback: "onCronFire",
	type: "scheduled",
	time: 1_750_000_000,
	payload: { message: "remind me", sessionKey: "agent:main:main" },
};
const atJob = scheduleToCronJob(atRow);
assert.equal(atJob.kind, "at", "scheduled type → kind=at");
assert.equal(atJob.everyMs, undefined, "no everyMs on at jobs");
assert.equal(atJob.expr, undefined, "no expr on at jobs");
console.log("PASS: scheduleToCronJob at");

// scheduleToAdminSchedule — /__admin/schedules operator read ------------------
// Every field is explicitly present (nulls, not omissions), the seconds→ms
// `time` conversion matches scheduleToCronJob, and non-onCronFire framework
// schedules with arbitrary payloads degrade to nulls instead of throwing.
{
	const adminCron = scheduleToAdminSchedule(cronRow);
	assert.equal(adminCron.id, "sched-1");
	assert.equal(adminCron.callback, "onCronFire", "callback surfaced");
	assert.equal(adminCron.kind, "cron");
	assert.equal(adminCron.expr, "0 9 * * 1-5");
	assert.equal(adminCron.everyMs, null, "non-interval → everyMs null");
	assert.equal(adminCron.name, "standup");
	assert.equal(adminCron.message, "daily standup check");
	assert.equal(adminCron.sessionTarget, "agent:main:main");
	assert.equal(adminCron.nextRunAtMs, 1_900_000_000_000, "SDK seconds → ms");
	assert.equal(adminCron.nextRunAt, new Date(1_900_000_000_000).toISOString());

	const adminEvery = scheduleToAdminSchedule(everyRow);
	assert.equal(adminEvery.kind, "every");
	assert.equal(adminEvery.everyMs, 900_000);
	assert.equal(adminEvery.expr, null, "non-cron → expr null");
	assert.equal(adminEvery.name, null);

	const adminAt = scheduleToAdminSchedule(atRow);
	assert.equal(adminAt.kind, "at");
	assert.equal(adminAt.expr, null);
	assert.equal(adminAt.everyMs, null);

	// Framework maintenance schedule: different callback, non-object payload.
	const framework = scheduleToAdminSchedule({
		id: "sched-4",
		callback: "onMaintenance",
		type: "cron",
		cron: "*/5 * * * *",
		payload: "opaque-string-payload",
	});
	assert.equal(framework.callback, "onMaintenance");
	assert.equal(framework.message, null, "non-object payload → message null");
	assert.equal(framework.name, null);
	assert.equal(framework.nextRunAtMs, null, "missing time → nextRun null");
	assert.equal(framework.nextRunAt, null);
}
console.log("PASS: scheduleToAdminSchedule cron/every/at/framework");

// onCronFire workflow routing — fireKey sanitization + runId surface tag ------
// These mirror the CHAT_TURN_WORKFLOW dispatch params built in onCronFire so
// a colon-bearing fireKey produces a valid workflow instance id and correct runId.
import { buildRunId, buildWorkflowInstanceId } from "./ledger-mirror";

// Colon-bearing fireKey (real format: "cron:<scheduleId>:<unixMs>")
const fireKey = "cron:daily:2026-06-18T00:00:00Z";

// workflowInstanceId derivation must strip colons (Cloudflare Workflow constraint)
const workflowInstanceId = buildWorkflowInstanceId(fireKey);
assert.ok(
	!workflowInstanceId.includes(":"),
	"workflowInstanceId has no colons after sanitize",
);
assert.ok(
	workflowInstanceId.length <= 64,
	"workflowInstanceId capped at 64 chars",
);
// Same fireKey → same instanceId (redelivery dedup)
const workflowInstanceId2 = buildWorkflowInstanceId(fireKey);
assert.equal(
	workflowInstanceId,
	workflowInstanceId2,
	"same fireKey → identical workflowInstanceId",
);
console.log("PASS: workflowInstanceId sanitization");

// runId must use "cron" surface tag
const tediId = "00000000-0000-0000-0000-000000000001";
const runId = buildRunId(tediId, fireKey, "cron");
assert.ok(runId.includes(":cron:"), "runId encodes 'cron' surface tag");
// Idempotent: same fireKey → same runId
assert.equal(
	runId,
	buildRunId(tediId, fireKey, "cron"),
	"same fireKey → identical runId",
);
console.log("PASS: cron runId surface tag");

// ChatTurnParams shape dispatched by onCronFire
const message = "daily standup check";
const userTs = Date.now();
const sessionKey = DEFAULT_SESSION_KEY;
const params = {
	agentName: tediId,
	sessionKey,
	userText: message,
	userTs,
	conversationId: `${tediId}:${sessionKey}`,
	runId,
	clientRequestId: fireKey,
	trustedInstructionOrigin: "cron" as const,
};
assert.equal(params.userText, message, "userText is the cron job message");
assert.equal(params.agentName, tediId, "originating Agent name is persisted");
assert.equal(params.clientRequestId, fireKey, "clientRequestId is the fireKey");
assert.equal(
	params.trustedInstructionOrigin,
	"cron",
	"persisted cron instructions carry internal trust provenance",
);
assert.ok(
	!("attachments" in params),
	"no attachments field in cron workflow params",
);
console.log("PASS: onCronFire ChatTurnParams shape");

// The durable Workflow hands the Agent the same provenance it was dispatched
// with (onCronFire's own dispatch is covered in cron-terminal-wiring).
{
	const received: Array<{ trustedInstructionOrigin?: string }> = [];
	const workflow = Object.create(ChatTurnWorkflow.prototype) as InstanceType<
		typeof ChatTurnWorkflow
	>;
	Object.defineProperty(workflow, "agent", {
		value: {
			markChatWorkflowStarted: async () => true,
			runFacetWorkflowTurn: async (input: {
				trustedInstructionOrigin?: string;
			}) => {
				received.push(input);
				return { text: "done", stopReason: "stop", toolCalls: [] };
			},
		},
	});
	await workflow.run(
		{
			instanceId: "wf-1",
			payload: { ...params, agentName: undefined },
		} as Parameters<typeof workflow.run>[0],
		{
			do: async (_name: string, _config: unknown, run: () => unknown) => run(),
			sleep: async () => {},
			reportComplete: async () => {},
		} as unknown as Parameters<typeof workflow.run>[1],
	);
	assert.equal(
		received[0]?.trustedInstructionOrigin,
		"cron",
		"ChatTurnWorkflow must preserve internal trust provenance across the durable boundary",
	);
}
assert.equal(
	buildFacetWorkflowTurnInput(params).trustedInstructionOrigin,
	"cron",
	"the production projection preserves authenticated cron provenance",
);
assert.equal(
	buildFacetWorkflowTurnInput({
		...params,
		trustedInstructionOrigin: undefined,
	}).trustedInstructionOrigin,
	undefined,
	"the production projection must not grant cron trust to an ordinary turn",
);

// Only delegated work and persisted cron instructions bypass untrusted-input
// wrapping; a computer-execution wake is fenced as its own source.
for (const [label, turn, expected] of [
	["ordinary MCP turn", {}, wrapUntrustedInput("hello", "mcp")],
	["persisted cron", { trustedInstructionOrigin: "cron" }, "hello"],
	["delegated work", { workItemId: "w-1", homeRunId: "h-1" }, "hello"],
	[
		"computer execution wake",
		{ trustedInstructionOrigin: "computer_execution" },
		wrapUntrustedInput("hello", "computer_execution"),
	],
	[
		"delegated computer execution wake",
		{
			trustedInstructionOrigin: "computer_execution",
			workItemId: "w-1",
			homeRunId: "h-1",
		},
		wrapUntrustedInput("hello", "computer_execution"),
	],
] as const) {
	const probe = facetWorkflowTurnProbe();
	await probe.run(turn);
	assert.equal(probe.facetInputs[0]?.guardedUserText, expected, label);
}

// cronAiTool captures its turn's session key instead of consulting mutable
// parent state at execution, and every facet turn binds its prepared session.
{
	const calls: Array<string | undefined> = [];
	const agent = tediDo({
		async cronTool(_input: unknown, boundSessionKey?: string) {
			calls.push(boundSessionKey);
			return { ok: true };
		},
	});
	const tools = agent.cronAiTool("session-a") as {
		cron: { execute: (input: unknown, options: unknown) => Promise<unknown> };
	};
	await tools.cron.execute(
		{ action: "list" },
		{ toolCallId: "t", messages: [] },
	);
	assert.deepEqual(calls, ["session-a"]);

	const bound: Array<string | undefined> = [];
	const probe = mcpFacetTurnProbe({
		fields: {
			cronAiTool(sessionKey?: string) {
				bound.push(sessionKey);
				return {};
			},
		},
	});
	await probe.prepareMcpFacetTurn({
		...MCP_FACET_TURN_INPUT,
		sessionKey: "session-b",
	});
	assert.deepEqual(bound, ["session-b"]);
}

// planCronReconcile ----------------------------------------------------------
const mkSched = (
	name: string,
	expr: string,
	message: string,
): ScheduleLike => ({
	id: `id-${name}`,
	callback: "onCronFire",
	type: "cron",
	cron: expr,
	payload: { message, name, sessionKey: DEFAULT_SESSION_KEY },
});
const mkTpl = (
	name: string,
	schedule: string,
	message: string,
): CronTemplateLike => ({ name, schedule, message });

// add-if-missing
{
	const a = planCronReconcile(
		[mkTpl("deploy-reconciler", "*/15 * * * *", "do x")],
		[],
	);
	assert.equal(a.length, 1, "missing template → one action");
	assert.equal(a[0]!.op, "add");
	assert.equal(a[0]!.name, "deploy-reconciler");
	assert.equal(a[0]!.expr, "*/15 * * * *");
	assert.equal(a[0]!.cancelId, undefined, "add has no cancelId");
	assert.equal(
		a[0]!.sessionKey,
		"agent:main:cron:deploy-reconciler",
		"template crons get isolated history",
	);
}

// COGNITIVE CRONS RECONCILE: reflection cron templates schedule like any other
// (the prior agentRuntime opt-in gate left the six cognitive loops scheduled
// nowhere — see planCronReconcile docs and flywheel.crons_flywheel_health).
{
	const a = planCronReconcile(
		[{ name: "brain-reflection", schedule: "0 */8 * * *", message: "reflect" }],
		[],
	);
	assert.equal(a.length, 1, "reflection cron template → scheduled");
	assert.equal(a[0]!.op, "add");
	assert.equal(a[0]!.name, "brain-reflection");
	assert.equal(a[0]!.expr, "0 */8 * * *");
}

// legacy D1 templates carrying the retired agentRuntime marker still reconcile
// (unknown fields are ignored; D1 packs are not migrated for this).
{
	const a = planCronReconcile(
		[
			{
				name: "deploy-reconciler",
				schedule: "*/15 * * * *",
				message: "do x",
				agentRuntime: true,
			} as CronTemplateLike,
		],
		[],
	);
	assert.equal(a.length, 1, "legacy agentRuntime-tagged template → scheduled");
}

// A legacy shared-session template is updated once onto its isolated history.
{
	const a = planCronReconcile(
		[mkTpl("x", "0 * * * *", "m")],
		[mkSched("x", "0 * * * *", "m")],
	);
	assert.equal(a.length, 1);
	assert.equal(a[0]!.op, "update");
	assert.equal(a[0]!.sessionKey, "agent:main:cron:x");
}

// leave-unchanged (idempotent after the isolated session is installed)
assert.deepEqual(
	planCronReconcile(
		[mkTpl("x", "0 * * * *", "m")],
		[
			{
				...mkSched("x", "0 * * * *", "m"),
				payload: {
					message: "m",
					name: "x",
					sessionKey: cronTemplateSessionKey("x"),
					source: "template",
				},
			},
		],
	),
	[],
	"matching name+expr+message → no action (idempotent)",
);

// An explicit operator force-sync re-registers a matching template. This is
// the recovery path for policy changes whose durable scheduler projection was
// pinned in a warm DO instance.
{
	const a = planCronReconcile(
		[mkTpl("x", "0 * * * *", "m")],
		[
			{
				...mkSched("x", "0 * * * *", "m"),
				payload: {
					message: "m",
					name: "x",
					sessionKey: cronTemplateSessionKey("x"),
					source: "template",
				},
			},
		],
		{ forceUpdate: true },
	);
	assert.equal(a.length, 1);
	assert.equal(a[0]!.op, "update");
	assert.equal(a[0]!.cancelId, "id-x");
}

// A degraded policy read is not a complete desired-state projection and cannot
// authorize removal of a pack-specific schedule.
{
	const managed = mkSched("content-operations", "0 12 * * *", "market");
	managed.payload = {
		message: "market",
		name: "content-operations",
		sessionKey: cronTemplateSessionKey("content-operations"),
		source: "template",
	};
	assert.deepEqual(
		planCronReconcile([], [managed], { removeStale: false }),
		[],
		"fallback projections preserve existing template schedules",
	);
	assert.deepEqual(
		planCronReconcile([], [], { removeStale: false, forceUpdate: true }),
		[],
		"a failed policy read on a fresh or opted-out runtime installs no jobs",
	);
	assert.deepEqual(
		planCronReconcile([], [managed], { removeStale: false, forceUpdate: true }),
		[],
		"force-sync cannot replace or retire schedules without a known policy",
	);
}

// Updates create the replacement before retiring the old row. A create failure
// therefore leaves the healthy schedule untouched.
{
	const calls: string[] = [];
	const receipt = await applyCronReconcileActions(
		[
			{
				op: "update",
				name: "content-operations",
				expr: "0 12 * * *",
				message: "new",
				sessionKey: cronTemplateSessionKey("content-operations"),
				cancelId: "old",
			},
		],
		{
			cancelSchedule: async (id) => {
				calls.push(`cancel:${id}`);
				return true;
			},
			schedule: async (_expr, _payload, options) => {
				calls.push(`schedule:fresh=${options.fresh}`);
				throw new Error("scheduler unavailable");
			},
		},
	);
	assert.deepEqual(calls, ["schedule:fresh=true"]);
	assert.equal(receipt.appliedCount, 0);
	assert.match(receipt.errors[0] ?? "", /create:scheduler unavailable/);
}

// Cloudflare cron scheduling is idempotent by default. If an adapter ignores
// the fresh-replacement request and returns the prior id, never cancel it.
{
	const calls: string[] = [];
	const receipt = await applyCronReconcileActions(
		[
			{
				op: "update",
				name: "content-operations",
				expr: "0 12 * * *",
				message: "same",
				sessionKey: cronTemplateSessionKey("content-operations"),
				cancelId: "old",
			},
		],
		{
			cancelSchedule: async (id) => {
				calls.push(`cancel:${id}`);
				return true;
			},
			schedule: async (_expr, _payload, options) => {
				calls.push(`schedule:fresh=${options.fresh}`);
				return { id: "old" };
			},
		},
	);
	assert.deepEqual(calls, ["schedule:fresh=true"]);
	assert.equal(receipt.appliedCount, 0);
	assert.match(receipt.errors[0] ?? "", /reused prior schedule id/);
}

// Agents SDK cancellation can throw after deleting the old row. Keep the
// replacement on an ambiguous retirement failure so the cron cannot go dark.
{
	const calls: string[] = [];
	const receipt = await applyCronReconcileActions(
		[
			{
				op: "update",
				name: "content-operations",
				expr: "0 12 * * *",
				message: "new",
				sessionKey: cronTemplateSessionKey("content-operations"),
				cancelId: "old",
			},
		],
		{
			cancelSchedule: async (id) => {
				calls.push(`cancel:${id}`);
				if (id === "old") throw new Error("retire unavailable");
				return true;
			},
			schedule: async () => {
				calls.push("schedule");
				return { id: "new" };
			},
		},
	);
	assert.deepEqual(calls, ["schedule", "cancel:old"]);
	assert.equal(receipt.appliedCount, 0);
	assert.match(
		receipt.errors[0] ?? "",
		/retire_ambiguous:retire unavailable;replacement_retained:new/,
	);
}

// update on message change → cancel + re-add
{
	const a = planCronReconcile(
		[mkTpl("x", "0 * * * *", "NEW")],
		[mkSched("x", "0 * * * *", "OLD")],
	);
	assert.equal(a.length, 1);
	assert.equal(a[0]!.op, "update");
	assert.equal(
		a[0]!.cancelId,
		"id-x",
		"update carries the existing id to cancel",
	);
	assert.equal(a[0]!.message, "NEW");
}

// update on schedule-expr change
{
	const a = planCronReconcile(
		[mkTpl("x", "*/30 * * * *", "m")],
		[mkSched("x", "0 * * * *", "m")],
	);
	assert.equal(a.length, 1);
	assert.equal(a[0]!.op, "update");
	assert.equal(a[0]!.expr, "*/30 * * * *");
}

// Empty templates preserve tool/legacy jobs but remove platform-managed jobs.
assert.deepEqual(
	planCronReconcile([], [mkSched("x", "0 * * * *", "m")]),
	[],
	"no templates never delete a legacy or tool-added schedule",
);
{
	const managed = mkSched("x", "0 * * * *", "m");
	managed.payload = {
		message: "m",
		name: "x",
		sessionKey: cronTemplateSessionKey("x"),
		source: "template",
	};
	assert.deepEqual(
		planCronReconcile([], [managed]),
		[{ op: "remove", name: "x", cancelId: "id-x" }],
		"an explicit empty policy cancels previously reconciled template jobs",
	);
}

// invalid/incomplete templates are skipped
assert.deepEqual(
	planCronReconcile([mkTpl("", "0 * * * *", "m")], []),
	[],
	"blank name → skipped",
);

// a schedule with no payload.name is unmatched → template adds (not updates)
{
	const a = planCronReconcile(
		[mkTpl("x", "0 * * * *", "m")],
		[
			{
				id: "i",
				callback: "onCronFire",
				type: "cron",
				cron: "0 * * * *",
				payload: {},
			},
		],
	);
	assert.equal(a.length, 1);
	assert.equal(
		a[0]!.op,
		"add",
		"unnamed existing schedule does not match by name",
	);
}
console.log(
	"PASS: planCronReconcile add/update/leave/empty/invalid + cognitive crons",
);

// buildCronExecutionStart ------------------------------------------------------
{
	const stamp = buildCronExecutionStart(
		{ name: "brain-reflection" },
		"cron:sched-1:1900000000",
		"tedi-1:cron:cron_sched-1_1900000000",
		1_900_000_000_000,
	);
	assert.ok(stamp, "named fire → stamp");
	assert.equal(stamp!.phase, "started");
	assert.equal(stamp!.cronName, "brain-reflection");
	assert.equal(stamp!.fireKey, "cron:sched-1:1900000000");
	assert.equal(stamp!.runId, "tedi-1:cron:cron_sched-1_1900000000");
	assert.equal(
		stamp!.startedAt,
		new Date(1_900_000_000_000).toISOString(),
		"startedAt is the dispatch time as ISO",
	);
}
assert.equal(
	buildCronExecutionStart({}, "cron:x:1", "run-1", Date.now()),
	null,
	"unnamed fire → no execution stamp (ad-hoc one-shots are not loop executions)",
);
assert.equal(
	buildCronExecutionStart({ name: "   " }, "cron:x:1", "run-1", Date.now()),
	null,
	"blank name → no execution stamp",
);
console.log("PASS: buildCronExecutionStart");

// buildCronStabilityTimeoutFailure -------------------------------------------
{
	const start = buildCronExecutionStart(
		{ name: "objective-review" },
		"cron:sched-2:1900000000",
		"tedi-1:cron:objective-review",
		1_900_000_000_000,
	);
	assert.ok(start);
	assert.deepEqual(
		buildCronStabilityTimeoutFailure(start!, 1_900_000_030_000),
		{
			phase: "finished",
			fireKey: "cron:sched-2:1900000000",
			cronName: "objective-review",
			runId: "tedi-1:cron:objective-review",
			startedAt: "2030-03-17T17:46:40.000Z",
			finishedAt: "2030-03-17T17:47:10.000Z",
			status: "failure",
			transitions: { dispatched: false, stability: "timeout" },
			error: "conversation did not become stable within 30000ms",
		},
	);
}
console.log("PASS: buildCronStabilityTimeoutFailure");

// buildCronPreDispatchFailure ------------------------------------------------
{
	const start = buildCronExecutionStart(
		{ name: "app-operations" },
		"cron:sched-3:1900000000",
		"tedi-1:cron:app-operations",
		1_900_000_000_000,
	);
	assert.ok(start);
	assert.deepEqual(
		buildCronPreDispatchFailure(
			start!,
			1_900_000_001_000,
			"dispatch_context_error",
			new Error("D1 storage unavailable"),
		),
		{
			phase: "finished",
			fireKey: "cron:sched-3:1900000000",
			cronName: "app-operations",
			runId: "tedi-1:cron:app-operations",
			startedAt: "2030-03-17T17:46:40.000Z",
			finishedAt: "2030-03-17T17:46:41.000Z",
			status: "failure",
			transitions: {
				dispatched: false,
				stability: "ready",
				dispatchContext: "error",
			},
			error: "D1 storage unavailable",
		},
	);
	assert.deepEqual(
		buildCronPreDispatchFailure(
			start!,
			1_900_000_001_000,
			"stability_error",
			"stability RPC failed",
		).transitions,
		{ dispatched: false, stability: "error" },
	);
	assert.deepEqual(
		buildCronPreDispatchFailure(
			start!,
			1_900_000_001_000,
			"workflow_dispatch_error",
			"workflow unavailable",
		).transitions,
		{
			dispatched: false,
			stability: "ready",
			dispatchContext: "recorded",
			workflowDispatch: "error",
		},
	);
	const secretFailure = buildCronPreDispatchFailure(
		start!,
		1_900_000_001_000,
		"workflow_dispatch_error",
		`Authorization: Bearer abc.def-123 ${"x".repeat(2_000)}`,
	);
	assert.ok(
		!secretFailure.error.includes("abc.def-123"),
		"terminal error redacts bearer credentials",
	);
	assert.ok(
		secretFailure.error.endsWith("…(truncated)"),
		"terminal error is bounded",
	);
}
console.log("PASS: buildCronPreDispatchFailure");

// summarizeCronTurnTransitions -------------------------------------------------
assert.deepEqual(
	summarizeCronTurnTransitions({
		text: "done",
		stopReason: "end_turn",
		toolCalls: [
			{ name: "code", ok: true },
			{ name: "cron", ok: false },
			{ bogus: true },
		],
	}),
	{
		stopReason: "end_turn",
		responseChars: 4,
		toolCalls: [
			{ name: "code", ok: true },
			{ name: "cron", ok: false },
		],
	},
	"well-formed workflow result → mechanical transitions summary",
);
assert.deepEqual(
	summarizeCronTurnTransitions(undefined),
	{ stopReason: null, responseChars: null, toolCalls: [] },
	"absent result degrades to nulls, never throws",
);
assert.deepEqual(
	summarizeCronTurnTransitions("garbage"),
	{ stopReason: null, responseChars: null, toolCalls: [] },
	"non-object result degrades to nulls",
);
console.log("PASS: summarizeCronTurnTransitions");

// cronScheduleCeilingError --------------------------------------------------
// Every cron fire runs a FULL agent turn and the tool is reachable from the
// tedi's own in-turn tool selection, so an unbounded interval or job count is
// unbounded spend: without a ceiling, everyMs:1000 buys one real agent turn
// every second, forever. A loop with no ceiling is a bug.

// -- recurring interval floor
assert.ok(
	cronScheduleCeilingError({ kind: "every", everyMs: 1000 }, 0)?.includes(
		"too short",
	),
	"a 1s interval is rejected as too short (the runaway vector)",
);
assert.ok(
	cronScheduleCeilingError({ kind: "every", everyMs: 59_999 }, 0),
	"just under the floor is rejected",
);
assert.equal(
	cronScheduleCeilingError(
		{ kind: "every", everyMs: MIN_RECURRING_INTERVAL_MS },
		0,
	),
	null,
	"exactly at the floor is admissible",
);
assert.equal(
	cronScheduleCeilingError({ kind: "every", everyMs: 3_600_000 }, 0),
	null,
	"an hourly interval is admissible (legitimate periodic check)",
);

// -- sub-minute cron expressions (6-field = seconds column)
assert.ok(
	cronScheduleCeilingError({ kind: "cron", expr: "* * * * * *" }, 0)?.includes(
		"sub-minute",
	),
	"a 6-field (seconds) cron expression is rejected",
);
assert.equal(
	cronScheduleCeilingError({ kind: "cron", expr: "0 9 * * 1-5" }, 0),
	null,
	"a standard 5-field weekday-9am cron is admissible",
);
assert.equal(
	cronScheduleCeilingError({ kind: "cron", expr: "*/5 * * * *" }, 0),
	null,
	"every-5-minutes (5-field) is admissible",
);

// -- one-shot `at` is never interval-capped (reminders / follow-ups)
assert.equal(
	cronScheduleCeilingError({ kind: "at" }, 0),
	null,
	"a one-shot `at` schedule is always admissible",
);

// -- job-count cap, enforced against REAL schedule state
assert.equal(
	cronScheduleCeilingError({ kind: "at" }, MAX_SCHEDULED_JOBS - 1),
	null,
	"one below the job cap is admissible",
);
assert.ok(
	cronScheduleCeilingError({ kind: "at" }, MAX_SCHEDULED_JOBS)?.includes(
		"limit reached",
	),
	"at the job cap, even a one-shot is rejected",
);
assert.ok(
	cronScheduleCeilingError(
		{ kind: "every", everyMs: 3_600_000 },
		MAX_SCHEDULED_JOBS + 5,
	),
	"over the job cap, an otherwise-valid schedule is still rejected",
);
console.log(
	"PASS: cronScheduleCeilingError interval floor + sub-minute cron + job cap",
);

// Named conversational schedule retries are create-before-retire. A provider
// create failure leaves every prior schedule untouched; retry creates the
// replacement in the same non-main session before retiring the old row.
{
	const calls: string[] = [];
	let attempt = 0;
	const input = {
		spec: { kind: "cron", expr: "0 9 * * *" } as const,
		payload: {
			name: "daily",
			message: "check",
			sessionKey: "agent:main:project-red",
		},
		supersededIds: ["old"],
	};
	const writer = {
		create: async (
			_spec: unknown,
			payload: { sessionKey?: string },
			options: { fresh: boolean },
		) => {
			attempt += 1;
			calls.push(
				`create:${attempt}:fresh=${options.fresh}:session=${payload.sessionKey}`,
			);
			if (attempt === 1) throw new Error("scheduler unavailable");
			return { id: "new" };
		},
		cancel: async (id: string) => {
			calls.push(`cancel:${id}`);
			return true;
		},
	};
	await assert.rejects(
		writeConversationalSchedule(input, writer),
		/scheduler unavailable/,
	);
	assert.deepEqual(calls, [
		"create:1:fresh=true:session=agent:main:project-red",
	]);
	const retry = await writeConversationalSchedule(input, writer);
	assert.equal(retry.created.id, "new");
	assert.deepEqual(retry.retiredIds, ["old"]);
	assert.deepEqual(
		conversationalScheduleCreationReceipt(
			retry,
			{ id: "new", name: "daily" },
			"agent:main:project-red",
		),
		{
			ok: true,
			status: "created",
			created: { id: "new", sessionTarget: "agent:main:project-red" },
			job: { id: "new", name: "daily" },
			retiredIds: ["old"],
		},
	);
	assert.deepEqual(calls, [
		"create:1:fresh=true:session=agent:main:project-red",
		"create:2:fresh=true:session=agent:main:project-red",
		"cancel:old",
	]);
}

// An ambiguous retirement never rolls back the durable replacement. The
// duplicate is reported so an operator can reconcile it without a dark window.
{
	const calls: string[] = [];
	const receipt = await writeConversationalSchedule(
		{
			spec: { kind: "every", everySeconds: 3600 },
			payload: { name: "hourly", message: "check", sessionKey: "chat:b" },
			supersededIds: ["old-a", "old-b"],
		},
		{
			create: async (_spec, payload) => {
				calls.push("create");
				assert.equal(
					payload.sessionKey,
					"chat:b",
					"replacement preserves the conversation-isolation key",
				);
				return { id: "new" };
			},
			cancel: async (id) => {
				calls.push(`cancel:${id}`);
				if (id === "old-b") throw new Error("alarm recalc failed");
				return true;
			},
		},
	);
	assert.deepEqual(calls, ["create", "cancel:old-a", "cancel:old-b"]);
	assert.deepEqual(receipt.retiredIds, ["old-a"]);
	assert.deepEqual(receipt.retirementErrors, ["old-b:alarm recalc failed"]);
	assert.equal(receipt.created.id, "new");
	assert.deepEqual(
		conversationalScheduleCreationReceipt(
			receipt,
			{ id: "new", name: "hourly" },
			"chat:b",
		),
		{
			ok: true,
			status: "created_degraded",
			created: { id: "new", sessionTarget: "chat:b" },
			job: { id: "new", name: "hourly" },
			retiredIds: ["old-a"],
			degraded: true,
			retirementErrors: ["old-b:alarm recalc failed"],
		},
		"degraded receipt keeps successful creation distinct from retirement cleanup",
	);
}

// If Cloudflare deduplicates the fresh create back to an old id, never retire
// that id: the old schedule remains the sole live copy.
{
	let cancelled = false;
	await assert.rejects(
		writeConversationalSchedule(
			{
				spec: { kind: "at", at: new Date("2030-01-01T00:00:00.000Z") },
				payload: { name: "once", message: "check", sessionKey: "chat:c" },
				supersededIds: ["old"],
			},
			{
				create: async () => ({ id: "old" }),
				cancel: async () => {
					cancelled = true;
					return true;
				},
			},
		),
		/reused superseded schedule id/,
	);
	assert.equal(cancelled, false);
}

console.log("cron.test.ts: all assertions passed");

// isOrphanedIsolateDo -- the zombie-DO self-heal decision (fail-safe) ---------
// FALSE unless a DEFINITE mismatch, or a successful canonical lookup proves
// the tedi row was deleted. Lookup ambiguity remains fail-safe.
assert.equal(
	isOrphanedIsolateDo("cto-rebind-1782139014003", "cto-rebind-1782139014003"),
	false,
	"current DO (own === canonical) is not orphaned",
);
assert.equal(
	isOrphanedIsolateDo("cto", "cto-rebind-1782139014003"),
	true,
	"original slug-named DO after a rebind IS orphaned",
);
assert.equal(
	isOrphanedIsolateDo("cto-rebind-1700000000000", "cto-rebind-1782139014003"),
	true,
	"an older rebind DO IS orphaned",
);
assert.equal(
	isOrphanedIsolateDo("cto", null),
	false,
	"unknown canonical (never-rebound / null isolate_agent_id) => NOT orphaned",
);
assert.equal(
	isOrphanedIsolateDo("cto", ""),
	false,
	"empty canonical => NOT orphaned (fail-safe)",
);
assert.equal(
	isOrphanedIsolateDo("echo", null, false),
	true,
	"a persisted DO whose canonical tedi row is definitively absent IS orphaned",
);
assert.equal(
	isOrphanedIsolateDo(undefined, null, false),
	true,
	"a deleted canonical row is definitive even when a legacy DO name is unavailable",
);
assert.equal(
	isOrphanedIsolateDo(undefined, "cto-rebind-x"),
	false,
	"missing own name => NOT orphaned (fail-safe)",
);
assert.equal(
	isOrphanedIsolateDo("  cto  ", "cto"),
	false,
	"whitespace-trimmed equality => NOT orphaned",
);
console.log("PASS: isOrphanedIsolateDo");

// cronSchedulesSupersededByName -- idempotent-add dedup ------------------------
const scheds: ScheduleLike[] = [
	{
		id: "a1",
		callback: "onCronFire",
		type: "cron",
		payload: { name: "deploy-reconciler" },
	},
	{
		id: "a2",
		callback: "onCronFire",
		type: "cron",
		payload: { name: "deploy-reconciler" },
	},
	{
		id: "b1",
		callback: "onCronFire",
		type: "cron",
		payload: { name: "cold-tedi-smoke" },
	},
	{
		id: "c1",
		callback: "onFooBar",
		type: "cron",
		payload: { name: "deploy-reconciler" },
	},
	{ id: "d1", callback: "onCronFire", type: "cron", payload: null },
];
assert.deepEqual(
	cronSchedulesSupersededByName("deploy-reconciler", scheds).sort(),
	["a1", "a2"],
	"supersedes every same-name onCronFire schedule (the duplicates)",
);
assert.deepEqual(
	cronSchedulesSupersededByName("cold-tedi-smoke", scheds),
	["b1"],
	"supersedes the single same-name job",
);
assert.deepEqual(
	cronSchedulesSupersededByName("never-scheduled", scheds),
	[],
	"a new name supersedes nothing",
);
assert.deepEqual(
	cronSchedulesSupersededByName("", scheds),
	[],
	"empty name supersedes nothing (never mass-cancel)",
);
assert.deepEqual(
	cronSchedulesSupersededByName(undefined, scheds),
	[],
	"absent name supersedes nothing",
);
console.log("PASS: cronSchedulesSupersededByName");

// ── GOVERNANCE: TTL stop-contract ────────────────────────────────────────────
{
	const now = 1_800_000_000_000;
	const dflt = resolveCronExpiry("every", undefined, now);
	assert.deepEqual(
		dflt,
		{ expiresAtMs: now + DEFAULT_TOOL_CRON_TTL_MS },
		"recurring jobs default to a 30d expiry",
	);
	assert.deepEqual(
		resolveCronExpiry("at", undefined, now),
		{ expiresAtMs: null },
		"one-shots are self-bounding — no expiry",
	);
	const explicit = resolveCronExpiry(
		"cron",
		new Date(now + 86_400_000).toISOString(),
		now,
	);
	assert.deepEqual(
		explicit,
		{ expiresAtMs: now + 86_400_000 },
		"explicit expiresAt within the ceiling is honored",
	);
	assert.ok(
		"error" in resolveCronExpiry("cron", "not-a-date", now),
		"invalid expiresAt is a typed error",
	);
	assert.ok(
		"error" in
			resolveCronExpiry("every", new Date(now - 1000).toISOString(), now),
		"past expiresAt is a typed error",
	);
	assert.ok(
		"error" in
			resolveCronExpiry(
				"every",
				new Date(now + MAX_TOOL_CRON_TTL_MS + 86_400_000).toISOString(),
				now,
			),
		"expiresAt past the 365d ceiling is a typed error",
	);
	assert.equal(
		isCronFireExpired({ expiresAtMs: now - 1 }, now),
		true,
		"a fire past expiry is expired",
	);
	assert.equal(
		isCronFireExpired({ expiresAtMs: now + 1 }, now),
		false,
		"a fire before expiry runs",
	);
	assert.equal(
		isCronFireExpired({ expiresAtMs: null }, now),
		false,
		"null expiry never expires (template jobs)",
	);
	assert.equal(
		isCronFireExpired({}, now),
		false,
		"absent expiry never expires (pre-governance jobs)",
	);
	console.log("PASS: cron TTL stop-contract");
}

// ── GOVERNANCE: protected names ──────────────────────────────────────────────
{
	const names = ["deploy-reconciler", "cost-latency-anomaly-watcher"];
	assert.ok(
		protectedCronNameError("deploy-reconciler", names, "remove")?.includes(
			"protected",
		),
		"removing a protected name is refused",
	);
	assert.ok(
		protectedCronNameError("deploy-reconciler", names, "replace")?.includes(
			"replaced",
		),
		"replacing (add-upsert) a protected name is refused",
	);
	assert.equal(
		protectedCronNameError("my-reminder", names, "remove"),
		null,
		"unprotected names mutate freely",
	);
	assert.equal(
		protectedCronNameError("", names, "remove"),
		null,
		"empty name is never protected",
	);
	assert.equal(
		protectedCronNameError("deploy-reconciler", [], "remove"),
		null,
		"empty policy list protects nothing",
	);
	console.log("PASS: cron protected names");
}

// shouldRunTrajectoryMining (consolidation operator gate) ---------------------
{
	assert.equal(
		shouldRunTrajectoryMining({ name: SKILL_DEVELOPMENT_CRON_NAME }),
		true,
		"skill-development fires run the trajectory miner",
	);
	assert.equal(
		shouldRunTrajectoryMining({ name: " skill-development " }),
		true,
		"name is trimmed before matching",
	);
	assert.equal(
		shouldRunTrajectoryMining({ name: "brain-reflection" }),
		false,
		"other cognitive cycles do not mine",
	);
	assert.equal(
		shouldRunTrajectoryMining({}),
		false,
		"nameless one-shot fires never mine",
	);
	console.log("PASS: trajectory mining gate");
}

// withCognitiveCronDefaults — the S4 un-dark guarantee.
{
	const empty = withCognitiveCronDefaults([]);
	assert.equal(
		empty.length,
		DEFAULT_CRON_TEMPLATES.length,
		"empty pack still schedules all platform-default crons (the un-dark floor)",
	);
	for (const name of [
		"brain-reflection",
		"objective-review",
		"app-operations",
		"skill-development",
		"knowledge-freshness",
		"grounding-review",
	]) {
		assert.ok(
			empty.some((t) => t.name === name),
			`cognitive cron ${name} is platform-guaranteed on an empty pack`,
		);
	}

	// A pack template with the same NAME overrides schedule/message.
	const overridden = withCognitiveCronDefaults([
		{
			name: "brain-reflection",
			schedule: "0 */2 * * *",
			message: "custom reflection",
		},
	]);
	const br = overridden.find((t) => t.name === "brain-reflection");
	assert.equal(br?.schedule, "0 */2 * * *", "pack override wins on same name");
	assert.equal(
		overridden.length,
		DEFAULT_CRON_TEMPLATES.length,
		"same-name override does not add a duplicate",
	);

	// Pack-specific crons are added alongside the platform defaults.
	const withExtra = withCognitiveCronDefaults([
		{ name: "pack-only-cron", schedule: "0 0 * * *", message: "pack job" },
	]);
	assert.equal(
		withExtra.length,
		DEFAULT_CRON_TEMPLATES.length + 1,
		"pack-specific cron added to the platform defaults",
	);
	assert.ok(
		withExtra.some((t) => t.name === "pack-only-cron"),
		"pack-specific cron survives the merge",
	);

	// Malformed pack entries are ignored, defaults preserved.
	const malformed = withCognitiveCronDefaults([
		{ name: "", schedule: "x", message: "y" } as CronTemplateLike,
	]);
	assert.equal(
		malformed.length,
		DEFAULT_CRON_TEMPLATES.length,
		"nameless pack entry dropped, defaults kept",
	);

	// FLOOR INTEGRITY (regression): a same-name pack template with a BLANK
	// schedule/message — a stub, a typo, or an admin blanking it to "disable" the
	// cron — must NOT displace the known-good platform-floor default, and the
	// floor cron must still reconcile to a real schedule. Before the fix the blank
	// override won, then planCronReconcile skipped it (falsy schedule/message), so
	// brain-reflection was scheduled NOWHERE — the exact dark-cron starvation the
	// floor claims to prevent.
	{
		const blanked = withCognitiveCronDefaults([
			{ name: "brain-reflection", schedule: "", message: "" },
		]);
		const br = blanked.find((t) => t.name === "brain-reflection");
		assert.ok(br, "brain-reflection floor cron survives a blank pack override");
		assert.ok(
			br!.schedule.trim().length > 0 && br!.message.trim().length > 0,
			"blank pack override cannot dark the floor default",
		);
		assert.equal(
			blanked.length,
			DEFAULT_CRON_TEMPLATES.length,
			"blank override neither drops nor dupes",
		);
		const actions = planCronReconcile(blanked, []);
		assert.ok(
			actions.some((a) => a.name === "brain-reflection" && a.op === "add"),
			"floor cron still reconciles to a real schedule despite the blank pack entry",
		);
	}

	// FLOOR INTEGRITY (regression): a same-name pack template whose schedule is
	// non-blank but not a valid cron expression (e.g. "off") must also NOT
	// displace the floor default — otherwise the reconciler would emit an `add`
	// whose `this.schedule("off", …)` throws and aborts the whole pass, starving
	// every floor cron ordered after it.
	{
		const offOverride = withCognitiveCronDefaults([
			{ name: "brain-reflection", schedule: "off", message: "please disable" },
		]);
		const br = offOverride.find((t) => t.name === "brain-reflection");
		assert.equal(
			br?.schedule,
			"0 */8 * * *",
			"structurally-invalid cron expr cannot override the floor default",
		);
		// A non-default pack cron with a junk schedule is dropped before it can
		// reach the reconciler (so it can never throw mid-pass and starve the floor).
		const withJunk = withCognitiveCronDefaults([
			{ name: "pack-junk", schedule: "off", message: "x" },
		]);
		assert.ok(
			!withJunk.some((t) => t.name === "pack-junk"),
			"junk-schedule non-default pack cron is dropped, not handed to reconcile",
		);
		assert.equal(
			withJunk.length,
			DEFAULT_CRON_TEMPLATES.length,
			"junk non-default cron adds nothing",
		);
	}
	console.log("PASS: withCognitiveCronDefaults S4 un-dark guarantee");
}

// withCognitiveCronDefaults — pack opt-out authority (regression: a deliberately
// cron-less / non-cognitive pack must not be force-scheduled every shared
// LLM-turn cron).
{
	// Full opt-out: no floor at all → a cron-less pack incurs zero recurring spend.
	const optedOut = withCognitiveCronDefaults([], {
		disableCognitiveDefaults: true,
	});
	assert.equal(
		optedOut.length,
		0,
		"disableCognitiveDefaults suppresses the entire platform floor",
	);

	// Full opt-out still schedules the pack's OWN crons (pack authority intact).
	const optedOutWithOwn = withCognitiveCronDefaults(
		[{ name: "pack-only", schedule: "0 0 * * *", message: "m" }],
		{ disableCognitiveDefaults: true },
	);
	assert.deepEqual(
		optedOutWithOwn.map((t) => t.name),
		["pack-only"],
		"full opt-out keeps pack-specific crons and drops every default",
	);

	// Per-cycle opt-out: disable one named cognitive cron, keep the rest floored.
	const oneDisabled = withCognitiveCronDefaults([], {
		disabledCognitiveCronNames: ["objective-review"],
	});
	assert.equal(
		oneDisabled.length,
		DEFAULT_CRON_TEMPLATES.length - 1,
		"one named default suppressed",
	);
	assert.ok(
		!oneDisabled.some((t) => t.name === "objective-review"),
		"the named cognitive cron is opted out",
	);
	assert.ok(
		oneDisabled.some((t) => t.name === "brain-reflection"),
		"non-disabled defaults still floored",
	);

	// A pack's OWN same-name template wins even when the name is disabled.
	const disabledButOwn = withCognitiveCronDefaults(
		[{ name: "objective-review", schedule: "0 */2 * * *", message: "own" }],
		{ disabledCognitiveCronNames: ["objective-review"] },
	);
	assert.ok(
		disabledButOwn.some(
			(t) => t.name === "objective-review" && t.schedule === "0 */2 * * *",
		),
		"pack's own same-name template overrides suppression",
	);

	// No options → the floor is unchanged (the un-dark default is preserved).
	assert.equal(
		withCognitiveCronDefaults([]).length,
		DEFAULT_CRON_TEMPLATES.length,
		"absent opt-out keeps the full platform floor",
	);
	console.log("PASS: withCognitiveCronDefaults opt-out authority");
}

// Per-tedi runtime overrides are the final authority over a shared pack. This
// lets a utility tedi opt out without cloning the pack. Role-specific loops are
// not present in this shared floor.
{
	const shared = withCognitiveCronDefaults([]);
	const noReflection = applyTediCronPolicyOverrides(shared, {
		disabledCognitiveCronNames: ["brain-reflection"],
	});
	assert.equal(noReflection.length, shared.length - 1);
	assert.ok(!noReflection.some((t) => t.name === "brain-reflection"));

	const paused = applyTediCronPolicyOverrides(shared, {
		disableCognitiveDefaults: true,
	});
	assert.deepEqual(
		paused,
		[],
		"utility tedi can disable every shared template",
	);

	const explicit = applyTediCronPolicyOverrides(shared, {
		disableCognitiveDefaults: true,
		cronTemplates: [
			{ name: "weekly-check", schedule: "0 9 * * 1", message: "check" },
		],
	});
	assert.deepEqual(explicit, [
		{ name: "weekly-check", schedule: "0 9 * * 1", message: "check" },
	]);
	console.log("PASS: per-tedi cron policy overrides");
}
