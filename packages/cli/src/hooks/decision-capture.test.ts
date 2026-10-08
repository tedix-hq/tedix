import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DETACHED, runAgentStatus } from "./agent-status";
import {
	autoDeliveryPath,
	captureStatePath,
	claimReply,
	classify,
	DECLINE_MARKER,
	draftStatusPath,
	peek,
	questionPath,
	repositoryName,
	runDecisionCapture,
} from "./decision-capture";
import type { JsonObject } from "./hook-io";

test("the repository is named by its Git origin, not a worktree folder", () => {
	const worktree = "/src/example/.claude/worktrees/agent-1234";
	expect(
		repositoryName("git@github.com:example-org/widgets.git", worktree),
	).toBe("widgets");
	expect(
		repositoryName("https://github.com/example-org/widgets/", worktree),
	).toBe("widgets");
	expect(repositoryName(undefined, "/src/widgets")).toBe("widgets");
});

/** Checks for opt-in decision capture: pairing, redaction, opt-in and fail-silent behaviour. */
const SESSION = "77777777-7777-4777-8777-777777777777";
const PROJECT = "66666666-6666-4666-8666-666666666666";
const WORK = "55555555-5555-4555-8555-555555555555";
const REQUEST = "99999999-9999-4999-8999-999999999999";
const BINDING = {
	status: "bound",
	workspace: "fixture",
	org: "org_fixture",
	mcpUrl: "https://fixture.example.invalid/mcp",
	projectId: PROJECT,
	root: process.cwd(),
	decisionCapture: true,
};
const AUTH = {
	wouldUse: "stored-login",
	workspace: "fixture",
	mcpUrl: BINDING.mcpUrl,
	storedLogin: { loginId: "U-fixture-user" },
};
const CREATED = { id: REQUEST, version: 1 };
const TRIAGE_CALLABLE = "agent.triage_agent_turn";
const LABEL_CALLABLE = "agent.label_agent_reply";
const REQUEST_DRAFT_CALLABLE = "agent.request_agent_reply_draft";
const DETAIL_CALLABLE = "work.get_work_interaction";

const nativeRequest = (overrides: JsonObject = {}) => ({
	id: REQUEST,
	orgId: "11111111-1111-4111-8111-111111111111",
	workItemId: null,
	caseId: null,
	projectId: null,
	kind: "question",
	subject: "Fixture decision",
	prompt: "Fixture question",
	requestedFromType: "user",
	requestedFromId: "U-fixture-user",
	creatorType: "user",
	creatorId: "U-fixture-user",
	creatorSessionId: null,
	state: "open",
	requestedAt: "2026-10-06T00:00:00Z",
	dueAt: null,
	expiresAt: null,
	resolvedAt: null,
	version: 2,
	metadata: {},
	...overrides,
});
const nativeResponse = (overrides: JsonObject) => ({
	id: "22222222-2222-4222-8222-222222222222",
	requestId: REQUEST,
	responseKind: "answer",
	body: "Fixture answer",
	artifactRef: null,
	artifactVersion: null,
	artifactDigest: null,
	resolvesRequest: true,
	respondedByType: "user",
	respondedById: "U-fixture-user",
	respondedBySessionId: null,
	respondedAt: "2026-10-06T01:00:00Z",
	metadata: {},
	...overrides,
});
let config: string;
let payloads: Array<[string[], JsonObject]>;
let gatewayCalls: Array<[string, JsonObject, string[]]>;
let spawned: string[][];

type Gateway = Record<string, (input: JsonObject) => unknown>;

beforeEach(() => {
	config = mkdtempSync(join(tmpdir(), "tedix-capture-"));
	payloads = [];
	gatewayCalls = [];
	spawned = [];
});
afterEach(() => rmSync(config, { recursive: true, force: true }));

