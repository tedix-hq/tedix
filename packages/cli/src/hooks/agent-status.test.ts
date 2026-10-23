import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AUTO_CONTINUED_SUFFIX,
	applyTriagedStop,
	classifyStop,
	DETACHED,
	type DetachedOptions,
	harnessOf,
	pruneStatusFiles,
	recordAutoContinued,
	reportInput,
	runAgentStatus,
	STATUS_ENDED_AFTER_MS,
	type StatusDeps,
	SUPERVISOR_CONTINUED_SUFFIX,
	sessionName,
	sessionBinding,
	statusEnded,
	statusSettings,
	type TriageResult,
	transition,
	triagedOutcome,
} from "./agent-status";
import { runHooksCommand } from "./command";
import type { JsonObject } from "./hook-io";
import { changeAgentContext } from "../agent-context";
import { writeWorkspaceCredentials } from "../credential-store";

/** Checks for the opt-in turn-status reporter: consent, classification, silence and safe reporting. */
const SESSION = "11111111-1111-4111-8111-111111111111";

let base: string;
let spawned: Array<[string[], DetachedOptions]>;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "tedix-status-"));
	spawned = [];
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function enable(config: JsonObject = {}): void {
	writeFileSync(
		join(base, "agent-status.json"),
		JSON.stringify({ enabled: true, profile: "connect", ...config }),
	);
}

async function fire(
	event: string,
	fields: JsonObject = {},
	env: NodeJS.ProcessEnv = {},
	stdin?: string,
	captureOwnsStop = false,
	extra: Partial<StatusDeps> = {},
): Promise<void> {
	await runAgentStatus({
		binding: () => ({}),
		sessionName: () => undefined,
		captureOwnsStop: () => captureOwnsStop,
		env: { TEDIX_CONFIG_DIR: base, ...env },
		stdin:
			stdin ??
			JSON.stringify({
				session_id: SESSION,
				cwd: "/work/repo",
				hook_event_name: event,
				...fields,
			}),
		cwd: process.cwd(),
		platform: "darwin",
		which: (name) => `/usr/bin/${name}`,
		spawn: (args, options) => spawned.push([args, options]),
		label: () => "repo · main",
		...extra,
	});
}

function state(harness = "claude-code"): JsonObject | undefined {
	const path = join(base, "agent-status", `${harness}-${SESSION}.json`);
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}
const notifications = () =>
	spawned.filter(([args]) => args[0] === "terminal-notifier").map(([a]) => a);
const reports = () =>
	spawned.filter(([args]) => args[0] === "tedix").map(([a]) => a);

