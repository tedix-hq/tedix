import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { detachedGitEnv } from "../../../scripts/oss/git-env";
import {
	changeAgentContext,
	resolveAgentContext,
	runAgentContext,
} from "./agent-context";
import { writeWorkspaceCredentials } from "./credential-store";

// These tests drive chat identity explicitly; a host session id from the
// harness running them must not leak in.
const hostClaudeSession = process.env.CLAUDE_CODE_SESSION_ID;
beforeAll(() => {
	delete process.env.CLAUDE_CODE_SESSION_ID;
});
afterAll(() => {
	if (hostClaudeSession !== undefined)
		process.env.CLAUDE_CODE_SESSION_ID = hostClaudeSession;
});

const PROJECT = "b63b48b5-3c12-49b4-b508-d7a407676c12";
const WORK = "4faadb1d-dfb5-4930-84d4-39bda2160c46";
const OTHER_WORK = "ac651d65-a993-4e57-aa05-d4c45c78cfda";
function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: detachedGitEnv(),
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}
function fixture() {
	const base = mkdtempSync(join(tmpdir(), "tedix-context-"));
	const cwd = join(base, "repo");
	const configDir = join(base, "config");
	mkdirSync(cwd);
	git(cwd, ["init", "-b", "main"]);
	git(cwd, ["config", "user.name", "Context test"]);
	git(cwd, ["config", "user.email", "context@example.invalid"]);
	writeFileSync(join(cwd, "README.md"), "fixture\n");
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", "fixture"]);
	git(cwd, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
	const opts = { cwd, configDir, sessionId: null as string | null };
	writeWorkspaceCredentials(
		"tedix",
		{
			loginId: "private-operator",
			org: "org_tedix",
			mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
		},
		opts,
	);
	return { base, opts };
}
function bind(opts: ReturnType<typeof fixture>["opts"]) {
	return changeAgentContext(
		"bind",
		{ workspace: "tedix", projectId: PROJECT },
		opts,
	);
}

describe("local agent context", () => {
	test("organization preferences travel across three project chats without sharing their task selection", () => {
		const { opts } = fixture();
		bind(opts);
		const workspaceId = "11111111-1111-4111-8111-111111111111";
		const preferenceId = "22222222-2222-4222-8222-222222222222";
		changeAgentContext(
			"connect-preferences",
			{ osWorkspaceId: workspaceId, contextOutputId: preferenceId },
			opts,
		);
		for (let n = 1; n <= 3; n++) {
			const sessionId = `00000000-0000-4000-8000-00000000000${n}`;
			const projectId = `10000000-0000-4000-8000-00000000000${n}`;
			const contextOutputId = `20000000-0000-4000-8000-00000000000${n}`;
			const chat = { ...opts, sessionId };
			changeAgentContext("connect", { workspace: "tedix", projectId }, chat);
			expect(resolveAgentContext(chat)).toMatchObject({
				projectId,
				preferencesOutputId: preferenceId,
			});
			expect(resolveAgentContext(chat).contextOutputId).toBeUndefined();
			changeAgentContext(
				"connect-output",
				{ osWorkspaceId: workspaceId, contextOutputId },
				chat,
			);
		}
		for (let n = 1; n <= 3; n++)
			expect(
				resolveAgentContext({
					...opts,
					sessionId: `00000000-0000-4000-8000-00000000000${n}`,
				}),
			).toMatchObject({
				preferencesOutputId: preferenceId,
				contextOutputId: `20000000-0000-4000-8000-00000000000${n}`,
				projectId: `10000000-0000-4000-8000-00000000000${n}`,
			});
		writeWorkspaceCredentials(
			"customer",
			{
				loginId: "operator",
				org: "org_customer",
				mcpUrl: "https://customer.example.invalid/mcp",
			},
			opts,
		);
		const customer = {
			...opts,
			sessionId: "30000000-0000-4000-8000-000000000001",
		};
		changeAgentContext(
			"connect",
			{ workspace: "customer", projectId: PROJECT },
			customer,
		);
		expect(resolveAgentContext(customer).preferencesOutputId).toBeUndefined();
		changeAgentContext(
			"disconnect-preferences",
			{},
			{ ...opts, sessionId: "00000000-0000-4000-8000-000000000001" },
		);
		expect(
			resolveAgentContext({
				...opts,
				sessionId: "00000000-0000-4000-8000-000000000002",
			}).preferencesOutputId,
		).toBeUndefined();
	});

	test("a legacy team-lessons document selection is ignored, and resolve reports origin and branch for lesson ranking", () => {
		const { opts } = fixture();
		bind(opts);
		const workspaceId = "11111111-1111-4111-8111-111111111111";
		const preferenceId = "22222222-2222-4222-8222-222222222222";
		changeAgentContext(
			"connect-preferences",
			{ osWorkspaceId: workspaceId, contextOutputId: preferenceId },
			opts,
		);
		const path = join(opts.configDir, "agent-contexts.json");
		const store = JSON.parse(readFileSync(path, "utf8"));
		// Written by CLI 0.1.0-beta.130 and earlier; one entry was even malformed.
		store.lessons = [
			{
				workspace: "tedix",
				org: "org_tedix",
				mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
				osWorkspaceId: workspaceId,
				contextOutputId: "33333333-3333-4333-8333-333333333333",
			},
			{ workspace: "tedix", contextOutputId: "not-a-uuid" },
		];
		writeFileSync(path, JSON.stringify(store));
		const resolved = resolveAgentContext(opts);
		expect(resolved).toMatchObject({
			status: "bound",
			preferencesOutputId: preferenceId,
			origin: "https://example.invalid/repo.git",
			branch: "main",
		});
		expect(Object.keys(resolved).some((key) => key.startsWith("lessons"))).toBe(
			false,
		);
		// The old document commands are gone; a later write keeps the old entry inert.
		expect(() => runAgentContext(["connect-lessons"], opts)).toThrow(
			"Unknown context action",
		);
		changeAgentContext("disconnect-preferences", {}, opts);
		expect(resolveAgentContext(opts).status).toBe("bound");
	});

	test("decision capture is an explicit per-organization opt-in that other organizations do not inherit", () => {
		const { opts } = fixture();
		bind(opts);
		expect(resolveAgentContext(opts).decisionCapture).toBeUndefined();
		changeAgentContext("enable-decision-capture", {}, opts);
		changeAgentContext("enable-decision-capture", {}, opts);
		expect(resolveAgentContext(opts).decisionCapture).toBe(true);
		const chat = { ...opts, sessionId: "00000000-0000-4000-8000-000000000001" };
		changeAgentContext(
			"connect",
			{
				workspace: "tedix",
				projectId: "10000000-0000-4000-8000-000000000001",
			},
			chat,
		);
		expect(resolveAgentContext(chat).decisionCapture).toBe(true);
		writeWorkspaceCredentials(
			"customer",
			{
				loginId: "operator",
				org: "org_customer",
				mcpUrl: "https://customer.example.invalid/mcp",
			},
			opts,
		);
		const customer = {
			...opts,
			sessionId: "30000000-0000-4000-8000-000000000001",
		};
		changeAgentContext(
			"connect",
			{ workspace: "customer", projectId: PROJECT },
			customer,
		);
		expect(resolveAgentContext(customer).decisionCapture).toBeUndefined();
		changeAgentContext("disable-decision-capture", {}, chat);
		expect(resolveAgentContext(chat).decisionCapture).toBeUndefined();
		const configPath = join(opts.configDir, "agent-contexts.json");
		expect(
			JSON.parse(readFileSync(configPath, "utf8")).decisionCapture,
		).toEqual([]);
	});

	test("cleaning up a scratch repository never turns decision capture off for the organization's other repositories", () => {
		const { opts } = fixture();
		bind(opts);
		changeAgentContext("enable-decision-capture", {}, opts);
		const scratch = join(opts.cwd, "..", "scratch");
		mkdirSync(scratch);
		git(scratch, ["init", "-b", "main"]);
		git(scratch, [
			"remote",
			"add",
			"origin",
			"https://example.invalid/scratch.git",
		]);
		const temp = { ...opts, cwd: scratch };
		changeAgentContext(
			"bind",
			{ workspace: "tedix", projectId: PROJECT },
			temp,
		);
		expect(resolveAgentContext(temp).decisionCapture).toBe(true);
		// The 2026-10-08 cleanup: disable in the scratch repository, then unbind.
		expect(() => runAgentContext(["disable-decision-capture"], temp)).toThrow(
			"including 1 other bound repository. To stop only this repository, run unbind",
		);
		changeAgentContext("unbind", {}, temp);
		expect(resolveAgentContext(temp).status).toBe("unbound");
		expect(resolveAgentContext(opts).decisionCapture).toBe(true);
		// The last bound repository may still turn it off without the flag, and
		// an explicit --organization-wide always may.
		changeAgentContext(
			"bind",
			{ workspace: "tedix", projectId: PROJECT },
			temp,
		);
		runAgentContext(["disable-decision-capture", "--organization-wide"], temp);
		expect(resolveAgentContext(opts).decisionCapture).toBeUndefined();
		expect(() =>
			runAgentContext(["show", "--organization-wide"], opts),
		).toThrow("Unknown, duplicate or missing context option");
	});

	test("show states plainly whether decision capture is on or off", () => {
		const { opts } = fixture();
		bind(opts);
		const printed: string[] = [];
		const log = console.log;
		console.log = (line: string) => printed.push(line);
		try {
			runAgentContext(["show"], opts);
			changeAgentContext("enable-decision-capture", {}, opts);
			runAgentContext(["show"], opts);
		} finally {
			console.log = log;
		}
		expect(printed[0]).toContain(
			"Decision capture: OFF for organization org_tedix; no turns or replies are recorded.",
		);
		expect(printed[1]).toContain(
			"Decision capture: on for organization org_tedix.",
		);
	});

	test("unconfigured directories stay unbound and binding pins explicit profile/project", () => {
		const { opts } = fixture();
		expect(resolveAgentContext(opts)).toEqual({ status: "unbound" });
		expect(() =>
			changeAgentContext("bind", { projectId: PROJECT }, opts),
		).toThrow("requires --workspace");
		expect(bind(opts)).toMatchObject({
			status: "bound",
			workspace: "tedix",
			org: "org_tedix",
			projectId: PROJECT,
		});
		const stored = readFileSync(
			join(opts.configDir, "agent-contexts.json"),
			"utf8",
		);
		expect(stored).not.toContain("private-operator");
	});

	test("selection follows its root and branch, can be cleared, and opt-in can be revoked", () => {
		const { opts } = fixture();
		bind(opts);
		changeAgentContext("select", { workItemId: WORK }, opts);
		const nested = join(opts.cwd, "nested");
		mkdirSync(nested);
		expect(resolveAgentContext({ ...opts, cwd: nested })).toMatchObject({
			workItemId: WORK,
			contextSource: "selection",
		});
		git(opts.cwd, ["switch", "-c", "another"]);
		expect(resolveAgentContext(opts)).toMatchObject({ status: "invalid" });
		expect(changeAgentContext("clear", {}, opts).workItemId).toBeUndefined();
		changeAgentContext("unbind", {}, opts);
		expect(resolveAgentContext(opts)).toEqual({ status: "unbound" });
	});

	test("worktrees recover their existing marker without restoring any executor state", () => {
		const { base, opts } = fixture();
		bind(opts);
		const worktree = join(base, "worktree");
		git(opts.cwd, ["worktree", "add", "-b", "codex/work-test", worktree]);
		writeFileSync(
			`${worktree}.tedix.json`,
			JSON.stringify({
				version: 1,
				branch: "codex/work-test",
				workItemId: WORK,
				attemptId: "advisory",
				agentSession: "codex:other-session",
			}),
		);
		const recovered = resolveAgentContext({ ...opts, cwd: worktree });
		expect(recovered).toMatchObject({
			status: "bound",
			workItemId: WORK,
			contextSource: "worktree",
		});
		expect(JSON.stringify(recovered)).not.toContain("other-session");
		expect(() =>
			changeAgentContext(
				"select",
				{ workItemId: OTHER_WORK },
				{ ...opts, cwd: worktree },
			),
		).toThrow("conflicts");
		git(worktree, ["switch", "-c", "changed"]);
		expect(resolveAgentContext({ ...opts, cwd: worktree }).status).toBe(
			"invalid",
		);
	});

	test("origin/profile drift and implicit retargeting are refused", () => {
		const { opts } = fixture();
		bind(opts);
		git(opts.cwd, [
			"remote",
			"set-url",
			"origin",
			"https://example.invalid/other.git",
		]);
		expect(resolveAgentContext(opts)).toMatchObject({
			status: "invalid",
			message: expect.stringContaining("origin changed"),
		});
		git(opts.cwd, [
			"remote",
			"set-url",
			"origin",
			"https://example.invalid/repo.git",
		]);
		writeWorkspaceCredentials(
			"tedix",
			{
				loginId: "operator",
				org: "org_other",
				mcpUrl: "https://other.mcp.tedix.dev/mcp",
			},
			opts,
		);
		expect(resolveAgentContext(opts)).toMatchObject({
			status: "invalid",
			message: expect.stringContaining("profile changed"),
		});
		expect(() => bind(opts)).toThrow("unbind it explicitly");
	});

	test("other repositories do not inherit a binding and detached selections are rejected", () => {
		const { opts } = fixture();
		bind(opts);
		const other = fixture();
		expect(
			resolveAgentContext({ cwd: other.opts.cwd, configDir: opts.configDir }),
		).toEqual({ status: "unbound" });
		git(opts.cwd, ["switch", "--detach"]);
		expect(() =>
			changeAgentContext("select", { workItemId: WORK }, opts),
		).toThrow("named branch");
	});

	test("local commands reject ambiguous options and require exact UUIDs", () => {
		const { opts } = fixture();
		bind(opts);
		expect(() => runAgentContext(["select", "short-id"], opts)).toThrow(
			"full Work Item UUID",
		);
		expect(() =>
			runAgentContext(["show", "--workspace", "other"], opts),
		).toThrow("only to context bind");
		expect(() =>
			runAgentContext(
				["bind", "--workspace", "tedix", "--workspace", "other"],
				opts,
			),
		).toThrow("duplicate");
	});
	test("shared Output is checkout scoped, preserves Work and can be disconnected", () => {
		const { base, opts } = fixture();
		bind(opts);
		changeAgentContext("select", { workItemId: WORK }, opts);
		const osWorkspaceId = "11111111-1111-4111-8111-111111111111";
		const contextOutputId = "22222222-2222-4222-8222-222222222222";
		expect(
			changeAgentContext(
				"connect-output",
				{ osWorkspaceId, contextOutputId },
				opts,
			),
		).toMatchObject({ workItemId: WORK, osWorkspaceId, contextOutputId });
		const sibling = join(base, "sibling");
		git(opts.cwd, ["worktree", "add", "-b", "codex/sibling", sibling]);
		expect(resolveAgentContext({ ...opts, cwd: sibling })).not.toHaveProperty(
			"contextOutputId",
		);
		expect(changeAgentContext("disconnect-output", {}, opts)).toMatchObject({
			workItemId: WORK,
		});
		expect(resolveAgentContext(opts)).not.toHaveProperty("contextOutputId");
	});
	test("Output selection refuses incomplete ids and warns on branch drift", () => {
		const { opts } = fixture();
		bind(opts);
		expect(() =>
			changeAgentContext("connect-output", { osWorkspaceId: WORK }, opts),
		).toThrow("--output");
		changeAgentContext(
			"connect-output",
			{ osWorkspaceId: WORK, contextOutputId: OTHER_WORK },
			opts,
		);
		git(opts.cwd, ["switch", "-c", "changed"]);
		expect(resolveAgentContext(opts)).toMatchObject({
			status: "invalid",
			message: expect.stringContaining("shared Output branch"),
		});
		expect(changeAgentContext("disconnect-output", {}, opts).status).toBe(
			"bound",
		);
	});
});

describe("Codex chat context isolation", () => {
	const A = "01a0eee2-147e-7493-9c14-e11a4d6d598d";
	const B = "01a0eee0-dfcb-7be2-a8dc-4b36b756227f";
	const C = "01a0f91b-31cb-7733-9098-3a9e28820e30";
	const WA = "12ecbc57-6562-4dfc-9621-d5cd0e2927d7";
	const OA = "205cebd2-a653-4bbc-9753-5553a5d345b6";
	test("two chats sharing checkout retain distinct Work/Outputs and clear independently", () => {
		const { opts } = fixture();
		bind(opts);
		changeAgentContext("select", { workItemId: WORK }, opts);
		const a = { ...opts, sessionId: A },
			b = { ...opts, sessionId: B };
		changeAgentContext("select", { workItemId: WORK }, a);
		changeAgentContext(
			"connect-output",
			{ osWorkspaceId: WA, contextOutputId: OA },
			a,
		);
		changeAgentContext("select", { workItemId: OTHER_WORK }, b);
		expect(resolveAgentContext(a)).toMatchObject({
			workItemId: WORK,
			contextOutputId: OA,
			contextSessionId: A,
			contextSource: "chat",
		});
		expect(resolveAgentContext(b)).toMatchObject({
			workItemId: OTHER_WORK,
			contextSessionId: B,
		});
		expect(
			resolveAgentContext({ ...a, sessionId: A.toUpperCase() }).workItemId,
		).toBe(WORK);
		expect(resolveAgentContext(b).contextOutputId).toBeUndefined();
		expect(
			resolveAgentContext({ ...opts, sessionId: C }).workItemId,
		).toBeUndefined();
		expect(resolveAgentContext(opts).status).toBe("invalid");
		changeAgentContext("clear", {}, a);
		expect(resolveAgentContext(a).workItemId).toBeUndefined();
		expect(resolveAgentContext(a).contextOutputId).toBe(OA);
		expect(resolveAgentContext(b).workItemId).toBe(OTHER_WORK);
		changeAgentContext("disconnect-output", {}, a);
		expect(resolveAgentContext(a).contextOutputId).toBeUndefined();
		expect(resolveAgentContext(a).workItemId).toBeUndefined();
	});
	test("branch drift and malformed identifiers fail without inheriting other chats", () => {
		const { opts } = fixture();
		bind(opts);
		const a = { ...opts, sessionId: A };
		changeAgentContext("select", { workItemId: WORK }, a);
		git(opts.cwd, ["switch", "-c", "different"]);
		expect(resolveAgentContext(a).status).toBe("invalid");
		expect(() =>
			changeAgentContext("select", { workItemId: OTHER_WORK }, a),
		).toThrow("branch changed");
		expect(resolveAgentContext({ ...opts, sessionId: "bad" }).status).toBe(
			"invalid",
		);
		changeAgentContext("clear", {}, a);
		expect(resolveAgentContext(a).workItemId).toBeUndefined();
	});
	test("chat choice cannot bypass governed worktree marker", () => {
		const { opts } = fixture();
		bind(opts);
		writeFileSync(
			`${opts.cwd}.tedix.json`,
			JSON.stringify({ version: 1, branch: "main", workItemId: WORK }),
		);
		expect(() =>
			changeAgentContext(
				"select",
				{ workItemId: OTHER_WORK },
				{ ...opts, sessionId: A },
			),
		).toThrow("conflicts");
	});
});

test("host environment resolves identity and conflicting host identifiers are rejected", () => {
	const { opts } = fixture();
	bind(opts);
	const oldThread = process.env.CODEX_THREAD_ID,
		oldSession = process.env.CODEX_SESSION_ID;
	const id = "01a0eee2-147e-7493-9c14-e11a4d6d598d";
	const automatic = { cwd: opts.cwd, configDir: opts.configDir };
	try {
		process.env.CODEX_THREAD_ID = id;
		process.env.CODEX_SESSION_ID = id;
		changeAgentContext("select", { workItemId: WORK }, automatic);
		expect(resolveAgentContext(automatic)).toMatchObject({
			contextSessionId: id,
			workItemId: WORK,
		});
		process.env.CODEX_SESSION_ID = "01a0eee0-dfcb-7be2-a8dc-4b36b756227f";
		expect(resolveAgentContext(automatic).status).toBe("invalid");
		expect(() => changeAgentContext("clear", {}, automatic)).toThrow(
			"conflicting",
		);
		expect(() =>
			runAgentContext(["show", "--session", "bad"], opts),
		).not.toThrow();
	} finally {
		if (oldThread === undefined) delete process.env.CODEX_THREAD_ID;
		else process.env.CODEX_THREAD_ID = oldThread;
		if (oldSession === undefined) delete process.env.CODEX_SESSION_ID;
		else process.env.CODEX_SESSION_ID = oldSession;
	}
});

describe("chat organization and project connections", () => {
	const A = "01a0eee2-147e-7493-9c14-e11a4d6d598d",
		B = "01a0eee0-dfcb-7be2-a8dc-4b36b756227f",
		OTHER_PROJECT = "451c68cc-5bd3-4cb4-b86b-b0c010f688b7";
	test("two chats retain independent targets and pointers, credential drift affects only its chat", () => {
		const { opts } = fixture();
		bind(opts);
		writeWorkspaceCredentials(
			"customer",
			{
				loginId: "private-customer",
				org: "org_customer",
				mcpUrl: "https://customer.example.invalid/mcp",
			},
			opts,
		);
		const a = { ...opts, sessionId: A },
			b = { ...opts, sessionId: B };
		changeAgentContext(
			"connect",
			{ workspace: "tedix", projectId: PROJECT },
			a,
		);
		changeAgentContext(
			"connect",
			{ workspace: "customer", projectId: OTHER_PROJECT },
			b,
		);
		changeAgentContext("select", { workItemId: WORK }, a);
		changeAgentContext("select", { workItemId: OTHER_WORK }, b);
		expect(resolveAgentContext(a)).toMatchObject({
			workspace: "tedix",
			projectId: PROJECT,
			workItemId: WORK,
		});
		expect(resolveAgentContext(b)).toMatchObject({
			workspace: "customer",
			org: "org_customer",
			mcpUrl: "https://customer.example.invalid/mcp",
			projectId: OTHER_PROJECT,
			workItemId: OTHER_WORK,
		});
		const store = JSON.parse(
			readFileSync(join(opts.configDir, "agent-contexts.json"), "utf8"),
		);
		expect(store.repositories[0]).toMatchObject({
			workspace: "tedix",
			projectId: PROJECT,
		});
		expect(JSON.stringify(store)).not.toContain("private-customer");
		expect(
			resolveAgentContext({
				...opts,
				sessionId: "01a0f91b-31cb-7733-9098-3a9e28820e30",
			}),
		).not.toHaveProperty("workItemId");
		expect(resolveAgentContext(opts).status).toBe("invalid");
		writeWorkspaceCredentials(
			"customer",
			{
				loginId: "operator",
				org: "org_changed",
				mcpUrl: "https://customer.example.invalid/mcp",
			},
			opts,
		);
		expect(resolveAgentContext(b).status).toBe("invalid");
		expect(resolveAgentContext(a).status).toBe("bound");
	});
	test("retargeting refuses existing pointers atomically and clearing retains the target", () => {
		const { opts } = fixture();
		bind(opts);
		const a = { ...opts, sessionId: A };
		changeAgentContext(
			"connect",
			{ workspace: "tedix", projectId: OTHER_PROJECT },
			a,
		);
		changeAgentContext("select", { workItemId: WORK }, a);
		changeAgentContext(
			"connect-output",
			{ osWorkspaceId: WORK, contextOutputId: OTHER_WORK },
			a,
		);
		const path = join(opts.configDir, "agent-contexts.json"),
			before = readFileSync(path, "utf8");
		expect(() =>
			changeAgentContext(
				"connect",
				{ workspace: "tedix", projectId: PROJECT },
				a,
			),
		).toThrow("Clear Work");
		expect(readFileSync(path, "utf8")).toBe(before);
		changeAgentContext("clear", {}, a);
		changeAgentContext("disconnect-output", {}, a);
		expect(resolveAgentContext(a)).toMatchObject({ projectId: OTHER_PROJECT });
		expect(
			changeAgentContext(
				"connect",
				{ workspace: "tedix", projectId: PROJECT },
				a,
			),
		).toMatchObject({ projectId: PROJECT });
	});
	test("clearing stale branch pointers preserves the chat organization and project", () => {
		const { opts } = fixture();
		bind(opts);
		writeWorkspaceCredentials(
			"customer",
			{
				loginId: "operator",
				org: "org_customer",
				mcpUrl: "https://customer.example.invalid/mcp",
			},
			opts,
		);
		const a = { ...opts, sessionId: A };
		changeAgentContext(
			"connect",
			{ workspace: "customer", projectId: OTHER_PROJECT },
			a,
		);
		changeAgentContext("select", { workItemId: OTHER_WORK }, a);
		git(opts.cwd, ["switch", "-c", "changed"]);
		expect(resolveAgentContext(a).status).toBe("invalid");
		expect(changeAgentContext("clear", {}, a)).toMatchObject({
			workspace: "customer",
			org: "org_customer",
			projectId: OTHER_PROJECT,
		});
		expect(resolveAgentContext(a)).not.toHaveProperty("workItemId");
	});
	test("incomplete targets, duplicate rows and unsafe gateways fail closed", () => {
		const { opts } = fixture();
		bind(opts);
		const a = { ...opts, sessionId: A };
		expect(() =>
			changeAgentContext(
				"connect",
				{ workspace: "tedix", projectId: PROJECT },
				opts,
			),
		).toThrow("chat identity");
		expect(() =>
			changeAgentContext("connect", { workspace: "tedix" }, a),
		).toThrow("--project");
		writeWorkspaceCredentials(
			"unsafe",
			{
				loginId: "operator",
				org: "org_other",
				mcpUrl: "http://unsafe.invalid/mcp",
			},
			opts,
		);
		expect(() =>
			changeAgentContext(
				"connect",
				{ workspace: "unsafe", projectId: PROJECT },
				a,
			),
		).toThrow("HTTPS");
		changeAgentContext(
			"connect",
			{ workspace: "tedix", projectId: PROJECT },
			a,
		);
		const path = join(opts.configDir, "agent-contexts.json"),
			store = JSON.parse(readFileSync(path, "utf8"));
		delete store.repositories[0].chats[0].target.org;
		writeFileSync(path, JSON.stringify(store));
		expect(resolveAgentContext(a).status).toBe("invalid");
		store.repositories[0].chats[0].target.org = "org_tedix";
		store.repositories[0].chats.push(store.repositories[0].chats[0]);
		writeFileSync(path, JSON.stringify(store));
		expect(resolveAgentContext(a).status).toBe("invalid");
	});
});

describe("shared Connect context targets", () => {
	function connectProfile(
		opts: ReturnType<typeof fixture>["opts"],
		selected = ["org_tedix", "org_customer"],
	) {
		writeWorkspaceCredentials(
			"connect",
			{
				loginId: "operator",
				org: "incidental_session_tenant",
				mcpUrl: "https://connect.mcp.tedix.dev/mcp",
				oauthTokens: {
					access_token: `e30.${Buffer.from(JSON.stringify({ tedixSelectedOrganizations: selected, dct: "incidental_session_tenant" })).toString("base64url")}.sig`,
					token_type: "Bearer",
				},
			},
			opts,
		);
	}
	test("requires an explicit selected target, never the session tenant", () => {
		const { opts } = fixture();
		connectProfile(opts);
		for (const organization of [
			undefined,
			"incidental_session_tenant",
			"org_unselected",
		])
			expect(() =>
				changeAgentContext(
					"bind",
					{ workspace: "connect", projectId: PROJECT, organization },
					opts,
				),
			).toThrow("selected ID");
		expect(
			changeAgentContext(
				"bind",
				{ workspace: "connect", projectId: PROJECT, organization: "org_tedix" },
				opts,
			),
		).toMatchObject({
			status: "bound",
			org: "org_tedix",
			organization: "org_tedix",
		});
		connectProfile(opts, ["org_customer"]);
		expect(resolveAgentContext(opts).status).toBe("invalid");
	});
	test("one shared login preserves per-organization chat and preference isolation", () => {
		const { opts } = fixture();
		connectProfile(opts);
		changeAgentContext(
			"bind",
			{ workspace: "connect", projectId: PROJECT, organization: "org_tedix" },
			opts,
		);
		const output = "22222222-2222-4222-8222-222222222222";
		changeAgentContext(
			"connect-preferences",
			{ osWorkspaceId: WORK, contextOutputId: output },
			opts,
		);
		const chat = { ...opts, sessionId: OTHER_WORK };
		changeAgentContext(
			"connect",
			{
				workspace: "connect",
				projectId: PROJECT,
				organization: "org_customer",
			},
			chat,
		);
		expect(resolveAgentContext(chat)).toMatchObject({
			org: "org_customer",
			organization: "org_customer",
		});
		expect(resolveAgentContext(chat).preferencesOutputId).toBeUndefined();
		changeAgentContext("select", { workItemId: WORK }, chat);
		expect(() =>
			changeAgentContext(
				"connect",
				{ workspace: "connect", projectId: PROJECT, organization: "org_tedix" },
				chat,
			),
		).toThrow("Clear Work");
	});
	test("a direct-profile chat does not inherit the repository's Connect routing hint", () => {
		const { opts } = fixture();
		connectProfile(opts);
		changeAgentContext(
			"bind",
			{
				workspace: "connect",
				projectId: PROJECT,
				organization: "org_customer",
			},
			opts,
		);
		const chat = { ...opts, sessionId: OTHER_WORK };
		changeAgentContext(
			"connect",
			{ workspace: "tedix", projectId: PROJECT },
			chat,
		);
		expect(resolveAgentContext(chat)).toMatchObject({
			status: "bound",
			workspace: "tedix",
			org: "org_tedix",
		});
		expect(resolveAgentContext(chat).organization).toBeUndefined();
		changeAgentContext("select", { workItemId: WORK }, chat);
		expect(resolveAgentContext(chat).organization).toBeUndefined();
	});
	test("accepts the organization option for bind and rejects it for show", () => {
		const { opts } = fixture();
		connectProfile(opts);
		expect(
			runAgentContext(
				[
					"bind",
					"--workspace",
					"connect",
					"--organization",
					"org_tedix",
					"--project",
					PROJECT,
					"--json",
				],
				opts,
			),
		).toBe(0);
		expect(() =>
			runAgentContext(["show", "--organization", "org_tedix"], opts),
		).toThrow("applies only");
	});
});

describe("default organization outside a bound repository", () => {
	const SECOND = "7c0f1a52-9a7e-4c5e-9a39-2b7f8d1e6a10";
	function connect(
		opts: ReturnType<typeof fixture>["opts"],
		selected: string[],
	) {
		writeWorkspaceCredentials(
			"connect",
			{
				loginId: "operator",
				org: "incidental_session_tenant",
				mcpUrl: "https://connect.mcp.tedix.dev/mcp",
				oauthTokens: {
					access_token: `e30.${Buffer.from(JSON.stringify({ tedixSelectedOrganizations: selected })).toString("base64url")}.sig`,
					token_type: "Bearer",
				},
			},
			opts,
		);
	}
	function outside(
		opts: ReturnType<typeof fixture>["opts"],
		env: Record<string, string>,
	) {
		return {
			configDir: opts.configDir,
			cwd: join(opts.cwd, ".."),
			sessionId: null,
			env,
		};
	}

	test("is opt-in per caller and names no repository", () => {
		const { opts } = fixture();
		const away = outside(opts, { TEDIX_WORKSPACE: "tedix" });
		expect(resolveAgentContext(away).status).toBe("unbound");
		const resolved = resolveAgentContext({ ...away, allowDefault: true });
		expect(resolved).toEqual({
			status: "bound",
			contextSource: "default",
			workspace: "tedix",
			org: "org_tedix",
			mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
		});
		// A bound checkout keeps its own binding.
		bind(opts);
		expect(resolveAgentContext({ ...opts, allowDefault: true })).toMatchObject({
			status: "bound",
			projectId: PROJECT,
		});
		expect(
			resolveAgentContext({ ...opts, allowDefault: true }).contextSource,
		).toBeUndefined();
	});

	test("carries the same organization's working-preferences document", () => {
		const { opts } = fixture();
		bind(opts);
		const workspaceId = "11111111-1111-4111-8111-111111111111";
		const preferenceId = "22222222-2222-4222-8222-222222222222";
		changeAgentContext(
			"connect-preferences",
			{ osWorkspaceId: workspaceId, contextOutputId: preferenceId },
			opts,
		);
		const away = outside(opts, { TEDIX_WORKSPACE: "tedix" });
		expect(resolveAgentContext({ ...away, allowDefault: true })).toMatchObject({
			contextSource: "default",
			org: "org_tedix",
			preferencesWorkspaceId: workspaceId,
			preferencesOutputId: preferenceId,
		});
		// Another organization's default never borrows it.
		connect(opts, ["org_customer"]);
		expect(
			resolveAgentContext({
				...outside(opts, { TEDIX_WORKSPACE: "connect" }),
				allowDefault: true,
			}),
		).not.toHaveProperty("preferencesOutputId");
	});

	test("never guesses among several organizations", () => {
		const { opts } = fixture();
		connect(opts, ["org_tedix", "org_customer"]);
		const resolve = (env: Record<string, string>) =>
			resolveAgentContext({ ...outside(opts, env), allowDefault: true });
		expect(resolve({ TEDIX_WORKSPACE: "connect" }).status).toBe("unbound");
		expect(
			resolve({
				TEDIX_WORKSPACE: "connect",
				TEDIX_ORGANIZATION: "org_unselected",
			}).status,
		).toBe("unbound");
		expect(
			resolve({
				TEDIX_WORKSPACE: "connect",
				TEDIX_ORGANIZATION: "org_customer",
			}),
		).toMatchObject({
			status: "bound",
			contextSource: "default",
			org: "org_customer",
			organization: "org_customer",
		});
		connect(opts, ["org_customer"]);
		expect(resolve({ TEDIX_WORKSPACE: "connect" })).toMatchObject({
			org: "org_customer",
			organization: "org_customer",
		});
		// A tenant profile serves only its own organization.
		expect(
			resolve({ TEDIX_WORKSPACE: "tedix", TEDIX_ORGANIZATION: "org_other" })
				.status,
		).toBe("unbound");
	});

	test("a saved default organization serves several while still selected", () => {
		const { opts } = fixture();
		connect(opts, ["org_tedix", "org_customer", "personal_operator"]);
		const away = (env: Record<string, string> = {}) => ({
			...outside(opts, env),
			allowDefault: true,
		});
		// Several organizations and no default: idle.
		expect(resolveAgentContext(away()).status).toBe("unbound");
		expect(() =>
			runAgentContext(
				[
					"set-default-organization",
					"org_unselected",
					"--workspace",
					"connect",
				],
				away(),
			),
		).toThrow("not an organization this profile selected");
		expect(() => runAgentContext(["set-default-organization"], away())).toThrow(
			"or --clear",
		);
		// A slug names org_<slug>; the exact ID is stored.
		expect(
			runAgentContext(
				["set-default-organization", "customer", "--workspace", "connect"],
				away(),
			),
		).toBe(0);
		expect(
			JSON.parse(
				readFileSync(join(opts.configDir, "agent-contexts.json"), "utf8"),
			).defaultOrganization,
		).toEqual({ workspace: "connect", organization: "org_customer" });
		expect(resolveAgentContext(away())).toMatchObject({
			status: "bound",
			contextSource: "default",
			workspace: "connect",
			org: "org_customer",
			organization: "org_customer",
		});
		// Explicit environment still wins.
		expect(
			resolveAgentContext(
				away({ TEDIX_WORKSPACE: "connect", TEDIX_ORGANIZATION: "org_tedix" }),
			).org,
		).toBe("org_tedix");
		// Another profile ignores a default saved for connect.
		expect(resolveAgentContext(away({ TEDIX_WORKSPACE: "tedix" })).org).toBe(
			"org_tedix",
		);
		// Decision capture outside a repository follows the default.
		expect(
			changeAgentContext(
				"enable-decision-capture",
				{ projectId: SECOND },
				away(),
			),
		).toMatchObject({
			org: "org_customer",
			decisionCapture: true,
			projectId: SECOND,
		});
		// A bound repository keeps its own binding.
		bind(opts);
		expect(resolveAgentContext({ ...opts, allowDefault: true })).toMatchObject({
			workspace: "tedix",
			projectId: PROJECT,
		});
		// Once the login no longer selects it, nothing is guessed.
		connect(opts, ["org_tedix", "personal_operator"]);
		expect(resolveAgentContext(away()).status).toBe("unbound");
		connect(opts, ["org_tedix"]);
		expect(resolveAgentContext(away()).status).toBe("unbound");
		connect(opts, ["org_customer", "org_tedix"]);
		expect(resolveAgentContext(away()).org).toBe("org_customer");
		expect(
			runAgentContext(["set-default-organization", "--clear"], away()),
		).toBe(0);
		expect(resolveAgentContext(away()).status).toBe("unbound");
		expect(
			JSON.parse(
				readFileSync(join(opts.configDir, "agent-contexts.json"), "utf8"),
			).defaultOrganization,
		).toBeUndefined();
	});

	test("captures only with the organization's opt-in and one project inbox", () => {
		const { opts } = fixture();
		const away = {
			...outside(opts, { TEDIX_WORKSPACE: "tedix" }),
			allowDefault: true,
		};
		bind(opts);
		expect(resolveAgentContext(away).decisionCapture).toBeUndefined();
		changeAgentContext("enable-decision-capture", {}, opts);
		// The repository opt-in and its one bound project carry over.
		expect(resolveAgentContext(away)).toMatchObject({
			decisionCapture: true,
			projectId: PROJECT,
		});
		// A second project of the organization makes the inbox ambiguous.
		const other = join(opts.cwd, "..", "other");
		mkdirSync(other);
		git(other, ["init", "-b", "main"]);
		git(other, ["remote", "add", "origin", "https://example.invalid/b.git"]);
		changeAgentContext(
			"bind",
			{ workspace: "tedix", projectId: SECOND },
			{ ...opts, cwd: other },
		);
		const ambiguous = resolveAgentContext(away);
		expect(ambiguous.decisionCapture).toBeUndefined();
		expect(ambiguous.projectId).toBeUndefined();
		// Enabling outside a repository pins the inbox; re-enabling inside a
		// repository keeps it; disabling anywhere stops it.
		expect(
			changeAgentContext(
				"enable-decision-capture",
				{ projectId: SECOND },
				away,
			),
		).toMatchObject({ decisionCapture: true, projectId: SECOND });
		changeAgentContext("enable-decision-capture", {}, opts);
		expect(resolveAgentContext(away).projectId).toBe(SECOND);
		// Two repositories are bound, so stopping it org-wide must be confirmed.
		expect(() =>
			changeAgentContext("disable-decision-capture", {}, away),
		).toThrow("--organization-wide");
		expect(resolveAgentContext(opts).decisionCapture).toBe(true);
		changeAgentContext(
			"disable-decision-capture",
			{ organizationWide: true },
			away,
		);
		expect(resolveAgentContext(opts).decisionCapture).toBeUndefined();
		expect(() =>
			changeAgentContext(
				"enable-decision-capture",
				{},
				{ ...away, env: { TEDIX_WORKSPACE: "missing" } },
			),
		).toThrow("No single organization");
	});

	test("inside an unbound Git repository only a same-owner binding names the organization", () => {
		const { opts } = fixture();
		connect(opts, ["org_tedix", "org_customer"]);
		runAgentContext(
			["set-default-organization", "org_tedix", "--workspace", "connect"],
			{ ...outside(opts, {}), allowDefault: true },
		);
		function repo(name: string, origin?: string) {
			const cwd = join(opts.cwd, "..", name);
			mkdirSync(cwd);
			git(cwd, ["init", "-b", "main"]);
			if (origin) git(cwd, ["remote", "add", "origin", origin]);
			return { ...opts, cwd, env: {}, allowDefault: true };
		}
		// No binding anywhere: the saved default applies outside Git only.
		expect(
			resolveAgentContext({ ...outside(opts, {}), allowDefault: true }),
		).toMatchObject({ contextSource: "default", org: "org_tedix" });
		const customer = repo("customer-app", "git@github.com:customer/app.git");
		expect(resolveAgentContext(customer)).toEqual({ status: "unbound" });
		expect(resolveAgentContext(repo("loose"))).toEqual({ status: "unbound" });
		// A bound sibling of the same owner names its organization.
		changeAgentContext(
			"bind",
			{ workspace: "connect", organization: "org_customer", projectId: SECOND },
			repo("customer-api", "https://github.com/Customer/api"),
		);
		expect(resolveAgentContext(customer)).toMatchObject({
			status: "bound",
			contextSource: "default",
			workspace: "connect",
			org: "org_customer",
			organization: "org_customer",
		});
		// Another owner stays idle despite the default.
		const other = repo("other-app", "https://github.com/someone/app.git");
		expect(resolveAgentContext(other)).toEqual({ status: "unbound" });
		// Same-owner bindings in two organizations: never a guess.
		changeAgentContext(
			"bind",
			{ workspace: "connect", organization: "org_tedix", projectId: PROJECT },
			repo("customer-web", "https://github.com/customer/web.git"),
		);
		expect(resolveAgentContext(customer)).toEqual({ status: "unbound" });
		expect(resolveAgentContext({ ...customer, allowDefault: false })).toEqual({
			status: "unbound",
		});
	});
});

test("Claude Code session id selects chat context and conflicts with a different Codex chat", () => {
	const { opts } = fixture();
	bind(opts);
	const saved = {
		claude: process.env.CLAUDE_CODE_SESSION_ID,
		thread: process.env.CODEX_THREAD_ID,
		session: process.env.CODEX_SESSION_ID,
	};
	const claude = "3a7952ab-c045-4521-830c-be30b0b69c03";
	const automatic = { cwd: opts.cwd, configDir: opts.configDir };
	try {
		delete process.env.CODEX_THREAD_ID;
		delete process.env.CODEX_SESSION_ID;
		process.env.CLAUDE_CODE_SESSION_ID = claude.toUpperCase();
		changeAgentContext("select", { workItemId: WORK }, automatic);
		expect(resolveAgentContext(automatic)).toMatchObject({
			contextSessionId: claude,
			workItemId: WORK,
			contextSource: "chat",
		});
		// The same checkout seen from a Codex chat does not inherit the selection.
		delete process.env.CLAUDE_CODE_SESSION_ID;
		process.env.CODEX_THREAD_ID = "01a0eee2-147e-7493-9c14-e11a4d6d598d";
		expect(resolveAgentContext(automatic).workItemId).toBeUndefined();
		process.env.CLAUDE_CODE_SESSION_ID = claude;
		expect(resolveAgentContext(automatic).status).toBe("invalid");
	} finally {
		for (const [name, value] of [
			["CLAUDE_CODE_SESSION_ID", saved.claude],
			["CODEX_THREAD_ID", saved.thread],
			["CODEX_SESSION_ID", saved.session],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});
