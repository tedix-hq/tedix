import assert from "node:assert/strict";
import { MCP_FACET_TURN_INPUT, mcpFacetTurnProbe } from "../test/tedi-do";
import { configuredRuntimeTools } from "./configured-tool-surface";
import { supervisedDelegationToolSet } from "./delegation-authority";
import {
	repositoryReadTools,
	type RepositoryConnection,
} from "./repository-read-tools";
import {
	selectTrustedTurnTools,
	untrustedTurnToolAllowlist,
} from "./turn-trust";

type Execute = (input: unknown, options: unknown) => Promise<any>;
type Reply = {
	status?: number;
	headers?: Record<string, string>;
	body: unknown;
};

const TOKEN = "fictional-token-value";
const SHA = "a".repeat(40);
const acme: RepositoryConnection = {
	ok: true,
	owner: "acme",
	repo: "shop",
	branch: "main",
	token: TOKEN,
};
const FENCE_OPEN = "<<<external_repository>>>\n";
const FENCE_CLOSE = "\n<<<end_external_repository>>>";
const fencedText = (text: string) => `${FENCE_OPEN}${text}${FENCE_CLOSE}`;

/** Tools over a scripted code host; every request is recorded. */
function build(
	routes: (url: URL) => Reply | undefined,
	connection: RepositoryConnection = acme,
) {
	const requests: { url: URL; init: RequestInit }[] = [];
	const tools = repositoryReadTools({
		connection: async () => connection,
		fetch: (async (input: unknown, init: RequestInit = {}) => {
			const url = new URL(String(input));
			requests.push({ url, init });
			const reply = routes(url) ?? { status: 404, body: {} };
			return new Response(
				typeof reply.body === "string"
					? reply.body
					: JSON.stringify(reply.body),
				{
					status: reply.status ?? 200,
					headers: {
						"content-type":
							typeof reply.body === "string"
								? "application/vnd.github.raw+json; charset=utf-8"
								: "application/json; charset=utf-8",
						...reply.headers,
					},
				},
			);
		}) as typeof fetch,
	});
	const run = (name: keyof typeof tools, input: unknown) =>
		(tools[name].execute as Execute)(input, {});
	return { tools, run, requests };
}

const NAMES = [
	"search_repository_code",
	"read_repository_file",
	"list_repository_commits",
	"read_repository_commit",
	"read_ci_status",
] as const;
assert.deepEqual(Object.keys(build(() => undefined).tools), [...NAMES]);

// Search covers the connected repository only, returns fenced excerpts, and
// drops a result that names another repository.
{
	const { run, requests } = build((url) =>
		url.pathname === "/search/code"
			? {
					body: {
						total_count: 2,
						items: [
							{
								path: "src/cart.ts",
								repository: { full_name: "Acme/Shop" },
								text_matches: [
									{ property: "content", fragment: "x".repeat(900) },
									{ property: "path", fragment: "src/cart.ts" },
								],
							},
							{
								path: "secret.ts",
								repository: { full_name: "other/private" },
								text_matches: [{ property: "content", fragment: "leak" }],
							},
						],
					},
				}
			: undefined,
	);
	const result = await run("search_repository_code", {
		query: "addToCart",
		pathPrefix: "src/",
	});
	assert.equal(result.kind, "repository_code_search");
	assert.equal(result.repository, "acme/shop");
	assert.deepEqual(result.files, [
		{ path: "src/cart.ts", excerpts: [fencedText(`${"x".repeat(400)}…`)] },
	]);
	assert.equal(result.truncated, true);
	const request = requests[0]!;
	assert.equal(
		request.url.searchParams.get("q"),
		"addToCart repo:acme/shop path:src",
	);
	// Every request is a GET that does not follow redirects, and the token
	// travels only in the header.
	assert.equal(request.init.method, "GET");
	assert.equal(request.init.redirect, "manual");
	assert.equal(request.url.toString().includes(TOKEN), false);
	assert.equal(JSON.stringify(result).includes(TOKEN), false);

	// A query cannot widen the search to another repository.
	const widened = await run("search_repository_code", {
		query: "password repo:other/private",
	});
	assert.equal(widened.kind, "repository_error");
	assert.equal(requests.length, 1);
}

