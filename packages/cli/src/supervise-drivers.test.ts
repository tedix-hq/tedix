import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordLocalSession } from "./hooks/decision-capture";
import { localSessions } from "./supervise-questions";
import {
	resumeDriver,
	resumeReceipt,
	type LeadHost,
} from "./supervise-drivers";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "supervise-drivers-"));
	mkdirSync(join(directory, "bin"));
	for (const host of ["claude", "codex", "devin", "opencode"])
		writeFileSync(
			join(directory, "bin", host),
			`#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const file = args.indexOf("--prompt-file");
const message = readFileSync(file < 0 ? 0 : args[file + 1], "utf8");
writeFileSync(process.env.FIXTURE_CALL, JSON.stringify({ args, message, cwd: process.cwd(), inheritedIdentity: process.env.TEDIX_AGENT_SESSION, inheritedHost: process.env.CODEX_THREAD_ID }));
const output = process.env.FIXTURE_OUTPUT;
const exported = args.indexOf("--export");
if (exported < 0) process.stdout.write(output + "\\n");
else writeFileSync(args[exported + 1], output);
process.exit(Number(process.env.FIXTURE_EXIT || "0"));
`,
			{ mode: 0o755 },
		);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const hosts: Array<[LeadHost, string, object]> = [
	[
		"claude-code",
		"11111111-1111-4111-8111-111111111111",
		{
			type: "system",
			subtype: "init",
			session_id: "11111111-1111-4111-8111-111111111111",
		},
	],
	[
		"codex",
		"11111111-1111-4111-8111-111111111111",
		{
			type: "thread.started",
			thread_id: "11111111-1111-4111-8111-111111111111",
		},
	],
	["devin", "quiet-otter", { session_id: "quiet-otter", steps: [] }],
	[
		"opencode",
		"ses_abcdef012345AbCdEf01234567",
		{ type: "step_start", sessionID: "ses_abcdef012345AbCdEf01234567" },
	],
];

for (const [host, session, receipt] of hosts) {
	test(`${host} launch preserves session, prompt, directory and permission defaults`, async () => {
		const env = {
			...process.env,
			PATH: join(directory, "bin"),
			TEDIX_CONFIG_DIR: directory,
			TEDIX_AGENT_SESSION: "codex:parent",
			CODEX_THREAD_ID: "parent",
			FIXTURE_CALL: join(directory, "call.json"),
			FIXTURE_OUTPUT: JSON.stringify(receipt),
		};
		const run = await resumeDriver(host, env).resume(
			session,
			"A pending Lead answer.\nKeep this exact text.",
			directory,
		);
		expect(run.started).toBe(true);
		expect(await run.done).toBe(true);
		const call = JSON.parse(readFileSync(env.FIXTURE_CALL, "utf8"));
		expect(call.message).toBe("A pending Lead answer.\nKeep this exact text.");
		expect(call.cwd).toBe(realpathSync(directory));
		expect(call.args).toContain(session);
		expect(call.args).not.toContain("--continue");
		expect(call.args).not.toContain("--auto");
		expect(call.args).not.toContain("--permission-mode");
		expect(call.args).not.toContain("--respect-workspace-trust");
		expect(call.inheritedIdentity).toBeUndefined();
		expect(call.inheritedHost).toBeUndefined();
	});

	test(`${host} rejects a different session and missing executable`, async () => {
		const env = {
			...process.env,
			PATH: join(directory, "bin"),
			TEDIX_CONFIG_DIR: directory,
			FIXTURE_CALL: join(directory, "call.json"),
			FIXTURE_OUTPUT: JSON.stringify({ session_id: "wrong-session" }),
		};
		const wrong = await resumeDriver(host, env).resume(
			session,
			"answer",
			directory,
		);
		expect(wrong.started).toBe(false);
		await wrong.done;
		const missing = await resumeDriver(host, {
			...env,
			PATH: join(directory, "missing"),
		}).resume(session, "answer", directory);
		expect(missing.started).toBe(false);
		expect(await missing.done).toBe(false);
	});
}

test("native errors fail receipt confirmation even with a matching session", () => {
	expect(
		resumeReceipt('{"type":"error","sessionID":"quiet-otter"}').failed,
	).toBe(true);
	expect(
		resumeReceipt(
			'{"type":"result","is_error":true,"session_id":"quiet-otter"}',
		).failed,
	).toBe(true);
	expect(resumeReceipt('{"type":')).toEqual({ sessions: [], failed: false });
});

