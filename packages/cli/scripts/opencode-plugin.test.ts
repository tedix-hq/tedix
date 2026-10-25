import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readlinkSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	TEDIX_OPENCODE_OAUTH_CLIENT_ID,
	TEDIX_OPENCODE_OAUTH_REDIRECT_URI,
} from "@tedix/auth/oauth-client-registration";
import * as module from "../../../plugins/tedix/.opencode-plugin/index.js";
import { ROOT } from "./package-plugin";

const SESSION = "ses_ea08bec38ffeGv2rruD2pzxAuC";
const CHILD = "ses_ea08bec38fffAbCdEfGhIjKlMn";
const OTHER_SESSION = "ses_ea08bec38fffMnOpQrStUvWxYz";
let directory: string;
let path: string | undefined;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "tedix-opencode-plugin-"));
	path = process.env.PATH;
});
afterEach(() => {
	process.env.PATH = path;
	rmSync(directory, { recursive: true, force: true });
});

/** A fake `tedix` that logs each call and prints a context for it. */
function fakeCli(script = "") {
	const bin = join(directory, "bin");
	const stub = join(bin, "tedix");
	mkdirSync(bin);
	writeFileSync(
		stub,
		`#!/bin/sh
input=$(cat)
printf '%s\\t%s\\n' "$*" "$input" >> "${join(directory, "calls")}"
${script}
printf '{"hookSpecificOutput":{"additionalContext":"context from %s"}}\\n' "$2"
`,
	);
	chmodSync(stub, 0o700);
	process.env.PATH = `${bin}:/usr/bin:/bin`;
}

const calls = () =>
	readFileSync(join(directory, "calls"), "utf8")
		.trim()
		.split("\n")
		.map((line) => {
			const [args, input] = line.split("\t");
			return { args, event: JSON.parse(input!) };
		});

const plugin = (options?: Record<string, unknown>) =>
	module.default.server({ directory } as never, options);

const message = (sessionID = SESSION) => ({
	message: { id: "msg_1" },
	parts: [{ type: "text", text: "Find the Work for this task", id: "prt_1" }],
	sessionID,
});

test("one default export serves OpenCode 1 server() and OpenCode 2 setup()", () => {
	expect(Object.keys(module)).toEqual(["default"]);
	expect(module.default.id).toBe("tedix");
	expect(typeof module.default.server).toBe("function");
	expect(typeof module.default.setup).toBe("function");
	// OpenCode 1 configurations written before the directory entry name tedix.js.
	expect(readlinkSync(join(ROOT, ".opencode-plugin", "tedix.js"))).toBe(
		"index.js",
	);
});

test("adds the Tedix MCP connection with its CIMD client and the shared skills", async () => {
	const hooks = await plugin();
	const config: Record<string, any> = { skills: { paths: ["/other"] } };
	await hooks.config!(config as never);
	const mcp = JSON.parse(readFileSync(join(ROOT, "mcp.json"), "utf8"));
	expect(config.mcp.tedix).toEqual({
		type: "remote",
		url: mcp.mcpServers.tedix.url,
		oauth: { clientId: TEDIX_OPENCODE_OAUTH_CLIENT_ID },
	});
	expect(config.skills.paths).toEqual(["/other", join(ROOT, "skills")]);
	await hooks.config!(config as never);
	expect(config.skills.paths).toHaveLength(2);

	const own = {
		mcp: { tedix: { type: "remote", url: "https://example.test" } },
	};
	await hooks.config!(own as never);
	expect(own.mcp.tedix).toEqual({
		type: "remote",
		url: "https://example.test",
	});
	const none: Record<string, any> = {};
	await (
		await plugin({ mcp: false })
	).config!(none as never);
	expect(none.mcp).toBeUndefined();
	expect(none.skills.paths).toEqual([join(ROOT, "skills")]);
});