async function runHook(
	mode: "stop" | "reply",
	event: JsonObject,
	reads: unknown[],
	{
		env = {},
		duringCreate,
		failRespond = false,
		stdin,
		gateway = {},
		timeoutMs,
	}: {
		env?: Record<string, string>;
		duringCreate?: () => void;
		failRespond?: boolean;
		stdin?: string;
		/** Code Mode callables; a missing one fails like an undeployed tool. */
		gateway?: Gateway;
		timeoutMs?: number;
	} = {},
): Promise<string[][]> {
	const calls: string[][] = [];
	const environment: NodeJS.ProcessEnv = {
		TEDIX_CONFIG_DIR: config,
		TEDIX_EXTERNAL_AGENT: "agent",
		TEDIX_MCP_BEARER_TOKEN: "token",
		...env,
	};
	await runDecisionCapture(
		mode,
		{
			env: environment,
			stdin: stdin ?? JSON.stringify({ session_id: SESSION, ...event }),
			cwd: process.cwd(),
			write: () => {
				throw new Error("capture never writes to stdout");
			},
			branch: () => "main",
			read: async (args, _timeout, stdinInput) => {
				calls.push(args);
				// Interactions are addressed to the signed-in user, never an agent identity.
				expect(environment.TEDIX_EXTERNAL_AGENT).toBeUndefined();
				expect(environment.TEDIX_MCP_BEARER_TOKEN).toBeUndefined();
				if (args.includes("interaction-get")) {
					expect(stdinInput).toBeUndefined();
					expect(args.slice(-5)).toEqual([
						"work",
						"interaction-get",
						REQUEST,
						"--input",
						JSON.stringify({ responseLimit: 5 }),
					]);
					const handler = gateway[DETAIL_CALLABLE];
					if (!handler) throw new Error("Unknown native tool");
					gatewayCalls.push([
						DETAIL_CALLABLE,
						{ requestId: REQUEST, responseLimit: 5 },
						args,
					]);
					return structuredClone(
						await handler({ requestId: REQUEST, responseLimit: 5 }),
					) as JsonObject;
				}
				const codeAgent =
					typeof stdinInput === "string" &&
					/^async \(\) => await (agent\.[a-z_]+)\(([\s\S]*)\)$/.exec(
						stdinInput,
					);
				if (codeAgent && args.at(-1) === "code") {
					const callable = codeAgent[1]!;
					expect(_timeout).toBe(
						timeoutMs ??
							(callable === "agent.triage_agent_turn" ||
							callable === "agent.request_agent_reply_draft"
								? 6000
								: 3000),
					);
					const input = JSON.parse(codeAgent[2]!);
					gatewayCalls.push([callable, input, args]);
					const handler = gateway[callable];
					if (!handler) throw new Error("Unknown agent tool");
					return structuredClone(await handler(input)) as JsonObject;
				}
				const nativeAgentVerbs: Record<string, string> = {
					"agent-turn-triage": TRIAGE_CALLABLE,
					"agent-reply-label": LABEL_CALLABLE,
					"agent-reply-draft-request": REQUEST_DRAFT_CALLABLE,
				};
				const agentVerb = args.find((arg) => nativeAgentVerbs[arg]);
				if (agentVerb) {
					expect(_timeout).toBe(
						timeoutMs ?? (agentVerb === "agent-turn-triage" ? 4000 : 3000),
					);
					expect(stdinInput).toBeUndefined();
					const fileArg = args[args.indexOf("--input") + 1]!;
					expect(fileArg.startsWith("@")).toBe(true);
					const input = JSON.parse(readFileSync(fileArg.slice(1), "utf8"));
					const callable = nativeAgentVerbs[agentVerb]!;
					gatewayCalls.push([callable, input, args]);
					const handler = gateway[callable];
					if (!handler) throw new Error("Unknown native agent tool");
					return structuredClone(await handler(input)) as JsonObject;
				}
				if (args.includes("code"))
					throw new Error("Unexpected Code Mode wrapper");
				if (failRespond && args.includes("interaction-respond"))
					throw new Error("offline");
				const input = args.indexOf("--input");
				if (input >= 0)
					payloads.push([
						args,
						JSON.parse(readFileSync(args[input + 1]!.slice(1), "utf8")),
					]);
				if (duringCreate && args.includes("interaction-create")) duringCreate();
				if (!reads.length) throw new Error("unexpected read");
				return structuredClone(reads.shift()) as JsonObject;
			},
		},
		{
			status: {
				platform: "darwin",
				which: (name) => `/usr/bin/${name}`,
				spawn: (args, options) => {
					expect(options).toEqual(DETACHED);
					spawned.push(args);
				},
				label: () => "repo · main",
			},
			...(timeoutMs
				? {
						triageTimeoutMs: timeoutMs,
						labelTimeoutMs: timeoutMs,
						draftTimeoutMs: timeoutMs,
						detailTimeoutMs: timeoutMs,
					}
				: {}),
		},
	);
	return calls;
}

function enableStatus(): void {
	writeFileSync(
		join(config, "agent-status.json"),
		JSON.stringify({ enabled: true, profile: "connect" }),
	);
}
const statusState = () => {
	const path = join(config, "agent-status", `claude-code-${SESSION}.json`);
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
};
const notifications = () => spawned.filter((args) => args[0] === "osascript");
const reports = () => spawned.filter((args) => args[0] === "tedix");
const TRIAGE_OK = {
	status: "ok",
	urgency: "now",
	labels: { blocker_or_failure: 0.91, risky_action: 0.12 },
	urgentLabels: ["blocker_or_failure"],
	model: "clef-fixture",
	policyVersion: 3,
	latencyMs: 42,
};
const UNAVAILABLE = {
	status: "unavailable",
	urgency: "later",
	labels: {},
	urgentLabels: [],
	model: "",
	policyVersion: 0,
};