describe("tedix hooks status", () => {
	test("decision-capture opt-in supplies the member's own status scope by default", () => {
		const options = { configDir: base, cwd: process.cwd(), sessionId: SESSION };
		writeWorkspaceCredentials(
			"acme",
			{
				org: "org_acme",
				mcpUrl: "https://acme.example/mcp",
				loginId: "ada",
			},
			options,
		);
		changeAgentContext(
			"bind",
			{ workspace: "acme", projectId: "22222222-2222-4222-8222-222222222222" },
			options,
		);
		const env = { TEDIX_CONFIG_DIR: base };
		expect(statusSettings(env, options)).toBeUndefined();
		changeAgentContext("enable-decision-capture", {}, options);
		expect(statusSettings(env, options)).toEqual({
			profile: "acme",
			organization: "org_acme",
			notify: false,
		});
		expect(sessionBinding(options.cwd, SESSION, env).projectId).toBe(
			"22222222-2222-4222-8222-222222222222",
		);
		expect(
			statusSettings({ ...env, TEDIX_AGENT_STATUS: "0" }, options),
		).toBeUndefined();
		changeAgentContext("disable-decision-capture", {}, options);
		expect(statusSettings(env, options)).toBeUndefined();
	});
	test("disabled has no output or side effects", async () => {
		await fire("PermissionRequest", {
			tool_name: "Bash",
			tool_input: { command: "rm -rf build" },
		});
		expect(existsSync(join(base, "agent-status"))).toBe(false);
		expect(spawned).toEqual([]);
		enable();
		await fire("UserPromptSubmit", {}, { TEDIX_AGENT_STATUS: "0" });
		expect(existsSync(join(base, "agent-status"))).toBe(false);
	});

	test("environment opt-in without a profile skips the remote report", async () => {
		await fire(
			"PermissionRequest",
			{ tool_name: "Bash", tool_input: { command: "git push" } },
			{ TEDIX_AGENT_STATUS: "yes" },
		);
		expect(state()?.state).toBe("needs_you");
		expect(notifications()).toHaveLength(1);
		expect(reports()).toEqual([]);
		expect(statSync(join(base, "agent-status")).mode & 0o777).toBe(0o700);
	});

	test("stop classifier", () => {
		for (const [message, expected, summary] of [
			[
				"## Done\n\nFixed the **flaky** test in `api.ts`.\n\nAll checks pass.",
				"done",
				"Fixed the flaky test in api.ts.",
			],
			[
				"I updated the config.\n\nShould I also push it to main?",
				"needs_you",
				"Should I also push it to main?",
			],
			[
				"Implemented it.\n\nLet me know if the naming works.",
				"needs_you",
				"Let me know if the naming works.",
			],
			[
				"Two paths:\n\n```sh\nwhich option?\n```\n\nI chose the first; tests pass.",
				"done",
				"Two paths:",
			],
			[
				"Ready.\n\nWould you like me to deploy",
				"needs_you",
				"Would you like me to deploy",
			],
			["", "done", "Turn complete"],
			[null, "done", "Turn complete"],
		] as const)
			expect(classifyStop(message)).toEqual([expected, summary]);
		const [longState, longSummary] = classifyStop("x".repeat(500));
		expect([longState, longSummary.length]).toEqual(["done", 160]);
		expect(classifyStop("a\nb\n\nc")[1]).not.toContain("\n");
	});

	test("event mapping", () => {
		expect(
			transition({
				hook_event_name: "PermissionRequest",
				tool_name: "Bash",
				tool_input: { command: "git push origin main" },
			}),
		).toEqual([
			"needs_you",
			"A Claude Code session wants to run a shell command.",
		]);
		expect(
			transition({
				hook_event_name: "Notification",
				notification_type: "elicitation_dialog",
				message: "Pick a target",
			}),
		).toEqual(["needs_you", "Pick a target"]);
		expect(
			transition({
				hook_event_name: "Notification",
				notification_type: "idle_prompt",
				message: "Idle",
			}),
		).toBeUndefined();
		expect(
			transition({
				hook_event_name: "StopFailure",
				error: "rate_limit",
				error_details: "429 from provider",
			}),
		).toEqual(["error", "rate_limit: 429 from provider"]);
		expect(
			transition({
				hook_event_name: "Stop",
				stop_hook_active: true,
				last_assistant_message: "Done",
			}),
		).toBeUndefined();
		expect(
			transition({
				hook_event_name: "SubagentStop",
				last_assistant_message: "Should I?",
			}),
		).toBeUndefined();
		expect(
			transition({ hook_event_name: "SessionEnd", reason: "logout" })?.[0],
		).toBe("ended");
	});

	test("a supervisor-continued Stop is never classified as needs_you", async () => {
		const question = {
			hook_event_name: "Stop",
			last_assistant_message: "Should I push?",
		};
		expect(transition(question)?.[0]).toBe("needs_you");
		expect(transition(question, { supervisorContinued: true })?.[0]).toBe(
			"working",
		);
		enable();
		mkdirSync(join(base, "agent-status"), { recursive: true });
		const marker = join(
			base,
			"agent-status",
			`claude-code-${SESSION}${SUPERVISOR_CONTINUED_SUFFIX}`,
		);
		writeFileSync(marker, "");
		await fire("Stop", { last_assistant_message: "Should I push?" });
		expect(state()?.state).toBe("working");
		expect(notifications()).toEqual([]);
		expect(existsSync(marker)).toBe(false);
		await fire("Stop", { last_assistant_message: "Should I push?" });
		expect(state()?.state).toBe("needs_you");
	});

	test("change detection and notification only on transition", async () => {
		enable();
		await fire("UserPromptSubmit");
		await fire("UserPromptSubmit");
		expect(reports()).toHaveLength(1);
		await fire("PostToolUse", { tool_name: "Read" });
		expect(reports()).toHaveLength(1);
		await fire("PermissionRequest", {
			tool_name: "Bash",
			tool_input: { command: "git push" },
		});
		await fire("Notification", {
			notification_type: "permission_prompt",
			message: "Claude needs your permission to use Bash",
		});
		expect(state()?.state).toBe("needs_you");
		expect(notifications()).toHaveLength(1);
		expect(reports()).toHaveLength(3);
		await fire("PostToolUse", { tool_name: "Bash" });
		expect(state()?.state).toBe("working");
		await fire("Stop", { last_assistant_message: "Pushed." });
		await fire("Stop", { last_assistant_message: "Pushed." });
		expect(state()?.state).toBe("done");
		expect(reports()).toHaveLength(5);
		await fire("StopFailure", { error: "server_error" });
		expect(notifications()).toHaveLength(2);
		await fire("SessionEnd", { reason: "other" });
		expect(state()).toBeUndefined();
		expect(
			JSON.parse(reports().at(-1)![reports().at(-1)!.indexOf("--input") + 1]!)
				.state,
		).toBe("ended");
	});

	test("unchanged tool activity renews the remote heartbeat once a minute", async () => {
		enable();
		const now = new Date("2026-10-23T12:00:00Z");
		await fire("PostToolUse", {}, {}, undefined, false, { now: () => now });
		await fire("PostToolUse", {}, {}, undefined, false, {
			now: () => new Date(now.getTime() + 30_000),
		});
		expect(reports()).toHaveLength(1);
		await fire("PostToolUse", {}, {}, undefined, false, {
			now: () => new Date(now.getTime() + 60_000),
		});
		expect(reports()).toHaveLength(2);
		expect(notifications()).toEqual([]);
	});

	test("notify false suppresses notifications", async () => {
		enable({ notify: false });
		await fire("StopFailure", { error: "server_error" });
		expect(notifications()).toEqual([]);
		expect(reports()).toHaveLength(1);
	});

	test("the notification passes text as arguments", async () => {
		enable();
		const message = 'Run "x" \\ end tell; do shell script "id"';
		await fire("Notification", {
			notification_type: "permission_prompt",
			message,
		});
		const args = notifications()[0]!;
		expect(args.slice(0, 3)).toEqual([
			"terminal-notifier",
			"-message",
			message,
		]);
		expect(args.slice(-2)).toEqual(["-subtitle", "Needs you"]);
		expect(spawned[0]![1].detached).toBe(true);
	});

	test("permission summaries are plain sentences without tool JSON", async () => {
		enable();
		await fire(
			"PermissionRequest",
			{
				tool_name: "external_directory",
				tool_input: { filepath: "/private/files", nested: { secret: "value" } },
			},
			{ TEDIX_HOOK_HOST: "opencode" },
		);
		expect(state("opencode")?.summary).toBe(
			"An OpenCode session wants to read files outside its project.",
		);
		expect(notifications()[0]).toContain(state("opencode")!.summary);
		expect(notifications()[0]!.join(" ")).not.toContain("filepath");
		expect(notifications()[0]!.join(" ")).not.toContain("{");
	});

	test.each([
		{ TEDIX_LANE_ID: "lane-1" },
		{ TEDIX_LANE_LOG: "/tmp/lane.log" },
		{ CLAUDE_CODE_SESSION_ATTENDED: "0" },
		{ TEDIX_DEVIN_HEADLESS: "1" },
	])(
		"background permissions stay on the board without Needs you: %j",
		async (env) => {
			enable();
			await fire(
				"PermissionRequest",
				{
					tool_name: "external_directory",
					tool_input: { filepath: "/private/files" },
				},
				env,
			);
			expect(state()?.state).toBe("error");
			expect(state()?.summary).toContain("read files outside its project");
			expect(notifications()).toEqual([]);
			expect(reports()).toHaveLength(1);
		},
	);

	test("click opens the configured OS Work URL without a shell", async () => {
		enable({ osUrl: "https://acme.os.example" });
		const workItemId = "22222222-2222-4222-8222-222222222222";
		await fire(
			"PermissionRequest",
			{ tool_name: "Bash" },
			{},
			undefined,
			false,
			{ binding: () => ({ workItemId }) },
		);
		expect(notifications()[0]).toContain(
			`https://acme.os.example/work/items/${workItemId}`,
		);
		expect(notifications()[0]).toContain("-open");
		expect(spawned.some(([args]) => args[0] === "osascript")).toBe(false);
	});

	test("missing notifier or unsafe OS URL never falls back to Script Editor", async () => {
		enable({ osUrl: "javascript:alert(1)" });
		await fire("PermissionRequest", { tool_name: "Bash" });
		expect(notifications()[0]).not.toContain("-open");
		spawned = [];
		await fire("PostToolUse");
		await fire(
			"PermissionRequest",
			{ tool_name: "Bash" },
			{},
			undefined,
			false,
			{ which: () => undefined },
		);
		expect(notifications()).toEqual([]);
		expect(spawned.some(([args]) => args[0] === "osascript")).toBe(false);
	});

	test("a Codex exec transcript suppresses notifications without lane environment flags", async () => {
		enable();
		const transcript = join(base, "exec.jsonl");
		writeFileSync(
			transcript,
			JSON.stringify({ type: "session_meta", payload: { source: "exec" } }) +
				"\n",
		);
		await fire("PermissionRequest", {
			turn_id: "turn-1",
			transcript_path: transcript,
			tool_name: "Bash",
		});
		expect(state("codex")?.state).toBe("error");
		expect(notifications()).toEqual([]);
		expect(reports()).toHaveLength(1);
	});

	test("a host notification containing tool JSON is replaced with a plain sentence", async () => {
		enable();
		await fire("Notification", {
			notification_type: "permission_prompt",
			message: 'Approve external_directory: {"filepath":"/private/files"}',
		});
		expect(notifications()[0]![2]).toBe(
			"An agent session is waiting for your input.",
		);
		expect(notifications()[0]!.join(" ")).not.toContain("filepath");
	});

	test("the remote command selects the configured organization", async () => {
		enable({ organization: "org_example" });
		await fire("PermissionRequest", {
			tool_name: "Bash",
			tool_input: { command: "ls" },
		});
		expect(reports().at(-1)!.slice(0, 8)).toEqual([
			"tedix",
			"-w",
			"connect",
			"--organization",
			"org_example",
			"lane",
			"report",
			"--input",
		]);
	});

	test("the report uses the stored login, not an exported agent identity", async () => {
		enable();
		await fire(
			"Stop",
			{ last_assistant_message: "Shipped." },
			{
				CODEX_THREAD_ID: "thread",
				TEDIX_EXTERNAL_AGENT: "agent",
				TEDIX_AGENT_SESSION: "codex:thread",
				TEDIX_MCP_BEARER_TOKEN: "token",
				TEDIX_MCP_API_KEY: "key",
			},
		);
		const [args, options] = spawned.find(([a]) => a[0] === "tedix")!;
		// The host environment still labels the session.
		expect(JSON.parse(args.at(-1)!).harness).toBe("codex");
		expect(options).toMatchObject(DETACHED);
		expect(options.env).toEqual({
			TEDIX_CONFIG_DIR: base,
			CODEX_THREAD_ID: "thread",
		});
	});

	test("the remote command uses a safe JSON literal", async () => {
		enable();
		await fire("Stop", {
			last_assistant_message: 'Done: `"); evil(); ("`   café </script>',
		});
		const [args, options] = spawned.find(([a]) => a[0] === "tedix")!;
		expect(args.slice(0, 6)).toEqual([
			"tedix",
			"-w",
			"connect",
			"lane",
			"report",
			"--input",
		]);
		expect(args).toHaveLength(7);
		const literal = args[6]!;
		expect(/^[\x00-\x7f]*$/.test(literal)).toBe(true);
		const decoded = JSON.parse(literal);
		expect(new Set(Object.keys(decoded))).toEqual(
			new Set(["harness", "sessionKey", "state", "summary", "label"]),
		);
		expect(decoded.sessionKey).toBe(SESSION);
		expect(decoded).not.toHaveProperty("cwd");
		expect(decoded.summary).toContain("café");
		expect(options.detached).toBe(true);
		expect(options.stdin).toBe("ignore");
		expect(() =>
			reportInput({
				harness: "claude-code",
				sessionKey: "bad key",
				state: "done",
			}),
		).toThrow();
	});

	test("an invalid session or profile is ignored", async () => {
		enable({ profile: "Bad Profile" });
		await fire(
			"UserPromptSubmit",
			{},
			{},
			JSON.stringify({
				session_id: "../escape",
				hook_event_name: "UserPromptSubmit",
			}),
		);
		expect(existsSync(join(base, "agent-status"))).toBe(false);
		await fire("UserPromptSubmit");
		expect(reports()).toEqual([]);
	});

	test("harness detection", async () => {
		enable();
		await fire("Stop", {
			turn_id: "turn-1",
			model: "gpt-5",
			last_assistant_message: null,
		});
		expect(state("codex")?.state).toBe("done");
		expect(state("claude-code")).toBeUndefined();
		expect(harnessOf({}, {})).toBe("claude-code");
		expect(harnessOf({}, { CODEX_THREAD_ID: SESSION })).toBe("codex");
		// Codex SessionEnd has no turn_id; its transcript still tells.
		expect(
			harnessOf(
				{
					transcript_path: `/h/.codex/sessions/rollout-2026-x-${SESSION}.jsonl`,
				},
				{},
			),
		).toBe("codex");
		expect(harnessOf({ transcript_path: null }, {})).toBe("codex");
		expect(
			harnessOf(
				{ transcript_path: `/h/.claude/projects/p/${SESSION}.jsonl` },
				{},
			),
		).toBe("claude-code");
	});

	test("a Codex SessionEnd ends the Codex session", async () => {
		enable();
		const transcript = join(base, `rollout-2026-x-${SESSION}.jsonl`);
		await fire("UserPromptSubmit", {
			turn_id: "turn-1",
			transcript_path: transcript,
		});
		expect(state("codex")?.state).toBe("working");
		await fire("SessionEnd", { transcript_path: transcript, reason: "other" });
		expect(state("codex")).toBeUndefined();
		expect(state("claude-code")).toBeUndefined();
		expect(
			reports().map(
				(report) => JSON.parse(report[report.indexOf("--input") + 1]!).state,
			),
		).toEqual(["working", "ended"]);
		expect(
			JSON.parse(reports().at(-1)![reports().at(-1)!.indexOf("--input") + 1]!)
				.harness,
		).toBe("codex");
	});

	test("an unsaved Codex side thread is not a session", async () => {
		enable();
		// A suggestion fork names no transcript, or its parent's rollout.
		const parent = "/h/.codex/sessions/rollout-2026-x-01a0eee2-parent.jsonl";
		for (const transcript_path of [null, parent])
			for (const name of ["UserPromptSubmit", "Stop", "SessionEnd"])
				await fire(name, {
					...(name === "SessionEnd" ? {} : { turn_id: "turn-1" }),
					transcript_path,
					last_assistant_message: '{"suggestion":"Carry on"}',
				});
		expect(state("codex")).toBeUndefined();
		expect(state("claude-code")).toBeUndefined();
		expect(reports()).toEqual([]);
	});

	test("the hook command swallows failures silently", async () => {
		enable();
		const previous = process.env.TEDIX_CONFIG_DIR;
		process.env.TEDIX_CONFIG_DIR = base;
		const out: string[] = [];
		const log = console.log;
		const error = console.error;
		console.log = (...args: unknown[]) => out.push(args.join(" "));
		console.error = (...args: unknown[]) => out.push(args.join(" "));
		const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
		Object.defineProperty(process, "stdin", {
			value: (async function* () {
				yield Buffer.from("{not json");
			})(),
			configurable: true,
		});
		try {
			expect(await runHooksCommand(["status"])).toBe(0);
		} finally {
			Object.defineProperty(process, "stdin", stdin);
			console.log = log;
			console.error = error;
			if (previous === undefined) delete process.env.TEDIX_CONFIG_DIR;
			else process.env.TEDIX_CONFIG_DIR = previous;
		}
		expect(out).toEqual([]);
	});

	test("Stop is skipped when decision capture owns it", async () => {
		enable();
		await fire(
			"Stop",
			{ last_assistant_message: "Should I push?" },
			{},
			undefined,
			true,
		);
		expect(state()).toBeUndefined();
		expect(spawned).toEqual([]);
		// Only Stop moves to capture; every other event still reports here.
		await fire("UserPromptSubmit", {}, {}, undefined, true);
		expect(state()?.state).toBe("working");
	});

	test("triaged Stop outcomes", () => {
		const ok = (urgency: "now" | "later", urgentLabels: string[] = []) =>
			({
				status: "ok",
				urgency,
				labels: {},
				urgentLabels,
				model: "m",
				policyVersion: 1,
				latencyMs: 1,
			}) satisfies TriageResult;
		const message = "## Deploy halted\n\nThe migration failed on D1.";
		expect(triagedOutcome(message, ok("now", ["blocker_or_failure"]))).toEqual([
			"needs_you",
			"Blocker: The migration failed on D1.",
		]);
		expect(
			triagedOutcome(message, ok("now", ["needs_login_or_consent"])),
		).toEqual([
			"needs_you",
			"Needs you (login/consent): The migration failed on D1.",
		]);
		expect(triagedOutcome(message, ok("now", ["risky_action"]))).toEqual([
			"needs_you",
			"Risky (deploy/delete): The migration failed on D1.",
		]);
		expect(triagedOutcome("Done.\n\nShould I push?", ok("now"))).toEqual([
			"needs_you",
			"Needs you: Should I push?",
		]);
		// Later never notifies, even when the regex would have asked.
		expect(triagedOutcome("Done.\n\nShould I push?", ok("later"))).toEqual([
			"done",
			"Done.",
		]);
		expect(triagedOutcome("Done.\n\nShould I push?", undefined)).toEqual(
			classifyStop("Done.\n\nShould I push?"),
		);
		expect(
			triagedOutcome("Should I push?", { ...ok("now"), status: "unavailable" }),
		).toEqual(["done", "Turn ended; triage unavailable"]);
	});

	test("a triaged Stop keeps the supervisor seam and notifies once", async () => {
		enable();
		const deps = {
			env: { TEDIX_CONFIG_DIR: base },
			stdin: "",
			cwd: process.cwd(),
			platform: "darwin" as const,
			which: (name: string) => `/usr/bin/${name}`,
			spawn: (args: string[], options: DetachedOptions) =>
				spawned.push([args, options]),
			label: () => "repo · main",
			binding: () => ({}),
			sessionName: () => undefined,
		};
		const event = {
			session_id: SESSION,
			hook_event_name: "Stop",
			last_assistant_message: "Should I push?",
		};
		mkdirSync(join(base, "agent-status"), { recursive: true });
		const marker = join(
			base,
			"agent-status",
			`claude-code-${SESSION}${SUPERVISOR_CONTINUED_SUFFIX}`,
		);
		writeFileSync(marker, "");
		await applyTriagedStop(deps, event, undefined);
		expect(state()?.state).toBe("working");
		expect(existsSync(marker)).toBe(false);
		await applyTriagedStop(deps, event, undefined);
		await applyTriagedStop(deps, event, undefined);
		expect(state()?.state).toBe("needs_you");
		expect(notifications()).toHaveLength(1);
		await applyTriagedStop(
			deps,
			{ ...event, stop_hook_active: true },
			undefined,
		);
		expect(reports()).toHaveLength(2);
	});

	test("an auto reply marks working now and the continued Stop is still classified", async () => {
		enable();
		const deps = {
			env: { TEDIX_CONFIG_DIR: base },
			stdin: "",
			cwd: process.cwd(),
			platform: "darwin" as const,
			which: (name: string) => `/usr/bin/${name}`,
			spawn: (args: string[], options: DetachedOptions) =>
				spawned.push([args, options]),
			label: () => "repo · main",
			binding: () => ({}),
			sessionName: () => undefined,
		};
		const event = {
			session_id: SESSION,
			turn_id: "turn-1",
			hook_event_name: "Stop",
			last_assistant_message: "Tests pass. Should I push?",
		};
		recordAutoContinued(deps, event);
		expect(state("codex")).toMatchObject({
			state: "working",
			summary: "Continued by Tedix auto reply",
		});
		expect(notifications()).toHaveLength(0);
		const marker = join(
			base,
			"agent-status",
			`codex-${SESSION}${AUTO_CONTINUED_SUFFIX}`,
		);
		expect(existsSync(marker)).toBe(true);
		// Codex flags the Stop after a continuation; it still settles the status.
		const urgent: TriageResult = {
			status: "ok",
			urgency: "now",
			labels: {},
			urgentLabels: ["blocker"],
			model: "m",
			policyVersion: 1,
			latencyMs: 1,
		};
		await applyTriagedStop(deps, { ...event, stop_hook_active: true }, urgent);
		expect(state("codex")?.state).toBe("needs_you");
		expect(notifications()).toHaveLength(1);
		expect(existsSync(marker)).toBe(false);
		// Without the marker a flagged Stop is skipped, as before.
		await applyTriagedStop(
			deps,
			{ ...event, stop_hook_active: true, last_assistant_message: "Done." },
			undefined,
		);
		expect(state("codex")?.state).toBe("needs_you");
	});
});