test("shell commands carry the root session's Agent-Session, version and model", async () => {
	const hooks = await plugin({ hooks: false });
	await hooks.event!({
		event: {
			type: "session.created",
			properties: { info: { id: SESSION, version: "1.19.3" } },
		},
	} as never);
	await hooks.event!({
		event: {
			type: "session.created",
			properties: { info: { id: CHILD, parentID: SESSION, version: "1.19.3" } },
		},
	} as never);
	await hooks["chat.message"]!(
		{
			sessionID: SESSION,
			model: { providerID: "azure", modelID: "gpt-example" },
		} as never,
		message() as never,
	);
	const output = { env: {} as Record<string, string> };
	await hooks["shell.env"]!({ cwd: directory, sessionID: CHILD }, output);
	expect(output.env).toEqual({
		TEDIX_AGENT_SESSION: `opencode:${SESSION}`,
		OPENCODE_SESSION_ID: SESSION,
		TEDIX_AGENT_HARNESS_VERSION: "1.19.3",
		TEDIX_AGENT_MODEL_PROVIDER: "azure",
		TEDIX_AGENT_MODEL_ID: "gpt-example",
	});
	expect(hooks["tool.execute.before"]).toBeUndefined();
});

test("the first prompt gets session-start and prompt context as one synthetic part", async () => {
	fakeCli();
	const hooks = await plugin();
	await hooks.event!({
		event: { type: "session.created", properties: { info: { id: SESSION } } },
	} as never);
	const first = message();
	await hooks["chat.message"]!({ sessionID: SESSION } as never, first as never);
	expect(first.parts).toHaveLength(2);
	expect(first.parts[1]).toMatchObject({
		sessionID: SESSION,
		messageID: "msg_1",
		type: "text",
		synthetic: true,
		text: "<tedix-context>\ncontext from session-start\n\ncontext from prompt-context\n</tedix-context>",
	});
	expect(first.parts[1]!.id).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	const second = message();
	await hooks["chat.message"]!(
		{ sessionID: SESSION } as never,
		second as never,
	);
	expect(second.parts[1]!.text).not.toContain("session-start");
	expect(
		calls().filter(
			(call) =>
				["SessionStart", "UserPromptSubmit"].includes(
					call.event.hook_event_name,
				) &&
				!call.args?.includes("capture-reply") &&
				!call.args?.includes("status"),
		),
	).toEqual([
		{
			args: "hooks session-start --host opencode",
			event: {
				session_id: SESSION,
				cwd: directory,
				hook_event_name: "SessionStart",
				source: "startup",
			},
		},
		{
			args: "hooks prompt-context --host opencode",
			event: {
				session_id: SESSION,
				cwd: directory,
				hook_event_name: "UserPromptSubmit",
				prompt: "Find the Work for this task",
			},
		},
		{
			args: "hooks prompt-context --host opencode",
			event: expect.objectContaining({ hook_event_name: "UserPromptSubmit" }),
		},
	]);
});

test("subagent prompts, an absent CLI and a failing CLI add nothing", async () => {
	process.env.PATH = "/nonexistent";
	const hooks = await plugin();
	const absent = message();
	await hooks["chat.message"]!(
		{ sessionID: SESSION } as never,
		absent as never,
	);
	expect(absent.parts).toHaveLength(1);

	fakeCli("exit 1");
	const failing = message();
	await hooks["chat.message"]!(
		{ sessionID: SESSION } as never,
		failing as never,
	);
	expect(failing.parts).toHaveLength(1);

	await hooks.event!({
		event: {
			type: "session.created",
			properties: { info: { id: CHILD, parentID: SESSION } },
		},
	} as never);
	const child = message(CHILD);
	await hooks["chat.message"]!({ sessionID: CHILD } as never, child as never);
	expect(child.parts).toHaveLength(1);
	expect(calls().every((call) => call.event.session_id === SESSION)).toBe(true);
});

test("edits and commands get advisory recall appended to their result", async () => {
	fakeCli();
	const hooks = await plugin();
	const call = { tool: "edit", sessionID: SESSION, callID: "call_1" };
	await hooks["tool.execute.before"]!(call, {
		args: { filePath: "/repo/a.ts", oldString: "a", newString: "b" },
	});
	await hooks["tool.execute.before"]!(
		{ tool: "read", sessionID: SESSION, callID: "call_2" },
		{ args: { filePath: "/repo/a.ts" } },
	);
	const result = { title: "", output: "Edit applied.", metadata: {} };
	await hooks["tool.execute.after"]!({ ...call, args: {} }, result);
	expect(result.output).toBe(
		"Edit applied.\n\n<tedix-recall>\ncontext from situational-recall\n</tedix-recall>",
	);
	const [recall, ...rest] = calls();
	expect(rest.map((call) => call.event.hook_event_name)).toEqual([
		"PostToolUse",
	]);
	expect(recall).toEqual({
		args: "hooks situational-recall --host opencode",
		event: {
			session_id: SESSION,
			cwd: directory,
			hook_event_name: "PreToolUse",
			tool_name: "Edit",
			tool_input: {
				filePath: "/repo/a.ts",
				file_path: "/repo/a.ts",
				oldString: "a",
				newString: "b",
			},
		},
	});
});

