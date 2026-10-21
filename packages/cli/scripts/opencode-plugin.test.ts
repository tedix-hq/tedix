import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEDIX_OPENCODE_OAUTH_CLIENT_ID } from "@tedix/auth/oauth-client-registration";
import * as module from "../../../plugins/tedix/.opencode-plugin/tedix.js";
import { ROOT } from "./package-plugin";

const SESSION = "ses_ea08bec38ffeGv2rruD2pzxAuC";
const CHILD = "ses_ea08bec38fffAbCdEfGhIjKlMn";
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
	module.TedixPlugin({ directory } as never, options);

const message = (sessionID = SESSION) => ({
	message: { id: "msg_1" },
	parts: [{ type: "text", text: "Find the Work for this task", id: "prt_1" }],
	sessionID,
});

test("exports exactly one plugin, because OpenCode loads every exported function", () => {
	expect(Object.keys(module)).toEqual(["TedixPlugin"]);
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
	expect(calls()).toEqual([
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
	expect(rest).toEqual([]);
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