describe("session name and binding", () => {
	const PROJECT = "22222222-2222-4222-8222-222222222222";
	const WORK_ITEM = "33333333-3333-4333-8333-333333333333";
	const lastReport = () =>
		JSON.parse(reports().at(-1)![reports().at(-1)!.indexOf("--input") + 1]!);

	test("a bound session reports its project and Work item", async () => {
		enable();
		const bound = {
			binding: () => ({ projectId: PROJECT, workItemId: WORK_ITEM }),
		};
		await fire("UserPromptSubmit", {}, {}, undefined, false, bound);
		expect(lastReport()).toMatchObject({
			projectId: PROJECT,
			workItemId: WORK_ITEM,
		});
		expect(state()).toMatchObject({
			projectId: PROJECT,
			workItemId: WORK_ITEM,
		});
		// The same state again is not reported; a new binding is.
		await fire("UserPromptSubmit", {}, {}, undefined, false, bound);
		expect(reports()).toHaveLength(1);
		await fire("UserPromptSubmit", {}, {}, undefined, false, {
			binding: () => ({ projectId: PROJECT, workItemId: "not-a-uuid" }),
		});
		expect(reports()).toHaveLength(2);
		expect(lastReport()).toEqual(
			expect.not.objectContaining({ workItemId: expect.anything() }),
		);
		expect(lastReport().projectId).toBe(PROJECT);
	});

	test("an unbound session reports no binding fields", async () => {
		enable();
		await fire("UserPromptSubmit");
		const report = lastReport();
		expect(report).not.toHaveProperty("projectId");
		expect(report).not.toHaveProperty("workItemId");
		expect(report.label).toBe("repo · main");
	});

	test("a session name replaces the folder label and a rename is reported", async () => {
		enable();
		await fire("UserPromptSubmit", {}, {}, undefined, false, {
			sessionName: () => "Billing cleanup",
		});
		expect(lastReport().label).toBe("Billing cleanup");
		await fire("UserPromptSubmit", {}, {}, undefined, false, {
			sessionName: () => "Billing cleanup",
		});
		expect(reports()).toHaveLength(1);
		await fire("UserPromptSubmit", {}, {}, undefined, false, {
			sessionName: () => "Invoice export",
		});
		expect(reports()).toHaveLength(2);
		expect(lastReport().label).toBe("Invoice export");
	});

	test("the Claude Code name is the last custom title in the transcript", () => {
		const transcript = join(base, "transcript.jsonl");
		const filler = JSON.stringify({ type: "user", text: "x".repeat(1000) });
		writeFileSync(
			transcript,
			[
				JSON.stringify({ type: "custom-title", customTitle: "Too old" }),
				...Array.from({ length: 600 }, () => filler),
				JSON.stringify({ type: "custom-title", customTitle: "First name" }),
				filler,
				JSON.stringify({
					type: "custom-title",
					customTitle: "Renamed",
					sessionId: SESSION,
				}),
				filler,
				"",
			].join("\n"),
		);
		const event = { session_id: SESSION, transcript_path: transcript };
		expect(sessionName(event, "claude-code", {})).toBe("Renamed");
		writeFileSync(transcript, [filler, filler].join("\n"));
		expect(sessionName(event, "claude-code", {})).toBeUndefined();
		expect(
			sessionName({ session_id: SESSION }, "claude-code", {}),
		).toBeUndefined();
		// Only the last 512 KB is read.
		writeFileSync(
			transcript,
			[
				JSON.stringify({ type: "custom-title", customTitle: "Too old" }),
				...Array.from({ length: 600 }, () => filler),
			].join("\n"),
		);
		expect(sessionName(event, "claude-code", {})).toBeUndefined();
	});

	test("the Codex name is the last thread name for the session in the index", () => {
		const home = join(base, "codex");
		mkdirSync(home);
		const other = "44444444-4444-4444-8444-444444444444";
		writeFileSync(
			join(home, "session_index.jsonl"),
			[
				{ id: SESSION, thread_name: "Old name", updated_at: "2026-01-01" },
				{ id: SESSION, thread_name: "Release notes", updated_at: "2026-01-02" },
				{ id: other, thread_name: "Someone else", updated_at: "2026-01-03" },
			]
				.map((row) => JSON.stringify(row))
				.join("\n"),
		);
		const env = { CODEX_HOME: home };
		expect(sessionName({ session_id: SESSION }, "codex", env)).toBe(
			"Release notes",
		);
		expect(
			sessionName(
				{ session_id: "55555555-5555-4555-8555-555555555555" },
				"codex",
				env,
			),
		).toBeUndefined();
		expect(
			sessionName({ session_id: SESSION }, "codex", {
				CODEX_HOME: join(base, "missing"),
			}),
		).toBeUndefined();
	});
});