async function until(check: () => boolean) {
	for (let i = 0; i < 200; i++) {
		if (check()) return;
		await Bun.sleep(10);
	}
	throw new Error("OpenCode hook did not finish");
}

const emit = (
	hooks: Awaited<ReturnType<typeof plugin>>,
	type: string,
	properties = {},
) => hooks.event!({ event: { type, properties } } as never);

function sessionClient(wakes: unknown[]) {
	return {
		session: {
			messages: async () => ({
				data: [
					{
						info: { role: "user", id: "msg_user" },
						parts: [{ type: "text", text: "Check it" }],
					},
					{
						info: { role: "assistant", id: "msg_first" },
						parts: [{ type: "text", text: "Checked the example." }],
					},
					{
						info: { role: "assistant", id: "msg_last" },
						parts: [{ type: "text", text: "Should I continue?" }],
					},
				],
			}),
			promptAsync: async (input: unknown) => {
				wakes.push(input);
			},
		},
	};
}

test("idle captures the whole turn and wakes once with the CLI's framed reply", async () => {
	fakeCli(
		'if [ "$2" = "await-reply" ]; then printf "The user replied in Tedix OS: continue" >&2; exit 2; fi',
	);
	const wakes: unknown[] = [];
	const hooks = await module.default.server({
		directory,
		client: sessionClient(wakes),
	});
	await emit(hooks, "session.idle", { sessionID: SESSION });
	await until(() => wakes.length === 1);
	expect(wakes[0]).toEqual({
		path: { id: SESSION },
		body: {
			parts: [
				{
					type: "text",
					text: "The user replied in Tedix OS: continue",
					synthetic: true,
				},
			],
		},
	});
	const capture = calls().find((call) => call.args?.includes("capture-stop"));
	expect(capture?.event).toEqual({
		session_id: SESSION,
		cwd: directory,
		hook_event_name: "Stop",
		turn_id: "msg_last",
		last_assistant_message: "Should I continue?",
		opencode_turn_text: "Checked the example.\n\nShould I continue?",
	});
	await emit(hooks, "session.idle", { sessionID: SESSION });
	await Bun.sleep(30);
	expect(wakes).toHaveLength(1);
	expect(
		calls().filter((call) => call.args?.includes("capture-stop")),
	).toHaveLength(1);
});

test("permission, tool, error and deletion events report status without approving permissions", async () => {
	fakeCli();
	const hooks = await plugin();
	await emit(hooks, "permission.asked", {
		sessionID: SESSION,
		permission: "bash",
		metadata: { command: "bun run test:run" },
	});
	await emit(hooks, "permission.replied", { sessionID: SESSION });
	await emit(hooks, "session.error", {
		sessionID: SESSION,
		error: { name: "ExampleError", data: { message: "Failed" } },
	});
	await emit(hooks, "session.deleted", { info: { id: SESSION } });
	expect(calls().map((call) => call.event.hook_event_name)).toEqual([
		"PermissionRequest",
		"PostToolUse",
		"StopFailure",
		"SessionEnd",
	]);
	expect(calls()[0]?.event).toMatchObject({
		tool_name: "bash",
		tool_input: { command: "bun run test:run" },
	});
	expect(
		calls().every((call) => call.args === "hooks status --host opencode"),
	).toBe(true);
});

test("user prompts capture replies and status; synthetic wakes are never captured as user replies", async () => {
	fakeCli();
	const hooks = await plugin();
	await hooks["chat.message"]!(
		{ sessionID: SESSION } as never,
		message() as never,
	);
	expect(
		calls().filter((call) => call.args?.includes("capture-reply")),
	).toHaveLength(1);
	expect(
		calls().find((call) => call.args?.includes("status"))?.event
			.hook_event_name,
	).toBe("UserPromptSubmit");
	const synthetic = message();
	Object.assign(synthetic.parts[0]!, { synthetic: true });
	await hooks["chat.message"]!(
		{ sessionID: SESSION } as never,
		synthetic as never,
	);
	expect(
		calls().filter((call) => call.args?.includes("capture-reply")),
	).toHaveLength(1);
});