// A file comes back as numbered, fenced lines within the line, character and
// byte bounds; a range reads another part.
{
	const text = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join(
		"\n",
	);
	const { run, requests } = build((url) =>
		url.pathname === "/repos/acme/shop/contents/src/a%20b.ts"
			? { body: `${text}\n` }
			: url.pathname === "/repos/acme/shop/contents/big.txt"
				? { body: "y".repeat(1_200_000) }
				: url.pathname === "/repos/acme/shop/contents/wide.txt"
					? { body: Array(400).fill("z".repeat(600)).join("\n") }
					: url.pathname === "/repos/acme/shop/contents/logo.png"
						? { body: "PNG\u0000\u0000" }
						: url.pathname === "/repos/acme/shop/contents/src"
							? {
									body: [
										{ name: "a b.ts", type: "file" },
										{ name: "lib", type: "dir" },
									],
								}
							: undefined,
	);
	const head = await run("read_repository_file", { path: "/src/a b.ts" });
	assert.equal(head.kind, "repository_file");
	assert.equal(head.startLine, 1);
	assert.equal(head.endLine, 400);
	assert.equal(head.totalLines, 1000);
	assert.equal(head.truncated, true);
	assert.ok(head.text.startsWith(`${FENCE_OPEN}1: line 1\n2: line 2\n`));
	assert.ok(head.text.endsWith(`400: line 400${FENCE_CLOSE}`));
	assert.equal(requests[0]!.url.searchParams.get("ref"), "main");

	const part = await run("read_repository_file", {
		path: "src/a b.ts",
		startLine: 990,
		endLine: 2000,
		ref: "release/1.2",
	});
	assert.equal(part.endLine, 1000);
	assert.equal(part.truncated, false);
	assert.equal(requests[1]!.url.searchParams.get("ref"), "release/1.2");

	const past = await run("read_repository_file", {
		path: "src/a b.ts",
		startLine: 1001,
	});
	assert.equal(past.kind, "repository_error");

	const big = await run("read_repository_file", { path: "big.txt" });
	assert.equal(big.totalLines, null);
	assert.equal(big.truncated, true);
	assert.ok(big.text.length < 1_000);

	const wide = await run("read_repository_file", { path: "wide.txt" });
	assert.ok(wide.text.length <= 40_000 + 100);
	assert.ok(wide.endLine < 400);
	assert.equal(wide.truncated, true);

	assert.equal(
		(await run("read_repository_file", { path: "logo.png" })).kind,
		"repository_error",
	);
	assert.deepEqual(
		(await run("read_repository_file", { path: "src" })).entries,
		[
			{ name: "a b.ts", type: "file" },
			{ name: "lib", type: "folder" },
		],
	);

	// A path or ref that could leave the repository is refused unsent.
	const sent = requests.length;
	for (const bad of [
		{ path: "../other/secrets" },
		{ path: "src/../../x" },
		{ path: "a.ts", ref: "main/../../../orgs/acme" },
		{ path: "a.ts", ref: "main?x=1" },
	])
		assert.equal(
			(await run("read_repository_file", bad)).kind,
			"repository_error",
		);
	assert.equal(requests.length, sent);
}

