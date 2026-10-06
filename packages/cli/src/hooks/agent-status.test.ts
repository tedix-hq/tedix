import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyStop,
	DETACHED,
	harnessOf,
	REPORT_CALLABLE,
	reportSource,
	runAgentStatus,
	SUPERVISOR_CONTINUED_SUFFIX,
	transition,
} from "./agent-status";
import { runHooksCommand } from "./command";
import type { JsonObject } from "./hook-io";

/** Checks for the opt-in turn-status reporter: consent, classification, silence and safe reporting. */
const SESSION = "11111111-1111-4111-8111-111111111111";

let base: string;
let spawned: Array<[string[], typeof DETACHED]>;

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
	env: Record<string, string> = {},
	stdin?: string,
): Promise<void> {
	await runAgentStatus({
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
	});
}

function state(harness = "claude-code"): JsonObject | undefined {
	const path = join(base, "agent-status", `${harness}-${SESSION}.json`);
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}
const notifications = () =>
	spawned.filter(([args]) => args[0] === "osascript").map(([a]) => a);
const reports = () =>
	spawned.filter(([args]) => args[0] === "tedix").map(([a]) => a);
const PREFIX = `async () => await ${REPORT_CALLABLE}(`;

describe("tedix hooks status", () => {
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
		).toEqual(["needs_you", "Approve Bash: git push origin main"]);
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
		const last = reports().at(-1)![4]!;
		expect(JSON.parse(last.slice(PREFIX.length, -1)).state).toBe("ended");
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
		expect(
			args.slice(0, 7).every((part) => !part.includes("do shell script")),
		).toBe(true);
		expect(args.slice(-3)).toEqual([
			message,
			"Tedix · repo · main",
			"Needs you",
		]);
		expect(spawned[0]![1].detached).toBe(true);
	});

	test("the remote command selects the configured organization", async () => {
		enable({ organization: "org_example" });
		await fire("PermissionRequest", {
			tool_name: "Bash",
			tool_input: { command: "ls" },
		});
		expect(reports().at(-1)!.slice(0, 6)).toEqual([
			"tedix",
			"-w",
			"connect",
			"--organization",
			"org_example",
			"code",
		]);
	});

	test("the remote command uses a safe JSON literal", async () => {
		enable();
		await fire("Stop", {
			last_assistant_message: 'Done: `"); evil(); ("`   café </script>',
		});
		const [args, options] = spawned.find(([a]) => a[0] === "tedix")!;
		expect(args.slice(0, 4)).toEqual(["tedix", "-w", "connect", "code"]);
		const source = args[4]!;
		expect(source.startsWith(PREFIX) && source.endsWith(")")).toBe(true);
		const literal = source.slice(PREFIX.length, -1);
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
			reportSource({
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
});