test("new prompts and deletion cancel a pending wake", async () => {
	fakeCli(
		'if [ "$2" = "await-reply" ]; then sleep 0.1; printf "stale reply" >&2; exit 2; fi',
	);
	for (const cancel of ["prompt", "delete"]) {
		const wakes: unknown[] = [];
		const hooks = await module.default.server({
			directory,
			client: sessionClient(wakes),
		});
		const before = callsSafeCount();
		await emit(hooks, "session.idle", { sessionID: SESSION });
		await until(
			() =>
				callsSafeCount() > before &&
				calls()
					.slice(before)
					.some((call) => call.args?.includes("await-reply")),
		);
		if (cancel === "prompt")
			await hooks["chat.message"]!(
				{ sessionID: SESSION } as never,
				message() as never,
			);
		else await emit(hooks, "session.deleted", { info: { id: SESSION } });
		await Bun.sleep(300);
		expect(wakes).toEqual([]);
	}
});

function callsSafeCount() {
	try {
		return calls().length;
	} catch {
		return 0;
	}
}

test("disabled hooks and subagent events cannot capture, report or wake", async () => {
	fakeCli();
	const wakes: unknown[] = [];
	const hooks = await module.default.server(
		{ directory, client: sessionClient(wakes) },
		{ hooks: false },
	);
	await emit(hooks, "session.idle", { sessionID: SESSION });
	await emit(hooks, "permission.asked", { sessionID: SESSION });
	const enabled = await module.default.server({
		directory,
		client: sessionClient(wakes),
	});
	await emit(enabled, "session.created", {
		info: { id: CHILD, parentID: SESSION },
	});
	await emit(enabled, "session.idle", { sessionID: CHILD });
	await emit(enabled, "permission.asked", { sessionID: CHILD });
	await Bun.sleep(20);
	expect(callsSafeCount()).toBe(0);
	expect(wakes).toEqual([]);
});

test("older permission.updated events report the same approval status", async () => {
	fakeCli();
	const hooks = await plugin();
	await emit(hooks, "permission.updated", {
		sessionID: SESSION,
		type: "bash",
		metadata: { command: "bun run test:run" },
	});
	expect(calls()[0]?.event).toMatchObject({
		hook_event_name: "PermissionRequest",
		tool_name: "bash",
		tool_input: { command: "bun run test:run" },
	});
});

test("idle does not resume for a silent or failed await-reply hook", async () => {
	fakeCli(
		'if [ "$2" = "await-reply" ]; then printf "not a wake" >&2; exit 1; fi',
	);
	const wakes: unknown[] = [];
	const hooks = await module.default.server({
		directory,
		client: sessionClient(wakes),
	});
	await emit(hooks, "session.idle", { sessionID: SESSION });
	await until(
		() =>
			callsSafeCount() > 0 &&
			calls().some((call) => call.args?.includes("await-reply")),
	);
	await Bun.sleep(30);
	expect(wakes).toEqual([]);
});

/** A fake OpenCode 2 plugin context that records registrations and replays events. */
function context2(
	options: Record<string, unknown> = {},
	messages: unknown[] = [],
	sessions: Record<string, unknown> = {},
) {
	const hooks: Record<string, (event: any) => unknown> = {};
	const mcp = new Map<string, unknown>();
	const skills = new Map<string, any>();
	const synthetic: unknown[] = [];
	const pending: unknown[] = [];
	let notify: (() => void) | undefined;
	const hook =
		(domain: string) =>
		async (name: string, callback: (event: any) => unknown) => {
			hooks[`${domain}.${name}`] = callback;
		};
	const ctx = {
		app: { version: "2.1.2" },
		location: { directory },
		options,
		mcp: {
			transform: async (edit: (editor: unknown) => void) =>
				edit({
					get: (name: string) => mcp.get(name),
					set: (name: string, config: unknown) => mcp.set(name, config),
				}),
		},
		skill: {
			transform: async (edit: (editor: unknown) => void) =>
				edit({
					get: (id: string) => skills.get(id),
					add: (skill: any) => skills.set(skill.id, skill),
				}),
		},
		session: {
			hook: hook("session"),
			get: async ({ sessionID }: { sessionID: string }) => {
				if (!sessions[sessionID]) throw new Error("not found");
				return sessions[sessionID];
			},
			context: async () => messages,
			synthetic: async (input: unknown) => {
				synthetic.push(input);
			},
		},
		tool: { hook: hook("tool") },
		shell: { hook: hook("shell") },
		event: {
			subscribe: ({ signal }: { signal: AbortSignal }) => ({
				async *[Symbol.asyncIterator]() {
					while (!signal.aborted) {
						if (pending.length) yield pending.shift();
						else await new Promise<void>((resolve) => (notify = resolve));
					}
				},
			}),
		},
	};
	const emit = async (type: string, data: unknown) => {
		pending.push({ type, data });
		notify?.();
		await Bun.sleep(20);
	};
	return { ctx, hooks, mcp, skills, synthetic, emit };
}