// Commits: bounded list with the Work-Item trailer, then one commit with a
// bounded diff.
{
	const workItem = "33333333-3333-4333-8333-333333333333";
	const commit = (n: number) => ({
		sha: String(n).padStart(40, "0"),
		commit: {
			message: `Fix ${"s".repeat(300)}\n\nBody\n\nWork-Item: ${workItem}\nAgent-Session: x`,
			author: { name: "A Developer", date: "2026-11-19T10:00:00Z" },
		},
	});
	const { run, requests } = build((url) =>
		url.pathname === "/repos/acme/shop/commits"
			? { body: Array.from({ length: 40 }, (_, i) => commit(i)) }
			: url.pathname === `/repos/acme/shop/commits/${SHA}`
				? {
						body: {
							...commit(1),
							sha: SHA,
							stats: { additions: 9, deletions: 4 },
							files: [
								...Array.from({ length: 120 }, (_, i) => ({
									filename: `src/f${i}.ts`,
									status: "modified",
									additions: 1,
									deletions: 0,
									patch: `@@ -1 +1 @@\n+${"p".repeat(7_000)}`,
								})),
							],
						},
					}
				: undefined,
	);
	const list = await run("list_repository_commits", {
		path: "src/cart.ts",
		limit: 30,
	});
	assert.equal(list.kind, "repository_commits");
	assert.equal(list.commits.length, 30);
	assert.equal(list.commits[0].workItemId, workItem);
	assert.equal(list.commits[0].authoredAt, "2026-11-19T10:00:00Z");
	assert.equal(list.commits[0].subject, fencedText(`Fix ${"s".repeat(196)}…`));
	assert.equal(requests[0]!.url.searchParams.get("per_page"), "30");
	assert.equal(requests[0]!.url.searchParams.get("path"), "src/cart.ts");
	assert.equal(requests[0]!.url.searchParams.get("sha"), "main");
	assert.equal(
		rejectsInput(build(() => undefined).tools.list_repository_commits, {
			limit: 31,
		}),
		true,
	);

	const one = await run("read_repository_commit", { sha: SHA.toUpperCase() });
	assert.equal(one.kind, "repository_commit");
	assert.equal(one.workItemId, workItem);
	assert.equal(one.files.length, 100);
	assert.equal(one.filesTruncated, true);
	assert.deepEqual(one.files[0], {
		path: "src/f0.ts",
		status: "modified",
		linesAdded: 1,
		linesRemoved: 0,
	});
	assert.equal(one.diffTruncated, true);
	assert.ok(one.diff.length <= 30_000 + 100);
	assert.ok(one.diff.startsWith(`${FENCE_OPEN}--- src/f0.ts\n@@ -1 +1 @@`));
	assert.ok(one.message.startsWith(`${FENCE_OPEN}Fix `));
	assert.equal(
		rejectsInput(build(() => undefined).tools.read_repository_commit, {
			sha: "main; rm -rf",
		}),
		true,
	);
}

function rejectsInput(tool: { inputSchema: unknown }, input: unknown) {
	return !(
		tool.inputSchema as { safeParse(v: unknown): { success: boolean } }
	).safeParse(input).success;
}

