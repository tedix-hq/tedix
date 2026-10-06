import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { detachedGitEnv } from "../../../scripts/oss/git-env";
import {
	changeAgentContext,
	resolveAgentContext,
	runAgentContext,
} from "./agent-context";
import { writeWorkspaceCredentials } from "./credential-store";

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