test("OpenCode 2 adds the Tedix MCP server with its CIMD client and the shared skills", async () => {
	const fake = context2();
	const cleanup = await module.default.setup(fake.ctx as never);
	const mcp = JSON.parse(readFileSync(join(ROOT, "mcp.json"), "utf8"));
	expect(fake.mcp.get("tedix")).toEqual({
		type: "remote",
		url: mcp.mcpServers.tedix.url,
		oauth: {
			client_id: TEDIX_OPENCODE_OAUTH_CLIENT_ID,
			redirect_uri: TEDIX_OPENCODE_OAUTH_REDIRECT_URI,
		},
	});
	const names = readdirSync(join(ROOT, "skills"));
	expect([...fake.skills.keys()].sort()).toEqual(names.sort());
	const connect = fake.skills.get("tedix-connect");
	expect(connect.path).toBe(join(ROOT, "skills", "tedix-connect", "SKILL.md"));
	expect(connect.description).toStartWith("Connect an agent host");
	expect(connect.content).not.toContain("description:");
	expect(connect.content).toContain("# Connect to Tedix");
	expect(fake.skills.get("tedix-session-guide").description).toStartWith(
		"Orient a Codex",
	);
	cleanup?.();

	const own = context2({ mcp: false });
	(await module.default.setup(own.ctx as never))?.();
	expect(own.mcp.size).toBe(0);
	expect(own.skills.size).toBe(names.length);
});

test("OpenCode 2 skips a skill with malformed metadata without hiding valid skills", async () => {
	const root = join(directory, "isolated-plugin");
	const pluginDirectory = join(root, ".opencode-plugin");
	const skillsDirectory = join(root, "skills");
	mkdirSync(pluginDirectory, { recursive: true });
	mkdirSync(join(skillsDirectory, "broken"), { recursive: true });
	mkdirSync(join(skillsDirectory, "valid"), { recursive: true });
	const pluginPath = join(pluginDirectory, "index.mjs");
	writeFileSync(
		pluginPath,
		readFileSync(join(ROOT, ".opencode-plugin", "index.js"), "utf8"),
	);
	writeFileSync(
		join(skillsDirectory, "broken", "SKILL.md"),
		'---\nname: broken\ndescription: "unterminated\n---\n# Broken\n',
	);
	writeFileSync(
		join(skillsDirectory, "valid", "SKILL.md"),
		'---\nname: valid\ndescription: "Valid skill"\n---\n# Valid\n',
	);
	const isolated = await import(pathToFileURL(pluginPath).href);
	const fake = context2();
	const cleanup = await isolated.default.setup(fake.ctx);
	expect([...fake.skills.keys()]).toEqual(["valid"]);
	expect(fake.skills.get("valid")).toMatchObject({
		name: "valid",
		description: "Valid skill",
		content: "# Valid\n",
	});
	cleanup?.();
});

test("OpenCode 2 sends session-start and prompt context as system text on model requests", async () => {
	fakeCli();
	const fake = context2();
	const cleanup = await module.default.setup(fake.ctx as never);
	await fake.emit("session.created", { sessionID: SESSION });
	const request = () => {
		const event = {
			sessionID: SESSION,
			model: { providerID: "azure", id: "gpt-example" },
			system: [] as unknown[],
		};
		fake.hooks["session.context"]!(event);
		return event.system;
	};
	expect(request()).toEqual([]);
	await fake.hooks["session.prompt"]!({
		sessionID: SESSION,
		prompt: { text: "Find the Work for this task" },
	});
	expect(request()).toEqual([
		{
			type: "text",
			text: "<tedix-context>\ncontext from session-start\n\ncontext from prompt-context\n</tedix-context>",
		},
	]);
	await fake.hooks["session.prompt"]!({
		sessionID: SESSION,
		prompt: { text: "Next" },
	});
	expect(
		calls().filter((call) => call.args?.includes("session-start")),
	).toEqual([
		{
			args: "hooks session-start --host opencode",
			event: {
				session_id: SESSION,
				cwd: directory,
				hook_event_name: "SessionStart",
				source: "startup",
			},
		},
	]);
	expect(
		calls().filter((call) => call.args?.includes("capture-reply")),
	).toHaveLength(2);
	cleanup?.();
});