// CI: the newest run of each workflow for the head of the default branch,
// failed jobs with their failed steps and first reported errors.
{
	const { run, requests } = build((url) => {
		const path = url.pathname;
		if (path === "/repos/acme/shop/commits/main") return { body: SHA };
		if (path === "/repos/acme/shop/actions/runs")
			return {
				body: {
					workflow_runs: [
						{
							id: 12,
							workflow_id: 1,
							name: "Tests",
							status: "completed",
							conclusion: "failure",
							html_url: "https://example.test/runs/12",
							run_started_at: "2026-11-19T10:05:00Z",
						},
						{
							id: 11,
							workflow_id: 1,
							name: "Tests",
							status: "completed",
							conclusion: "success",
						},
						{
							id: 10,
							workflow_id: 2,
							name: "Lint",
							status: "in_progress",
							conclusion: null,
						},
					],
				},
			};
		if (path === "/repos/acme/shop/actions/runs/12/jobs")
			return {
				body: {
					jobs: [
						{ id: 70, name: "build", conclusion: "success", steps: [] },
						{
							id: 71,
							name: "unit",
							conclusion: "failure",
							steps: [
								{ name: "Install", conclusion: "success" },
								{ name: "Run tests", conclusion: "failure" },
							],
						},
					],
				},
			};
		if (path === "/repos/acme/shop/check-runs/71/annotations")
			return {
				body: [
					{ annotation_level: "warning", message: "old runtime" },
					{
						annotation_level: "failure",
						path: "src/cart.test.ts",
						start_line: 42,
						message: `expected 2, got 3 ${"e".repeat(400)}`,
					},
					{
						annotation_level: "failure",
						path: ".github",
						start_line: 1,
						message: "Process completed with exit code 1.",
					},
				],
			};
		return undefined;
	});
	const status = await run("read_ci_status", {});
	assert.equal(status.kind, "ci_status");
	assert.equal(status.sha, SHA);
	assert.equal(status.overall, "failing");
	assert.equal(requests[1]!.url.searchParams.get("head_sha"), SHA);
	assert.deepEqual(status.workflows, [
		{
			workflow: "Tests",
			status: "completed",
			result: "failure",
			startedAt: "2026-11-19T10:05:00Z",
			url: "https://example.test/runs/12",
			failedJobs: [
				{
					name: "unit",
					failedSteps: ["Run tests"],
					firstErrors: fencedText(
						`src/cart.test.ts:42: ${`expected 2, got 3 ${"e".repeat(400)}`.slice(0, 300)}…\nProcess completed with exit code 1.`,
					),
				},
			],
		},
		{
			workflow: "Lint",
			status: "in_progress",
			result: null,
			startedAt: null,
			url: null,
		},
	]);
}
// The number of failed workflows, jobs and error reads is capped, so one
// status read cannot fan out without limit.
{
	const { run, requests } = build((url) => {
		const path = url.pathname;
		if (path === `/repos/acme/shop/commits/${SHA.slice(0, 7)}`)
			return { body: SHA };
		if (path === "/repos/acme/shop/actions/runs")
			return {
				body: {
					workflow_runs: Array.from({ length: 30 }, (_, i) => ({
						id: i,
						workflow_id: i,
						name: `W${i}`,
						status: "completed",
						conclusion: "failure",
					})),
				},
			};
		if (path.endsWith("/jobs"))
			return {
				body: {
					jobs: Array.from({ length: 9 }, (_, i) => ({
						id: 100 + i,
						name: `j${i}`,
						conclusion: "failure",
					})),
				},
			};
		// Annotations fail: the job names still come back.
		return { status: 403, body: {} };
	});
	const status = await run("read_ci_status", { sha: SHA.slice(0, 7) });
	assert.equal(status.workflows.length, 20);
	assert.equal(status.truncated, true);
	assert.equal(
		status.workflows.filter((w: { failedJobs?: unknown }) => w.failedJobs)
			.length,
		5,
	);
	assert.equal(status.workflows[0].failedJobs.length, 5);
	assert.equal("firstErrors" in status.workflows[0].failedJobs[0], false);
	// 1 commit + 1 runs + 5 job lists + 8 error reads.
	assert.equal(requests.length, 15);

	const none = build((url) =>
		url.pathname.includes("/commits/")
			? { body: SHA }
			: { body: { workflow_runs: [] } },
	);
	assert.equal((await none.run("read_ci_status", {})).overall, "no_runs");
}

// Only the connected repository can be read. Another organization's tedi has
// its own connection and reaches only its own repository; a tedi without a
// connection reaches nothing.
{
	const { run, requests } = build(() => ({ body: [] }));
	for (const repository of [
		"other/private",
		"https://github.com/other/private",
		"acme/shop-internal",
		"https://evil.example/acme/shop/../../x",
	]) {
		const refused = await run("list_repository_commits", { repository });
		assert.equal(refused.kind, "repository_error");
		assert.match(refused.message, /not connected to this tedi/);
	}
	assert.equal(requests.length, 0);
	for (const repository of ["Acme/Shop", "https://github.com/acme/shop.git"])
		assert.equal(
			(await run("list_repository_commits", { repository })).kind,
			"repository_commits",
		);
	assert.ok(
		requests.every((r) => r.url.pathname === "/repos/acme/shop/commits"),
	);

	const other = build(() => ({ body: [] }), {
		ok: true,
		owner: "globex",
		repo: "site",
		token: "second-fictional-token",
	});
	assert.equal(
		(await other.run("list_repository_commits", { repository: "acme/shop" }))
			.kind,
		"repository_error",
	);
	await other.run("list_repository_commits", {});
	assert.deepEqual(
		other.requests.map((r) => r.url.pathname),
		["/repos/globex/site/commits"],
	);
	assert.equal(
		new Headers(other.requests[0]!.init.headers).get("authorization"),
		"Bearer second-fictional-token",
	);

	for (const error of ["no_repo_config", "no_github_pat", "anything_else"]) {
		const none = build(() => ({ body: [] }), { ok: false, error });
		for (const [name, input] of [
			["search_repository_code", { query: "cart" }],
			["read_repository_file", { path: "a.ts" }],
			["list_repository_commits", {}],
			["read_repository_commit", { sha: SHA }],
			["read_ci_status", {}],
		] as const)
			assert.equal((await none.run(name, input)).kind, "repository_error");
		assert.equal(none.requests.length, 0);
	}
}

