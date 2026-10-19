import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	devinCliCommand,
	devinPermissionProfile,
	setupDevin,
} from "./devin-config";
import { createDevinLaneThread, devinAvailable } from "./devin-lane-thread";
import { parseServeOptions } from "./lane-serve";
import { runLaneProcess } from "./lane-run";
import { writeExternalAgentProfile } from "./external-agent-store";
import {
	devinContextOutput,
	devinHookEvent,
	skipInheritedDevinHook,
} from "./hooks/devin-event";
import { devinPermissionBlock } from "./hooks/devin-permission";
import { hostEvent } from "./hooks/hook-io";
import { harnessOf } from "./hooks/agent-status";
import { scopeSession } from "./session-scope";
import { runSessionStart } from "./hooks/session-start";

const directories: string[] = [];
const originalPath = process.env.PATH;
const originalConfigDir = process.env.TEDIX_CONFIG_DIR;
afterEach(() => {
	process.env.PATH = originalPath;
	if (originalConfigDir === undefined) delete process.env.TEDIX_CONFIG_DIR;
	else process.env.TEDIX_CONFIG_DIR = originalConfigDir;
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function temporary() {
	const dir = mkdtempSync(join(tmpdir(), "tedix-devin-test-"));
	directories.push(dir);
	return dir;
}
function fakeDevin(dir: string) {
	const path = join(dir, "devin");
	writeFileSync(
		path,
		`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'auth') { console.log('Not logged in'); process.exit(1); }
if (args[0] === '--version') { console.log('devin 3000.11.92 (7f4e64980e22)'); process.exit(0); }
if (args[0] === 'list') { console.log(JSON.stringify(fs.existsSync('persisted') ? [{id:'quiet-river'}] : [])); process.exit(0); }
if (args[0] === 'acp') {
 require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (!['initialize','session/new'].includes(m.method)) process.exit(42);
  if (m.method === 'session/new' && m.params._meta?.['cognition.ai/persistOnCreate'] === true) fs.writeFileSync('persisted','quiet-river');
  const result = m.method === 'initialize' ? {protocolVersion:1,agentInfo:{name:'devin',version:'0.0.0-dev'},agentCapabilities:{_meta:{'cognition.ai/persistOnCreate':true}}} : {sessionId:'quiet-river',configOptions:[{category:'model',currentValue:'model-2026-10-01'}]};
  console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
 });
} else {
 fs.writeFileSync('persisted','quiet-river');
 const config = JSON.parse(fs.readFileSync(args[args.indexOf('--config')+1], 'utf8'));
 fs.writeFileSync('invocation.json',JSON.stringify({args,cwd:process.cwd(),config,inherited:process.env.CLAUDE_CODE_SESSION_ID,root:process.env.TEDIX_DEVIN_LANE_ROOT,session:process.env.TEDIX_AGENT_SESSION,workspace:process.env.TEDIX_WORKSPACE,organization:process.env.TEDIX_ORGANIZATION}));
 fs.writeFileSync(args[args.indexOf('--export')+1], JSON.stringify({session_id:'quiet-river',steps:[]}));
 console.log('Fake Devin completed the brief.');
}
`,
	);
	chmodSync(path, 0o700);
	return path;
}

test("Devin is an explicit executor; logged-out installations are unavailable", () => {
	const dir = temporary();
	expect(
		parseServeOptions([
			"--executor",
			"devin",
			"--workspace",
			"test",
			"--organization",
			"example",
		]).executor,
	).toBe("devin");
	expect(devinAvailable(fakeDevin(dir))).toBe(false);
});

test("ACP allocates a persisted native identity without any model prompt", async () => {
	const dir = temporary();
	const native = await createDevinLaneThread(dir, fakeDevin(dir));
	expect(native).toEqual({
		thread: { id: "quiet-river", cliVersion: "3000.11.92" },
		model: "model-2026-10-01",
		modelProvider: "devin",
	});
});

test("unsupported persistence and missing persisted identity refuse before a prompt", async () => {
	for (const [before, after, error] of [
		[
			"'cognition.ai/persistOnCreate':true",
			"'cognition.ai/persistOnCreate':false",
			"cannot persist",
		],
		[
			"m.params._meta?.['cognition.ai/persistOnCreate'] === true",
			"false",
			"not persisted",
		],
		["currentValue:'model-2026-10-01'", "currentValue:'swe'", "resolved model"],
		["devin 3000.11.92 (7f4e64980e22)", "unknown", "version unavailable"],
	]) {
		const dir = temporary();
		const binary = fakeDevin(dir);
		writeFileSync(
			binary,
			readFileSync(binary, "utf8").replace(before!, after!),
		);
		await expect(createDevinLaneThread(dir, binary)).rejects.toThrow(error!);
		expect(existsSync(join(dir, "invocation.json"))).toBe(false);
	}
});

test("headless runner uses cwd, native resume, permission config, export and final stdout", async () => {
	const dir = temporary();
	process.env.TEDIX_CONFIG_DIR = dir;
	writeExternalAgentProfile("fixture", {
		organizationId: "org_example",
		principalId: "example",
		key: "local-example",
		displayName: "Example",
		apiKeyId: "example",
		rawApiKey: "fixture",
		scopes: [],
		mcpUrl: "https://example.invalid/mcp",
		createdAt: new Date().toISOString(),
		sessions: {},
	});
	fakeDevin(dir);
	process.env.PATH = `${dir}:${originalPath}`;
	const brief = join(dir, "brief.txt");
	writeFileSync(brief, "Read the standing rules. Make no changes.");
	const reports: any[] = [];
	const result = await runLaneProcess(
		[
			"run",
			"--executor",
			"devin",
			"--project",
			"11111111-1111-4111-8111-111111111111",
			"--brief",
			brief,
			"--model",
			"model-2026-10-01",
			"--workspace",
			"fixture",
			"--organization",
			"org_example",
		],
		{
			cwd: dir,
			heartbeatMs: 5,
			report: async (value) => {
				reports.push(value);
				return {};
			},
		},
	);
	expect(result).toBe(0);
	const invocation = JSON.parse(
		readFileSync(join(dir, "invocation.json"), "utf8"),
	);
	expect(invocation.cwd).toBe(realpathSync(dir));
	expect(invocation.args).toContain("accept-edits");
	expect(invocation.args).not.toContain("dangerous");
	expect(invocation.args.slice(0, 4)).toEqual(
		["-p", "-r", "quiet-river"].concat("--prompt-file"),
	);
	expect(invocation.config.read_config_from.claude).toBe(false);
	expect(invocation.inherited).toBeUndefined();
	expect(invocation.root).toBe(dir);
	expect(invocation.session).toBe("devin:quiet-river");
	expect(invocation.workspace).toBe("fixture");
	expect(invocation.organization).toBe("org_example");
	expect(invocation.config.permissions.allow).toContain(
		`Exec(TEDIX_AGENT_SESSION=devin:quiet-river TEDIX_EXTERNAL_AGENT=local-example ${devinCliCommand()})`,
	);
	expect(existsSync(`${brief}.devin.atif.json`)).toBe(true);
	expect(reports.at(-1).sessionKey).toBe("quiet-river");
	expect(reports.at(-1).telemetry.finalMessage).toContain(
		"Fake Devin completed",
	);
	expect(reports.at(-1).telemetry.outcome).toBe("succeeded");
});

test("headless permission rejection fails the lane even when Devin exits zero", async () => {
	const dir = temporary();
	const binary = fakeDevin(dir);
	writeFileSync(
		binary,
		readFileSync(binary, "utf8").replace(
			"console.log('Fake Devin completed the brief.');",
			"console.error('warning: rejected a tool call that requires confirmation. Running in non-interactive mode.');",
		),
	);
	const brief = join(dir, "brief.txt");
	writeFileSync(brief, "Read-only smoke");
	const reports: Record<string, unknown>[] = [];
	expect(
		await runLaneProcess(
			[
				"run",
				"--executor",
				"devin",
				"--project",
				"11111111-1111-4111-8111-111111111111",
				"--brief",
				brief,
				"--",
				binary,
			],
			{
				cwd: dir,
				report: async (value) => {
					reports.push(value);
					return {};
				},
			},
		),
	).toBe(1);
	expect(reports.at(-1)?.state).toBe("error");
	expect(reports.at(-1)?.telemetry).toMatchObject({ outcome: "failed" });
});

test("setup merges idempotently and refuses a conflicting MCP endpoint without writes", () => {
	const dir = temporary();
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({
			theme_mode: "dark",
			hooks: {
				Stop: [
					{ hooks: [{ command: "unrelated" }] },
					{
						hooks: [
							{
								command:
									"custom-wrapper tedix hooks capture-stop --host devin && custom-cleanup",
							},
						],
					},
				],
			},
		}),
	);
	writeFileSync(
		join(dir, "mcp_config.json"),
		JSON.stringify({ mcpServers: { other: { command: "example" } } }),
	);
	setupDevin(dir);
	const once = readFileSync(join(dir, "config.json"), "utf8");
	setupDevin(dir);
	expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(once);
	expect(JSON.parse(once).theme_mode).toBe("dark");
	expect(JSON.parse(once).hooks.Stop[0].hooks[0].command).toBe("unrelated");
	expect(JSON.parse(once).hooks.Stop[1].hooks[0].command).toBe(
		"custom-wrapper tedix hooks capture-stop --host devin && custom-cleanup",
	);
	const mcp = JSON.parse(readFileSync(join(dir, "mcp_config.json"), "utf8"));
	expect(mcp.mcpServers.other.command).toBe("example");
	mcp.mcpServers.tedix.url = "https://example.invalid/mcp";
	writeFileSync(join(dir, "mcp_config.json"), JSON.stringify(mcp));
	expect(() => setupDevin(dir)).toThrow("different tedix MCP server");
	expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(once);
});

test("Devin hook identity overrides inherited hosts and retains Claude-compatible context output", async () => {
	const mapped = devinHookEvent(
		JSON.stringify({
			session_id: "quiet-river",
			prompt_id: "turn-1",
			prompt: "hello",
			source: "new",
		}),
		{
			CODEX_THREAD_ID: "other",
			CLAUDE_CODE_SESSION_ID: "other",
			DEVIN_PROJECT_DIR: "/example",
		},
	);
	expect(hostEvent(mapped.stdin, mapped.env, 10000).session).toBe(
		"quiet-river",
	);
	expect(harnessOf({}, mapped.env)).toBe("devin");
	expect(scopeSession({ TEDIX_AGENT_SESSION: "devin:quiet-river" })).toBe(
		"quiet-river",
	);
	expect(JSON.parse(mapped.stdin).source).toBe("startup");
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
	expect(JSON.parse(output[0]!).hookSpecificOutput.additionalContext).toContain(
		"no current Work was read",
	);
	expect(
		JSON.parse(devinContextOutput(output[0]!, "quiet-river")).hookSpecificOutput
			.additionalContext,
	).toContain(`TEDIX_AGENT_SESSION=devin:quiet-river ${devinCliCommand()}`);
	expect(
		skipInheritedDevinHook(["capture-stop"], { DEVIN_PROJECT_DIR: "/example" }),
	).toBe(true);
	expect(
		skipInheritedDevinHook(["capture-stop", "--host", "devin"], {
			DEVIN_PROJECT_DIR: "/example",
		}),
	).toBe(false);
});

test("permission fence blocks traversal, symlinks, secrets and prohibited commands", () => {
	const dir = temporary();
	const root = join(dir, "repo");
	mkdirSync(root);
	symlinkSync(dir, join(root, "escape"));
	const write = (path: string) =>
		devinPermissionBlock(
			JSON.stringify({ tool_name: "write", tool_input: { path } }),
			root,
		);
	expect(write("src/new.ts")).toBeUndefined();
	expect(write("../outside.ts")).toContain("inside");
	expect(write("escape/outside.ts")).toContain("inside");
	expect(write(".devin/config.local.json")).toContain("protected");
	for (const command of [
		"git push --force",
		"git -C . push origin main -f",
		"tedix --workspace test login",
		"bunx wrangler deploy",
	])
		expect(
			devinPermissionBlock(
				JSON.stringify({ tool_name: "exec", tool_input: { command } }),
				root,
			),
		).toBeDefined();
	const profile = devinPermissionProfile(root, {
		id: "quiet-river",
		principalKey: "local-example",
	});
	expect(profile.permissions.allow).toContain(`Write(${root}/**)`);
	expect(profile.permissions.allow).toContain(`Exec(git -C ${root} fetch)`);
	expect(profile.permissions.allow).not.toContain("Exec(git -C)");
	for (const cli of ["tedix", devinCliCommand()]) {
		expect(profile.permissions.allow).toContain(
			`Exec(TEDIX_AGENT_SESSION=devin:quiet-river ${cli})`,
		);
		expect(profile.permissions.allow).toContain(
			`Exec(TEDIX_AGENT_SESSION=devin:quiet-river TEDIX_EXTERNAL_AGENT=local-example ${cli})`,
		);
		expect(profile.permissions.allow).not.toContain(
			`Exec(TEDIX_AGENT_SESSION=devin:other-session ${cli})`,
		);
	}
	expect(profile.permissions.deny).toContain("Exec(git push)");
	expect(profile.permissions.deny).toContain("Write(~/.ssh/**)");
});

test("a transcript from a different native session fails settlement", async () => {
	const dir = temporary();
	const binary = fakeDevin(dir);
	writeFileSync(
		binary,
		readFileSync(binary, "utf8").replace(
			"session_id:'quiet-river'",
			"session_id:'other-session'",
		),
	);
	const brief = join(dir, "brief.txt");
	writeFileSync(brief, "Read-only smoke");
	const reports: Record<string, unknown>[] = [];
	const result = await runLaneProcess(
		[
			"run",
			"--executor",
			"devin",
			"--project",
			"11111111-1111-4111-8111-111111111111",
			"--brief",
			brief,
			"--",
			binary,
		],
		{
			cwd: dir,
			sessionKey: "quiet-river",
			report: async (value) => {
				reports.push(value);
				return {};
			},
		},
	);
	expect(result).toBe(1);
	expect(reports.at(-1)?.state).toBe("error");
});