test("OpenCode 2 shell commands carry the root session's Agent-Session, version and model", async () => {
	const fake = context2({ hooks: false }, [], {
		[CHILD]: { id: CHILD, parentID: SESSION, time: { created: 0 } },
	});
	const cleanup = await module.default.setup(fake.ctx as never);
	fake.hooks["session.context"]!({
		sessionID: SESSION,
		model: { providerID: "azure", id: "gpt-example" },
		system: [],
	});
	await fake.hooks["tool.execute.before"]!({
		tool: "shell",
		sessionID: CHILD,
		id: "call_1",
		input: { command: "tedix agent start" },
	});
	const other = { command: "ls", env: {} as Record<string, string> };
	await fake.hooks["shell.create.before"]!(other);
	expect(other.env).toEqual({});
	const shell = {
		command: "tedix agent start",
		env: {} as Record<string, string>,
	};
	await fake.hooks["shell.create.before"]!(shell);
	expect(shell.env).toEqual({
		TEDIX_AGENT_SESSION: `opencode:${SESSION}`,
		OPENCODE_SESSION_ID: SESSION,
		TEDIX_AGENT_HARNESS_VERSION: "2.1.2",
		TEDIX_AGENT_MODEL_PROVIDER: "azure",
		TEDIX_AGENT_MODEL_ID: "gpt-example",
	});
	expect(fake.hooks["session.prompt"]).toBeUndefined();
	cleanup?.();
});

test("OpenCode 2 keeps concurrent identical shell commands tied to their sessions", async () => {
	const fake = context2({ hooks: false });
	const cleanup = await module.default.setup(fake.ctx as never);
	for (const [sessionID, modelID] of [
		[SESSION, "gpt-first"],
		[OTHER_SESSION, "gpt-second"],
	] as const)
		fake.hooks["session.context"]!({
			sessionID,
			model: { providerID: "azure", id: modelID },
			system: [],
		});
	const command = "printf identical";
	await fake.hooks["tool.execute.before"]!({
		tool: "shell",
		sessionID: SESSION,
		id: "call_first",
		input: { command },
	});
	await fake.hooks["tool.execute.before"]!({
		tool: "shell",
		sessionID: OTHER_SESSION,
		id: "call_second",
		input: { command },
	});
	const first = { command, env: {} as Record<string, string> };
	const second = { command, env: {} as Record<string, string> };
	await fake.hooks["shell.create.before"]!(first);
	await fake.hooks["shell.create.before"]!(second);
	expect(first.env).toMatchObject({
		TEDIX_AGENT_SESSION: `opencode:${SESSION}`,
		TEDIX_AGENT_MODEL_ID: "gpt-first",
	});
	expect(second.env).toMatchObject({
		TEDIX_AGENT_SESSION: `opencode:${OTHER_SESSION}`,
		TEDIX_AGENT_MODEL_ID: "gpt-second",
	});
	cleanup?.();
});

for (const hooks of [false, true])
	for (const ending of [
		"session.idle",
		"session.status",
		"session.execution.failed",
		"session.deleted",
	])
		test(`OpenCode 2 releases cancelled shells on ${ending} with hooks=${hooks}`, async () => {
			fakeCli();
			const fake = context2({ hooks });
			const cleanup = await module.default.setup(fake.ctx as never);
			try {
				const command = "printf identical";
				for (const [sessionID, id] of [
					[SESSION, "cancelled"],
					[OTHER_SESSION, "active"],
				])
					await fake.hooks["tool.execute.before"]!({
						tool: "shell",
						sessionID,
						id,
						input: { command },
					});
				await fake.emit(ending, {
					sessionID: SESSION,
					status: { type: "idle" },
				});
				const active = { command, env: {} as Record<string, string> };
				await fake.hooks["shell.create.before"]!(active);
				expect(active.env.TEDIX_AGENT_SESSION).toBe(
					`opencode:${OTHER_SESSION}`,
				);
				const unrelated = { command, env: {} as Record<string, string> };
				await fake.hooks["shell.create.before"]!(unrelated);
				expect(unrelated.env).toEqual({});
			} finally {
				cleanup?.();
			}
		});