test("local session discovery preserves opaque native ids and rejects unknown or case-lost hosts", () => {
	const env = {
		TEDIX_CONFIG_DIR: directory,
		OPENCODE_SESSION_ID: "ses_abcdef012345AbCdEf01234567",
	};
	recordLocalSession(
		env,
		env.OPENCODE_SESSION_ID.toLowerCase(),
		"opencode",
		directory,
	);
	recordLocalSession(env, "quiet-otter", "devin", directory);
	recordLocalSession(env, "unknown-host", "other", directory);
	recordLocalSession(
		env,
		"ses_111111111111aaaaaaaaaaaaaa",
		"opencode",
		directory,
	);
	const sessions = localSessions(env, Date.now());
	expect(sessions.map((s) => s.host).sort()).toEqual(["devin", "opencode"]);
	expect(sessions.find((s) => s.host === "opencode")?.nativeSession).toBe(
		env.OPENCODE_SESSION_ID,
	);
});

for (const [host, native] of hosts) {
	test(`${host} picks up only a ready handoff with the same binding, then retains its receipt`, async () => {
		const { Supervisor } = await import("./supervise");
		const { recordDelegation, readDelegations } =
			await import("./delegation-ledger");
		const work = "22222222-2222-4222-8222-222222222222";
		const project = "33333333-3333-4333-8333-333333333333";
		const env = {
			TEDIX_CONFIG_DIR: directory,
			OPENCODE_SESSION_ID: native,
			DEVIN_SESSION_ID: native,
		};
		recordLocalSession(env, native.toLowerCase(), host, directory);
		recordDelegation(env, native, {
			id: work,
			title: "Fixture pending Lead item",
			via: "session",
			launch: true,
			to: `${host}:${native}`,
			workspace: "fixture",
			organization: "org_fixture",
			orgId: "fixture",
			projectId: project,
			createdAt: new Date().toISOString(),
		});
		let ready = false;
		let boundProject = "44444444-4444-4444-8444-444444444444";
		let clock = Date.now();
		const deliveries: string[] = [];
		const deps = {
			env,
			now: () => clock,
			log: () => {},
			codex: {
				queue: async () => undefined,
				received: () => false,
				withdraw: () => false,
				resume: async () => false,
			},
			drivers: {
				[host]: {
					open: () => false,
					deliver: async (session: string) => {
						deliveries.push(session);
						return { via: "supervisor_resume" as const };
					},
				},
			},
			read: async (args: string[]) => {
				if (args.includes("show"))
					return {
						status: "bound",
						decisionCapture: true,
						contextSource: "default",
						workspace: "fixture",
						organization: "org_fixture",
						projectId: boundProject,
						mcpUrl: "https://fixture.invalid/mcp",
					};
				if (args.includes("auth"))
					return {
						wouldUse: "stored-login",
						mcpUrl: "https://fixture.invalid/mcp",
						storedLogin: {
							loginId: "fixture-user",
							accessToken: { selectedOrganizations: ["org_fixture"] },
						},
					};
				if (args.includes("readiness")) return { workItemId: work, ready };
				throw new Error("Unexpected handoff read");
			},
		};
		const runner = new Supervisor(deps);
		expect(await runner.pickupWork()).toBe(0);
		expect(deliveries).toEqual([]);
		boundProject = project;
		clock += 11 * 60_000;
		expect(await runner.pickupWork()).toBe(0);
		ready = true;
		clock += 11 * 60_000;
		expect(await runner.pickupWork()).toBe(1);
		expect(deliveries).toEqual([native]);
		expect(readDelegations(env, native)[0]?.deliveredAt).toBeDefined();
		expect(await new Supervisor(deps).pickupWork()).toBe(0);
		expect(deliveries).toEqual([native]);
	});
}

test("supervisor auth inspection uses the CLI's local snapshot without a child deadline", async () => {
	const { supervisorRead } = await import("./supervise");
	const { readAuthStatus } = await import("./auth-resolve");
	const { parseOptions } = await import("./options");
	const { writeWorkspaceCredentials } = await import("./credential-store");
	const keys = [
		"TEDIX_CONFIG_DIR",
		"TEDIX_EXTERNAL_AGENT",
		"TEDIX_AGENT_SESSION",
		"TEDIX_MCP_BEARER_TOKEN",
		"TEDIX_MCP_API_KEY",
	];
	const previous = keys.map((key) => process.env[key]);
	try {
		for (const key of keys) delete process.env[key];
		process.env.TEDIX_CONFIG_DIR = directory;
		writeWorkspaceCredentials("fixture", {
			loginId: "fixture-owner",
			mcpUrl: "https://fixture.invalid/mcp",
			oauthTokens: { access_token: "fixture-token", token_type: "Bearer" },
		});
		const args = ["-w", "fixture", "auth", "status", "--json"];
		// Child reads reject zero deadlines. Equality also preserves credential precedence.
		expect(await supervisorRead(args, 0)).toEqual(
			JSON.parse(JSON.stringify(readAuthStatus(parseOptions(args).options))),
		);
		process.env.TEDIX_MCP_BEARER_TOKEN = "fixture-explicit-token";
		expect((await supervisorRead(args, 0)).wouldUse).not.toBe("stored-login");
	} finally {
		keys.forEach((key, index) => {
			if (previous[index] === undefined) delete process.env[key];
			else process.env[key] = previous[index];
		});
	}
});
