import { expect, test } from "bun:test";
import { isHostSessionId } from "@tedix/api-contract/utils/host-session-id";
import { scopeSession } from "../session-scope";
import { resolveAgentSession } from "../work-identity";
import { harnessOf } from "./agent-status";
import { runHooksCommand } from "./command";
import { hostEvent } from "./hook-io";
import { OPENCODE_HOOKS, opencodeHookEvent } from "./opencode-event";
import { runSessionStart } from "./session-start";

const SESSION = "ses_ea08bec38ffeGv2rruD2pzxAuC";

test("accepts only OpenCode's generated session id shape", () => {
	expect(isHostSessionId(SESSION)).toBe(true);
	for (const id of [
		"ses_ea08bec38ffeGv2rruD2pzxAu",
		"ses_ea08bec38ffeGv2rruD2pzxAuCx",
		"ses_xa08bec38ffeGv2rruD2pzxAuC",
		"ses_ea08bec38ffe-v2rruD2pzxAuC",
		`${SESSION}\n`,
	])
		expect(isHostSessionId(id)).toBe(false);
});

test("OpenCode hook identity overrides inherited hosts", async () => {
	const mapped = opencodeHookEvent(
		JSON.stringify({ session_id: SESSION, source: "startup", cwd: "/example" }),
		{
			CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111",
			CLAUDE_CODE_SESSION_ID: "22222222-2222-4222-8222-222222222222",
			CLAUDE_CODE_SESSION_ATTENDED: "0",
			TEDIX_AGENT_SESSION: "claude-code:22222222-2222-4222-8222-222222222222",
		},
	);
	expect(mapped.env).toMatchObject({
		TEDIX_HOOK_HOST: "opencode",
		OPENCODE_SESSION_ID: SESSION,
	});
	for (const key of [
		"CODEX_THREAD_ID",
		"CLAUDE_CODE_SESSION_ID",
		"CLAUDE_CODE_SESSION_ATTENDED",
		"TEDIX_AGENT_SESSION",
	])
		expect(mapped.env[key]).toBeUndefined();
	expect(JSON.parse(mapped.stdin).session_id).toBe(SESSION.toLowerCase());
	expect(hostEvent(mapped.stdin, mapped.env, 10_000).session).toBe(
		SESSION.toLowerCase(),
	);
	expect(harnessOf({}, mapped.env)).toBe("opencode");
	// Without the explicit host, an OpenCode id is not a chat identity.
	expect(() => hostEvent(mapped.stdin, {}, 10_000)).toThrow();
	for (const id of ["quiet-river", "11111111-1111-4111-8111-111111111111"])
		expect(() =>
			opencodeHookEvent(JSON.stringify({ session_id: id }), {}),
		).toThrow();

	const output: string[] = [];
	await runSessionStart({
		env: { ...mapped.env, TEDIX_PLUGIN_PREFLIGHT: "1" },
		stdin: mapped.stdin,
		cwd: "/example",
		read: async () => {
			throw new Error("No bound workspace");
		},
		write: (line) => output.push(line),
	});
	const context = JSON.parse(output[0]!).hookSpecificOutput.additionalContext;
	expect(context).not.toContain("host chat identity unavailable");
});

test("the Agent-Session the plugin exports names the opencode harness", () => {
	const previous = process.env.TEDIX_AGENT_SESSION;
	process.env.TEDIX_AGENT_SESSION = `opencode:${SESSION}`;
	try {
		expect(resolveAgentSession()).toMatchObject({
			session: `opencode:${SESSION}`,
			harness: "opencode",
			derived: false,
		});
	} finally {
		if (previous === undefined) delete process.env.TEDIX_AGENT_SESSION;
		else process.env.TEDIX_AGENT_SESSION = previous;
	}
	expect(scopeSession({ TEDIX_AGENT_SESSION: `opencode:${SESSION}` })).toBe(
		SESSION.toLowerCase(),
	);
});

test("OpenCode permits the lifecycle hooks but no plugin flag or unrelated hook", async () => {
	for (const name of ["capture-stop", "capture-reply", "status", "await-reply"])
		expect(OPENCODE_HOOKS.has(name)).toBe(true);
	for (const name of ["await-draft", "devin-permission", "unknown"])
		expect(await runHooksCommand([name, "--host", "opencode"])).toBe(1);
	expect(
		await runHooksCommand(["session-start", "--host", "opencode", "--plugin"]),
	).toBe(1);
});