test("OpenCode 2 unload releases pending shells", async () => {
	const fake = context2({ hooks: false });
	const cleanup = await module.default.setup(fake.ctx as never);
	const command = "printf cancelled";
	await fake.hooks["tool.execute.before"]!({
		tool: "shell",
		sessionID: SESSION,
		id: "cancelled",
		input: { command },
	});
	cleanup?.();
	const shell = { command, env: {} as Record<string, string> };
	await fake.hooks["shell.create.before"]!(shell);
	expect(shell.env).toEqual({});
});

test("OpenCode 2 edits get advisory recall appended to their result content", async () => {
	fakeCli();
	const fake = context2();
	const cleanup = await module.default.setup(fake.ctx as never);
	const call = { tool: "edit", sessionID: SESSION, id: "call_1" };
	await fake.hooks["tool.execute.before"]!({
		...call,
		input: { path: "/repo/a.ts", oldString: "a", newString: "b" },
	});
	const after = {
		...call,
		status: "completed",
		result: { content: "Edit applied." } as Record<string, unknown>,
	};
	await fake.hooks["tool.execute.after"]!(after);
	expect(after.result.content).toBe(
		"Edit applied.\n\n<tedix-recall>\ncontext from situational-recall\n</tedix-recall>",
	);
	expect(calls()[0]?.event).toMatchObject({
		hook_event_name: "PreToolUse",
		tool_name: "Edit",
		tool_input: { path: "/repo/a.ts", file_path: "/repo/a.ts" },
	});
	cleanup?.();
});

test("OpenCode 2 idle captures the turn and wakes with a synthetic message", async () => {
	fakeCli(
		'if [ "$2" = "await-reply" ]; then printf "The user replied in Tedix OS: continue" >&2; exit 2; fi',
	);
	const fake = context2({}, [
		{ type: "user", id: "msg_user", text: "Check it" },
		{
			type: "assistant",
			id: "msg_first",
			content: [{ type: "text", text: "Checked the example." }],
		},
		{
			type: "assistant",
			id: "msg_last",
			content: [
				{ type: "reasoning", text: "hidden" },
				{ type: "text", text: "Should I continue?" },
			],
		},
	]);
	const cleanup = await module.default.setup(fake.ctx as never);
	await fake.emit("session.status", {
		sessionID: SESSION,
		status: { type: "idle" },
	});
	await until(() => fake.synthetic.length === 1);
	expect(fake.synthetic[0]).toEqual({
		sessionID: SESSION,
		text: "The user replied in Tedix OS: continue",
	});
	expect(
		calls().find((call) => call.args?.includes("capture-stop"))?.event,
	).toEqual({
		session_id: SESSION,
		cwd: directory,
		hook_event_name: "Stop",
		turn_id: "msg_last",
		last_assistant_message: "Should I continue?",
		opencode_turn_text: "Checked the example.\n\nShould I continue?",
	});
	await fake.emit("session.idle", { sessionID: SESSION });
	await Bun.sleep(30);
	expect(fake.synthetic).toHaveLength(1);
	cleanup?.();
});

test("OpenCode 2 permission, failure and deletion events report status", async () => {
	fakeCli();
	const fake = context2();
	const cleanup = await module.default.setup(fake.ctx as never);
	await fake.emit("permission.asked", {
		sessionID: SESSION,
		action: "shell",
		metadata: { command: "bun run test:run" },
	});
	await fake.emit("permission.replied", { sessionID: SESSION, reply: "once" });
	await fake.emit("session.execution.failed", {
		sessionID: SESSION,
		error: { type: "provider", message: "Failed" },
	});
	await fake.emit("session.deleted", { sessionID: SESSION });
	await until(() => callsSafeCount() === 4);
	expect(calls().map((call) => call.event.hook_event_name)).toEqual([
		"PermissionRequest",
		"PostToolUse",
		"StopFailure",
		"SessionEnd",
	]);
	expect(calls()[0]?.event).toMatchObject({
		tool_name: "shell",
		tool_input: { command: "bun run test:run" },
	});
	cleanup?.();
});