describe("stale session status", () => {
	const NOW = Date.parse("2026-10-09T12:00:00Z");
	const at = (hoursAgo: number) =>
		new Date(NOW - hoursAgo * 3_600_000).toISOString();

	test("a session silent for 12 hours has ended", () => {
		expect(statusEnded({ state: "working", updatedAt: at(1) }, NOW)).toBe(
			false,
		);
		expect(statusEnded({ state: "done", updatedAt: at(11.9) }, NOW)).toBe(
			false,
		);
		expect(statusEnded({ state: "needs_you", updatedAt: at(13) }, NOW)).toBe(
			true,
		);
		expect(statusEnded({ state: "ended", updatedAt: at(0) }, NOW)).toBe(true);
		expect(statusEnded({ state: "working" }, NOW)).toBe(true);
		expect(STATUS_ENDED_AFTER_MS).toBe(12 * 3_600_000);
	});

	test("prunes session files older than 7 days and keeps the rest", () => {
		const directory = join(base, "agent-status");
		mkdirSync(directory, { recursive: true });
		const file = (name: string, daysAgo: number) => {
			const path = join(directory, name);
			writeFileSync(path, "{}");
			const time = (NOW - daysAgo * 86_400_000) / 1000;
			utimesSync(path, time, time);
			return path;
		};
		const old = file(`claude-code-${SESSION}.json`, 8);
		const marker = file(`codex-${SESSION}${AUTO_CONTINUED_SUFFIX}`, 9);
		const fresh = file("codex-22222222-2222-4222-8222-222222222222.json", 6);
		const log = file("report.log", 30);
		expect(pruneStatusFiles({ TEDIX_CONFIG_DIR: base }, NOW)).toBe(2);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(log)).toBe(true);
	});
});

test("OpenCode status uses the same opt-in and emits a valid report", async () => {
	const session = "ses_ea08bec38ffeGv2rruD2pzxAuC";
	const raw = JSON.stringify({
		session_id: session.toLowerCase(),
		hook_event_name: "PermissionRequest",
		tool_name: "bash",
		tool_input: { command: "bun run test:run" },
	});
	await fire("PermissionRequest", {}, { TEDIX_HOOK_HOST: "opencode" }, raw);
	expect(spawned).toEqual([]);
	enable();
	await fire("PermissionRequest", {}, { TEDIX_HOOK_HOST: "opencode" }, raw);
	const reports = spawned.filter(([args]) => args[0] === "tedix");
	expect(reports).toHaveLength(1);
	expect(JSON.parse(reports[0]![0][6]!)).toMatchObject({
		harness: "opencode",
		sessionKey: session.toLowerCase(),
		state: "needs_you",
	});
});