const state = () => join(config, "decision-capture", `${SESSION}.json`);
const verbs = () =>
	payloads.map(([args]) =>
		args.includes("interaction-create")
			? "interaction-create"
			: "interaction-respond",
	);

describe("tedix hooks capture-stop / capture-reply", () => {
	test("a turn end and its reply become one resolved Interaction", async () => {
		await runHook(
			"stop",
			{
				last_assistant_message:
					"## **Deployed** commit `fc6b8f9`\nAll green. Want me to also clean up legacy?",
			},
			[BINDING, AUTH, CREATED],
		);
		const [args, created] = payloads[0]!;
		expect(args).toContain("interaction-create");
		expect(created.projectId).toBe(PROJECT);
		expect(created.requestedFrom).toEqual({
			type: "user",
			id: "U-fixture-user",
		});
		expect(created.kind).toBe("question");
		expect(created.subject).toMatch(
			/claude-code waiting: Deployed commit fc6b8f9$/,
		);
		expect(created.metadata.sessionId).toBe(SESSION);
		expect(Date.parse(created.expiresAt) - Date.now()).toBeGreaterThan(
			0.9 * 86_400_000,
		);
		expect(existsSync(state())).toBe(true);
		await runHook(
			"reply",
			{ prompt: "yes and aggressively remove the legacy path" },
			[BINDING, AUTH, { request: CREATED }],
		);
		const [replyArgs, response] = payloads[1]!;
		expect(replyArgs[replyArgs.indexOf("interaction-respond") + 1]).toBe(
			REQUEST,
		);
		expect(response.body).toBe("yes and aggressively remove the legacy path");
		expect(response.responseKind).toBe("answer");
		expect(response.metadata.replyClass).toBe("simplify");
		expect(response.resolvesRequest).toBe(true);
		expect(existsSync(state())).toBe(false);
	});

	test("outside a bound repository the default organization's inbox gets a repository-free question", async () => {
		const { root: _root, ...rest } = BINDING;
		const calls = await runHook(
			"stop",
			{ last_assistant_message: "Draft the pricing memo for Q4?" },
			[{ ...rest, contextSource: "default" }, AUTH, CREATED],
		);
		expect(calls[0]).toContain("--allow-default");
		const created = payloads[0]![1];
		expect(created.projectId).toBe(PROJECT);
		expect(created.metadata.repository).toBeNull();
		expect(created.subject).toMatch(/^session · claude-code waiting: /);
	});

	test("selected Work is the context and secrets are redacted", async () => {
		await runHook(
			"stop",
			{
				last_assistant_message:
					"Set TEDIX_API_KEY=abcd1234secret and Bearer abcdefghijklmnopqrstuvwxyz",
			},
			[{ ...BINDING, workItemId: WORK }, AUTH, CREATED],
		);
		const created = payloads[0]![1];
		expect(created.workItemId).toBe(WORK);
		expect(created).not.toHaveProperty("projectId");
		expect(JSON.stringify(created)).not.toContain("abcd1234secret");
		expect(JSON.stringify(created)).not.toContain("abcdefghijklmnopqrstuvwxyz");
	});

	test("without opt-in nothing is sent or stored", async () => {
		const calls = await runHook("stop", { last_assistant_message: "done" }, [
			{ ...BINDING, decisionCapture: false },
		]);
		expect(calls).toHaveLength(1);
		expect(payloads).toEqual([]);
		expect(existsSync(state())).toBe(false);
		await runHook("stop", { last_assistant_message: "done" }, [
			{ status: "unbound" },
		]);
		expect(payloads).toEqual([]);
	});

	test("claude -p and codex exec file no question", async () => {
		const rollout = join(config, "rollout-exec.jsonl");
		writeFileSync(
			rollout,
			`${JSON.stringify({ type: "session_meta", payload: { originator: "codex_exec", source: "exec" } })}\n`,
		);
		expect(
			await runHook("stop", { last_assistant_message: "done" }, [BINDING], {
				env: { CLAUDE_CODE_SESSION_ATTENDED: "0" },
			}),
		).toEqual([]);
		expect(
			await runHook(
				"stop",
				{
					last_assistant_message: "done",
					turn_id: "turn-1",
					transcript_path: rollout,
				},
				[BINDING],
			),
		).toEqual([]);
		expect(payloads).toEqual([]);
		expect(existsSync(state())).toBe(false);
	});

	test("system re-entries and unpaired prompts are not replies", async () => {
		expect(
			await runHook("reply", { prompt: "first prompt of a session" }, []),
		).toEqual([]);
		await runHook(
			"stop",
			{ last_assistant_message: "Running tests in the background." },
			[BINDING, AUTH, CREATED],
		);
		for (const prompt of [
			"<task-notification>\n<task-id>x</task-id>",
			"[SYSTEM NOTIFICATION - NOT USER INPUT]",
			"<system-reminder>x</system-reminder>",
		])
			expect(await runHook("reply", { prompt }, [])).toEqual([]);
		expect(existsSync(state())).toBe(true);
	});

	test("a pending background turn is not waiting on the user", async () => {
		await runHook(
			"stop",
			{
				last_assistant_message: "Waiting for agents.",
				background_tasks: [{ id: "a" }],
			},
			[BINDING, AUTH],
		);
		expect(payloads).toEqual([]);
	});

	test("an unanswered turn is left to expire when the next one ends", async () => {
		await runHook("stop", { last_assistant_message: "first" }, [
			BINDING,
			AUTH,
			CREATED,
		]);
		const second = { id: "88888888-8888-4888-8888-888888888888", version: 1 };
		await runHook("stop", { last_assistant_message: "second" }, [
			BINDING,
			AUTH,
			second,
		]);
		// Never an answer in the user's name, never a cancel, never a rejected close.
		expect(verbs()).toEqual(["interaction-create", "interaction-create"]);
		expect(
			Date.parse(payloads[1]![1].expiresAt) - Date.now(),
		).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
		expect(JSON.parse(readFileSync(state(), "utf8")).requestId).toBe(second.id);
	});

	test("a reply typed while the question is created is kept", async () => {
		const path = captureStatePath({ TEDIX_CONFIG_DIR: config }, SESSION);
		await runHook(
			"stop",
			{ last_assistant_message: "Ship it?" },
			[BINDING, AUTH, CREATED, { request: CREATED }],
			{
				duringCreate: () =>
					expect(claimReply({ prompt: "yes" }, path)).toBe("early"),
			},
		);
		expect(verbs()).toEqual(["interaction-create", "interaction-respond"]);
		const answer = payloads[1]![1];
		expect(answer.body).toBe("yes");
		expect(answer.responseKind).toBe("answer");
		expect(answer.metadata.source).toBe("user-reply");
		expect(existsSync(state())).toBe(false);
	});

	test("a reply that fails to send is retried at the next turn end", async () => {
		await runHook("stop", { last_assistant_message: "first" }, [
			BINDING,
			AUTH,
			CREATED,
		]);
		await runHook("reply", { prompt: "make it happen" }, [BINDING, AUTH], {
			failRespond: true,
		});
		expect(existsSync(state())).toBe(true);
		const second = { id: "88888888-8888-4888-8888-888888888888", version: 1 };
		await runHook("stop", { last_assistant_message: "second" }, [
			BINDING,
			AUTH,
			{ request: CREATED },
			second,
		]);
		const retried = payloads.at(-2)![1];
		expect(retried.body).toBe("make it happen");
		expect(retried.metadata.source).toBe("user-reply");
	});

	test("Codex identity and failures stay silent", async () => {
		await runHook(
			"stop",
			{ last_assistant_message: "done" },
			[BINDING, AUTH, CREATED],
			{
				env: { CODEX_THREAD_ID: SESSION },
			},
		);
		expect(payloads[0]![1].subject).toContain("codex waiting");
		await runHook("stop", { last_assistant_message: "done" }, [
			BINDING,
			{ ...AUTH, wouldUse: "external-agent:x" },
		]);
		await runHook("stop", { last_assistant_message: "done" }, [
			{ ...BINDING, contextSessionId: REQUEST },
		]);
		expect(await runHook("stop", {}, [], { stdin: "{not json" })).toEqual([]);
		expect(payloads).toHaveLength(1);
	});

	test("globally configured Codex hooks are labelled codex from the event, and the reply keeps it", async () => {
		await runHook(
			"stop",
			{ last_assistant_message: "done", turn_id: "turn-1" },
			[BINDING, AUTH, CREATED],
		);
		expect(payloads[0]![1].subject).toContain("codex waiting");
		await runHook("reply", { prompt: "continue" }, [
			BINDING,
			AUTH,
			{ request: CREATED },
		]);
		expect(payloads[1]![1].metadata.host).toBe("codex");
	});

	test("automated heartbeat turns are neither questions nor replies", async () => {
		await runHook(
			"stop",
			{ last_assistant_message: "<heartbeat>tick</heartbeat>" },
			[],
		);
		expect(payloads).toEqual([]);
		await runHook("stop", { last_assistant_message: "Ship it?" }, [
			BINDING,
			AUTH,
			CREATED,
		]);
		expect(
			await runHook("reply", { prompt: "<heartbeat>tick</heartbeat>" }, []),
		).toEqual([]);
		expect(existsSync(state())).toBe(true);
	});

	test("mined reply classes", () => {
		for (const [reply, label] of [
			["continue", "continue"],
			["make it happen", "approve"],
			["its already done, right?", "challenge"],
			["recheck now", "verify"],
			["explain me in simple user stories", "plain-english"],
			["fan out with subagents", "fan-out"],
			["commit and push all deps bumps", "ship"],
			["status now?", "status"],
			["Do you need me babysit you?", "frustration"],
			["add a sidebar button", "instruction"],
		])
			expect(classify(reply!)).toBe(label!);
	});

	test("urgent triage travels in the create payload and notifies once", async () => {
		enableStatus();
		const message = "## Blocked\nThe D1 migration failed; deploy is halted.";
		const calls = await runHook(
			"stop",
			{ hook_event_name: "Stop", last_assistant_message: message },
			[BINDING, AUTH, CREATED],
			{ gateway: { [TRIAGE_CALLABLE]: () => TRIAGE_OK } },
		);
		const [callable, input, args] = gatewayCalls[0]!;
		expect(callable).toBe(TRIAGE_CALLABLE);
		expect(input).toEqual({ text: message });
		// Turn text reaches the child over stdin as Code Mode source, never argv.
		expect(args).toEqual(["-w", "fixture", "code"]);
		expect(calls.flat().join(" ")).not.toContain("D1 migration");
		expect(payloads[0]![1].metadata.triage).toEqual(TRIAGE_OK);
		expect(statusState()?.state).toBe("needs_you");
		expect(notifications()).toHaveLength(1);
		expect(notifications()[0]!.at(-3)).toBe(
			"Blocker: The D1 migration failed; deploy is halted.",
		);
		expect(reports()).toHaveLength(1);
		// The status hook's own Stop handler stays out of a chat capture owns.
		await runAgentStatus({
			env: { TEDIX_CONFIG_DIR: config },
			stdin: JSON.stringify({
				session_id: SESSION,
				hook_event_name: "Stop",
				last_assistant_message: message,
			}),
			cwd: process.cwd(),
			captureOwnsStop: () => true,
			spawn: (spawnArgs) => spawned.push(spawnArgs),
		});
		expect(notifications()).toHaveLength(1);
		expect(reports()).toHaveLength(1);
	});

	test("later triage records done without a notification", async () => {
		enableStatus();
		await runHook(
			"stop",
			{ last_assistant_message: "Pushed.\n\nWant me to also tidy the docs?" },
			[BINDING, AUTH, CREATED],
			{
				gateway: {
					[TRIAGE_CALLABLE]: () => ({
						...TRIAGE_OK,
						urgency: "later",
						urgentLabels: [],
					}),
				},
			},
		);
		expect(payloads[0]![1].metadata.triage.urgency).toBe("later");
		expect(statusState()).toMatchObject({ state: "done", summary: "Pushed." });
		expect(notifications()).toEqual([]);
		expect(reports()).toHaveLength(1);
	});

	test("unavailable triage falls back to the regex classifier", async () => {
		enableStatus();
		await runHook("stop", { last_assistant_message: "Should I push?" }, [
			BINDING,
			AUTH,
			CREATED,
		]);
		const triage = payloads[0]![1].metadata.triage;
		expect(triage).toMatchObject(UNAVAILABLE);
		expect(typeof triage.latencyMs).toBe("number");
		expect(statusState()).toMatchObject({
			state: "needs_you",
			summary: "Should I push?",
		});
		expect(notifications()).toHaveLength(1);
		// A malformed result is unavailable too.
		await runHook(
			"stop",
			{ last_assistant_message: "Pushed." },
			[
				BINDING,
				AUTH,
				{ id: "88888888-8888-4888-8888-888888888888", version: 1 },
			],
			{
				gateway: {
					[TRIAGE_CALLABLE]: () => ({ status: "ok", urgency: "soon" }),
				},
			},
		);
		expect(payloads[1]![1].metadata.triage.status).toBe("unavailable");
		expect(statusState()?.state).toBe("done");
	});

	test("a slow triage times out and the question is still created", async () => {
		enableStatus();
		await runHook(
			"stop",
			{ last_assistant_message: "Should I push?" },
			[BINDING, AUTH, CREATED],
			{
				timeoutMs: 20,
				gateway: { [TRIAGE_CALLABLE]: () => new Promise(() => {}) },
			},
		);
		expect(payloads[0]![1].metadata.triage.status).toBe("unavailable");
		expect(notifications()).toHaveLength(1);
	});

	test("an owned Stop still reports when capture fails before triage", async () => {
		enableStatus();
		await runHook("stop", { last_assistant_message: "Should I push?" }, [
			BINDING,
			{ ...AUTH, wouldUse: "external-agent:x" },
		]);
		expect(payloads).toEqual([]);
		expect(statusState()?.state).toBe("needs_you");
		expect(notifications()).toHaveLength(1);
		// Without the opt-in, capture never touches the status.
		rmSync(join(config, "agent-status"), { recursive: true, force: true });
		await runHook("stop", { last_assistant_message: "Should I push?" }, [
			{ ...BINDING, decisionCapture: false },
		]);
		expect(statusState()).toBeUndefined();
		expect(notifications()).toHaveLength(1);
	});

	test("the reply carries the Clef label next to the regex class", async () => {
		const message = "Deployed. Want me to clean up legacy?";
		await runHook("stop", { last_assistant_message: message }, [
			BINDING,
			AUTH,
			CREATED,
		]);
		await runHook(
			"reply",
			{ prompt: "yes, go ahead" },
			[BINDING, AUTH, { request: CREATED }],
			{
				gateway: {
					[LABEL_CALLABLE]: () => ({
						status: "ok",
						label: "approve",
						p: 0.93,
						model: "clef-fixture",
					}),
				},
			},
		);
		expect(gatewayCalls.at(-1)!.slice(0, 2)).toEqual([
			LABEL_CALLABLE,
			{ turnText: message, replyText: "yes, go ahead" },
		]);
		const metadata = payloads.at(-1)![1].metadata;
		expect(metadata.replyClass).toBe("approve");
		expect(metadata.replyClassClef).toEqual({ label: "approve", p: 0.93 });
	});

	test("a missing, unavailable or slow Clef label leaves only the regex class", async () => {
		for (const gateway of [
			{},
			{ [LABEL_CALLABLE]: () => ({ status: "unavailable" }) },
			{ [LABEL_CALLABLE]: () => new Promise(() => {}) },
		] as Gateway[]) {
			payloads = [];
			await runHook("stop", { last_assistant_message: "Ship it?" }, [
				BINDING,
				AUTH,
				CREATED,
			]);
			await runHook(
				"reply",
				{ prompt: "ship it" },
				[BINDING, AUTH, { request: CREATED }],
				{ gateway, timeoutMs: 20 },
			);
			const metadata = payloads.at(-1)![1].metadata;
			expect(metadata.replyClass).toBe("ship");
			expect(metadata).not.toHaveProperty("replyClassClef");
		}
	});

	test("a later question asks for a tedi draft; an urgent one does not", async () => {
		const later = { ...TRIAGE_OK, urgency: "later", urgentLabels: [] };
		let asked: JsonObject[] = [];
		await runHook(
			"stop",
			{ last_assistant_message: "Pushed. Tidy the docs too?" },
			[BINDING, AUTH, CREATED],
			{
				gateway: {
					[TRIAGE_CALLABLE]: () => later,
					[REQUEST_DRAFT_CALLABLE]: (input) => {
						asked.push(input);
						return { status: "queued" };
					},
				},
			},
		);
		expect(asked).toEqual([{ requestId: REQUEST }]);
		// The draft request carries only the ID through the private payload file.
		const draftCall = gatewayCalls.find(
			([name]) => name === REQUEST_DRAFT_CALLABLE,
		)!;
		expect(draftCall[2]).toEqual(["-w", "fixture", "code"]);
		expect(
			JSON.parse(readFileSync(questionPath(state()), "utf8")),
		).toMatchObject({ requestId: REQUEST, host: "claude-code" });
		asked = [];
		await runHook(
			"stop",
			{ last_assistant_message: "Blocked." },
			[BINDING, AUTH, { request: CREATED }, CREATED],
			{
				gateway: {
					[TRIAGE_CALLABLE]: () => TRIAGE_OK,
					[REQUEST_DRAFT_CALLABLE]: (input) => {
						asked.push(input);
						return { status: "queued" };
					},
				},
			},
		);
		expect(asked).toEqual([]);
	});

	test("a missing, ineligible or slow draft tool leaves the question as it was", async () => {
		for (const gateway of [
			{},
			{
				[REQUEST_DRAFT_CALLABLE]: () => ({ status: "ineligible", reason: "x" }),
			},
			{ [REQUEST_DRAFT_CALLABLE]: () => new Promise(() => {}) },
		] as Gateway[]) {
			payloads = [];
			await runHook(
				"stop",
				{ last_assistant_message: "Ship it?" },
				[BINDING, AUTH, CREATED],
				{ gateway, timeoutMs: 20 },
			);
			expect(verbs()).toEqual(["interaction-create"]);
			expect(JSON.parse(readFileSync(state(), "utf8")).requestId).toBe(REQUEST);
		}
	});

	test("a reply typed while the question is created gets no draft request", async () => {
		let asked = 0;
		await runHook(
			"stop",
			{ last_assistant_message: "Ship it?" },
			[BINDING, AUTH, CREATED, { request: CREATED }],
			{
				duringCreate: () => {
					expect(
						claimReply(
							{ prompt: "ship it" },
							captureStatePath({ TEDIX_CONFIG_DIR: config }, SESSION),
						),
					).toBe("early");
				},
				gateway: {
					[REQUEST_DRAFT_CALLABLE]: () => {
						asked++;
						return { status: "queued" };
					},
				},
			},
		);
		expect(verbs()).toEqual(["interaction-create", "interaction-respond"]);
		expect(asked).toBe(0);
	});

	const DRAFT_ID = "abababab-abab-4bab-8bab-abababababab";
	const DRAFT_BODY = "Yes, tidy the docs and push.";
	const detail = (overrides: JsonObject = {}): JsonObject => ({
		request: nativeRequest({
			expiresAt: "2026-10-07T00:00:00Z",
			prompt: "PRIVATE QUESTION TEXT",
		}),
		effectiveState: "open",
		canRespond: true,
		canCancel: false,
		latestDraft: {
			id: DRAFT_ID,
			body: DRAFT_BODY,
			rationale: "Docs drift after a push.",
			drafterId: "tedi-fixture",
			drafterName: null,
			delivery: "review",
			createdAt: "2026-10-06T00:00:00Z",
			turnType: "approve",
		},
		responses: { data: [], nextCursor: null, hasMore: false },
		...overrides,
	});

	async function replyWith(prompt: string, interaction: unknown, extra = {}) {
		await runHook("stop", { last_assistant_message: "Tidy the docs?" }, [
			BINDING,
			AUTH,
			CREATED,
		]);
		payloads = [];
		gatewayCalls = [];
		return runHook("reply", { prompt }, [BINDING, AUTH, { request: CREATED }], {
			gateway: {
				[DETAIL_CALLABLE]: () =>
					interaction instanceof Error
						? Promise.reject(interaction)
						: interaction,
			},
			...extra,
		});
	}

	test("a reply typed in the chat never sends or cites a tedi draft", async () => {
		// The draft is only visible in Tedix OS, so "ok" here answers the agent.
		for (const word of ["ok", "yes", "Yes, tidy the docs and push."]) {
			await replyWith(word, detail());
			const [args, sent] = payloads.at(-1)!;
			expect(args).toContain("interaction-respond");
			expect(sent.body).toBe(word);
			expect(sent.expectedRequestVersion).toBe(2);
			expect(sent.metadata).not.toHaveProperty("draftId");
			expect(sent.metadata).not.toHaveProperty("draftOutcome");
			expect(sent.metadata).not.toHaveProperty("editRatio");
			const [callable, input] = gatewayCalls[0]!;
			expect([callable, input]).toEqual([
				DETAIL_CALLABLE,
				{ requestId: REQUEST, responseLimit: 5 },
			]);
		}
	});

	test("a typed reply to an auto-delivered question cites the draft as auto-sent", async () => {
		const auto = () => autoDeliveryPath(state());
		mkdirSync(join(config, "decision-capture"), { recursive: true });
		const record = (requestId: string) =>
			writeFileSync(
				auto(),
				JSON.stringify({ requestId, draftId: DRAFT_ID, count: 2 }),
			);
		await runHook("stop", { last_assistant_message: "Tidy the docs?" }, [
			BINDING,
			AUTH,
			CREATED,
		]);
		record(REQUEST);
		payloads = [];
		await runHook(
			"reply",
			{ prompt: "actually skip the docs" },
			[BINDING, AUTH, { request: CREATED }],
			{ gateway: { [DETAIL_CALLABLE]: () => detail() } },
		);
		const sent = payloads.at(-1)![1];
		expect(sent.body).toBe("actually skip the docs");
		expect(sent.metadata).toMatchObject({
			source: "user-reply",
			draftId: DRAFT_ID,
			draftOutcome: "auto-sent",
		});
		// A typed reply ends the run of consecutive auto replies.
		expect(existsSync(auto())).toBe(false);
		// Another question's auto delivery is never cited, but still reset.
		record("88888888-8888-4888-8888-888888888888");
		await runHook("stop", { last_assistant_message: "Tidy the docs?" }, [
			BINDING,
			AUTH,
			CREATED,
		]);
		payloads = [];
		await runHook(
			"reply",
			{ prompt: "ok" },
			[BINDING, AUTH, { request: CREATED }],
			{
				gateway: { [DETAIL_CALLABLE]: () => detail() },
			},
		);
		expect(payloads.at(-1)![1].metadata).not.toHaveProperty("draftOutcome");
		expect(existsSync(auto())).toBe(false);
	});

	test("the next turn declining an auto draft records it as rejected, once", async () => {
		const auto = autoDeliveryPath(state());
		mkdirSync(join(config, "decision-capture"), { recursive: true });
		writeFileSync(
			auto,
			JSON.stringify({ requestId: REQUEST, draftId: DRAFT_ID, count: 1 }),
		);
		const decline = `${DECLINE_MARKER}: the top accepted items are already shipped.\nClosing them instead.`;
		await runHook("stop", { last_assistant_message: decline }, [
			BINDING,
			AUTH,
			CREATED,
		]);
		expect(payloads[0]![1].metadata.priorDraft).toEqual({
			draftId: DRAFT_ID,
			draftOutcome: "rejected",
			reason: `${DECLINE_MARKER}: the top accepted items are already shipped.`,
			source: "agent-turn",
		});
		// The draft keeps its ID for the user's reply; a later turn never re-judges it.
		expect(peek(auto)).toMatchObject({ draftId: DRAFT_ID, judged: true });
		payloads = [];
		await runHook("stop", { last_assistant_message: decline }, [
			BINDING,
			AUTH,
			CREATED,
		]);
		expect(payloads[0]![1].metadata).not.toHaveProperty("priorDraft");
	});

	test("an auto reply re-entering as a prompt is never a user reply", () => {
		mkdirSync(join(config, "decision-capture"), { recursive: true });
		writeFileSync(
			state(),
			JSON.stringify({ requestId: REQUEST, version: 1, token: "t" }),
		);
		expect(
			claimReply(
				{
					prompt:
						'Tedix tedi Docs replied for the user (auto, reversible step; the user can override at any time): "yes"',
				},
				state(),
			),
		).toBeUndefined();
		expect(existsSync(state())).toBe(true);
	});

	test("the turn end records whether a draft was queued", async () => {
		const later = { ...TRIAGE_OK, urgency: "later", urgentLabels: [] };
		for (const [draft, status] of [
			[() => ({ status: "queued" }), "queued"],
			[() => ({ status: "ineligible" }), "none"],
		] as const) {
			await runHook(
				"stop",
				{ last_assistant_message: "Ship it?" },
				[BINDING, AUTH, CREATED],
				{
					gateway: {
						[TRIAGE_CALLABLE]: () => later,
						[REQUEST_DRAFT_CALLABLE]: draft,
					},
				},
			);
			expect(peek(draftStatusPath(state()))).toEqual({
				requestId: REQUEST,
				status,
			});
		}
		await runHook(
			"stop",
			{ last_assistant_message: "Blocked." },
			[BINDING, AUTH, CREATED],
			{ gateway: { [TRIAGE_CALLABLE]: () => TRIAGE_OK } },
		);
		expect(peek(draftStatusPath(state()))?.status).toBe("none");
	});

	test("a missing or failing detail read keeps the plain reply", async () => {
		for (const failure of [new Error("Unknown tool"), { unexpected: true }]) {
			await replyWith("ok", failure);
			const sent = payloads.at(-1)![1];
			expect(sent.body).toBe("ok");
			expect(sent.expectedRequestVersion).toBe(1);
			expect(sent.metadata).not.toHaveProperty("draftOutcome");
		}
	});

	test("a question already answered in Tedix OS is not answered again", async () => {
		const resolved = detail({
			effectiveState: "resolved",
			responses: {
				data: [
					nativeResponse({
						body: DRAFT_BODY,
						resolvesRequest: true,
						respondedByType: "user",
						respondedById: "U-fixture-user",
						metadata: { source: "os-inbox", draftId: DRAFT_ID },
					}),
				],
				nextCursor: null,
				hasMore: false,
			},
		});
		const calls = await replyWith("ok", resolved);
		expect(payloads).toEqual([]);
		expect(calls.some((args) => args.includes("interaction-respond"))).toBe(
			false,
		);
		expect(existsSync(state())).toBe(false);
	});

	test("a respond conflict after an OS answer is settled, not retried", async () => {
		await runHook("stop", { last_assistant_message: "Tidy the docs?" }, [
			BINDING,
			AUTH,
			CREATED,
		]);
		let reads = 0;
		await runHook("reply", { prompt: "do it" }, [BINDING, AUTH], {
			failRespond: true,
			gateway: {
				[DETAIL_CALLABLE]: () =>
					++reads === 1 ? detail() : detail({ effectiveState: "resolved" }),
			},
		});
		expect(reads).toBe(2);
		// Nothing is kept for a retry at the next turn end.
		expect(existsSync(state())).toBe(false);
		expect(existsSync(state().replace(/\.json$/, ".early"))).toBe(false);
	});
});