// A refusal from the code host comes back in plain words and never carries
// the token, the address asked for or the host's own text.
{
	for (const [status, headers, expected] of [
		[401, {}, /refused the stored access token/],
		[403, {}, /does not allow this read/],
		[403, { "x-ratelimit-remaining": "0" }, /limiting requests/],
		[404, {}, /Not found/],
		[302, { location: "https://evil.example/" }, /has moved/],
		[500, {}, /HTTP 500/],
	] as [number, Record<string, string>, RegExp][]) {
		const { run, requests } = build(() => ({
			status,
			headers,
			body: { message: `host says ${TOKEN}` },
		}));
		const result = await run("read_repository_commit", { sha: SHA });
		assert.equal(result.kind, "repository_error");
		assert.match(result.message, expected);
		assert.equal(JSON.stringify(result).includes(TOKEN), false);
		// A redirect is reported, never followed.
		assert.equal(requests.length, 1);
	}
}

// Availability follows the same ceilings as the neighbouring tools: the
// tedi's stored tool list, the delegated-child surface and turn trust.
{
	const { tools } = build(() => undefined);
	assert.deepEqual(
		Object.keys(configuredRuntimeTools(tools, undefined)),
		Object.keys(tools),
	);
	assert.deepEqual(
		Object.keys(configuredRuntimeTools(tools, ["read_ci_status", "read"])),
		["read_ci_status"],
	);
	assert.deepEqual(supervisedDelegationToolSet(tools, true), {});
	// An unverified author is never offered them: not by email, Telegram or an
	// MCP caller, and not in the embedded widget, whose wider allowlist names
	// none of them.
	for (const channel of ["email", "telegram", "widget", "mcp"] as const) {
		const allowlist = untrustedTurnToolAllowlist(channel);
		for (const name of NAMES) assert.equal(allowlist.has(name), false);
		assert.deepEqual(
			selectTrustedTurnTools({ trust: "untrusted", full: tools, allowlist }),
			{},
		);
	}
}

// A tedi's own trusted turn offers the tools; an untrusted turn and a
// delegated child's turn do not. (The embedded widget is always untrusted and
// filters by the widget allowlist checked above.)
{
	const probe = (extra: Record<string, unknown> = {}) =>
		mcpFacetTurnProbe({
			platform: { setEpisodeTrace() {} },
		}).prepareMcpFacetTurn({
			...MCP_FACET_TURN_INPUT,
			toolsOnly: true,
			...extra,
		});
	const own = await probe({ sessionKey: "agent:main:chat-7" });
	for (const name of NAMES) assert.ok(name in own.tools);
	// With no stored connection the offered tool answers plainly and sends
	// nothing.
	assert.equal(
		(await (own.tools.read_ci_status!.execute as Execute)({}, {})).kind,
		"repository_error",
	);
	const untrusted = await probe({ trust: "untrusted" });
	const delegated = await probe({
		workItemId: "3f1c2a1e-0000-4000-8000-000000000001",
		homeRunId: "home-1",
	});
	// A tedi the person picked in the chat runs as a delegation and keeps them,
	// unless that turn is untrusted.
	const picked = {
		workItemId: "3f1c2a1e-0000-4000-8000-000000000001",
		homeRunId: "home-1",
		personChatConversationId: "home:os:chat-7",
	};
	const pickedInChat = await probe(picked);
	const pickedUntrusted = await probe({ ...picked, trust: "untrusted" });
	for (const name of NAMES) {
		assert.equal(name in untrusted.tools, false);
		assert.equal(name in delegated.tools, false);
		assert.ok(name in pickedInChat.tools);
		assert.equal(name in pickedUntrusted.tools, false);
	}
}

console.log("repository-read-tools.test.ts: repository read tools passed");
