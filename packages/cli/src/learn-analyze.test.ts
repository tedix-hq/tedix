import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import type { OrganizationTarget } from "./agent-context";
import { normalizeGitOrigin } from "./agent-context";
import {
	CATEGORIES,
	claudeSignals,
	codexEvents,
	commandHead,
	decisionLog,
	extractDecisions,
	frictionHotspots,
	projectFor,
	renderDescription,
	repeatedRequests,
	runAnalyzeSessions,
	searchCommand,
	syncSource,
	type ToolEvent,
} from "./learn-analyze";

const T = (day: number, minute = 0) =>
	`2026-03-${String(day).padStart(2, "0")}T10:${String(minute).padStart(2, "0")}:00.000Z`;

const ORIGIN = "git@github.com:acme-co/acme.git";
const TARGET: OrganizationTarget = {
	workspace: "acme",
	org: "acme",
	organization: "org_acme",
	mcpUrl: "https://mcp.example.test",
};

/** A fictional Codex rollout: one ask, one failing test run, one denied deploy. */
function codexRollout(id: string, day: number, ask: string) {
	return [
		{
			type: "session_meta",
			timestamp: T(day),
			payload: {
				id,
				session_id: id,
				cwd: "/nowhere/acme",
				thread_source: "user",
				git: { repository_url: ORIGIN, branch: "main" },
			},
		},
		{
			type: "response_item",
			timestamp: T(day, 1),
			payload: {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: ask }],
			},
		},
		{
			type: "response_item",
			timestamp: T(day, 2),
			payload: {
				type: "function_call",
				name: "exec_command",
				call_id: `${id}-a`,
				arguments: JSON.stringify({ cmd: "cd app && bun run test:run" }),
			},
		},
		{
			type: "response_item",
			timestamp: T(day, 3),
			payload: {
				type: "function_call_output",
				call_id: `${id}-a`,
				output:
					"Exit code: 1\nWall time: 3 seconds\nOutput:\nFAIL src/report.test.ts > totals\n",
			},
		},
		{
			type: "response_item",
			timestamp: T(day, 4),
			payload: {
				type: "function_call",
				name: "exec_command",
				call_id: `${id}-b`,
				arguments: JSON.stringify({ cmd: "bun deploy.ts web" }),
			},
		},
		{
			type: "response_item",
			timestamp: T(day, 5),
			payload: {
				type: "function_call_output",
				call_id: `${id}-b`,
				output:
					"Exit code: 1\nrefusing to deploy: no credential on the environment",
			},
		},
	];
}

describe("commandHead", () => {
	it("keeps the first three meaningful words and drops flag values, paths and env", () => {
		expect(
			commandHead("cd /work/acme && bun run --cwd packages/app test:run"),
		).toBe("bun run test:run");
		expect(commandHead("TOKEN=abc git -C /work push origin HEAD:main")).toBe(
			"git push origin",
		);
		expect(commandHead("/usr/bin/curl https://api.example.test/v1?key=1")).toBe(
			"curl api.example.test",
		);
		expect(commandHead('rg -n "needle" src')).toBe("rg");
	});
});

describe("claudeSignals", () => {
	it("records asks, failures, denials and treats a no-match search as success", () => {
		const rows = [
			{
				type: "user",
				sessionId: "c-1",
				cwd: "/work/acme",
				timestamp: T(2),
				message: { role: "user", content: "status now?" },
			},
			{
				type: "assistant",
				timestamp: T(2, 1),
				message: {
					content: [
						{
							type: "tool_use",
							id: "t1",
							name: "Bash",
							input: { command: "rg needle src" },
						},
						{
							type: "tool_use",
							id: "t2",
							name: "Bash",
							input: { command: "bun run build" },
						},
						{
							type: "tool_use",
							id: "t3",
							name: "Bash",
							input: { command: "bun deploy.ts" },
						},
					],
				},
			},
			{
				type: "user",
				timestamp: T(2, 9),
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							is_error: true,
							content: "Exit code 1",
						},
						{
							type: "tool_result",
							tool_use_id: "t2",
							is_error: true,
							content: "Exit code 2\nerror: cannot find module ./report",
						},
						{
							type: "tool_result",
							tool_use_id: "t3",
							is_error: true,
							content:
								"Permission for this action was denied by the Claude Code auto mode classifier",
						},
					],
				},
			},
		];
		const signals = claudeSignals(rows)!;
		expect(signals.asks.map((a) => a.text)).toEqual(["status now?"]);
		const [search, build, deploy] = signals.tools;
		expect(search!.failed).toBe(false);
		expect(build).toMatchObject({
			head: "bun run build",
			failed: true,
			denied: false,
		});
		expect(build!.error).toBe("error: cannot find module <path>");
		expect(deploy!.denied).toBe(true);
		expect(deploy!.ms).toBe(8 * 60_000);
	});
});

describe("codexEvents", () => {
	it("splits an exec script into one event per command result", () => {
		const input =
			'const r = await Promise.all([tools.exec_command({cmd:"git status"}), tools.exec_command({cmd:"bun run lint"})]);';
		const output = [
			"Script completed",
			"Output:",
			'{"which":0,"result":{"exit_code":0,"output":"clean"}}',
			'{"which":1,"result":{"exit_code":1,"output":"lint: 3 errors found"}}',
		].join("\n");
		const events = codexEvents("exec", input, output, T(3), T(3, 1));
		expect(events.map((e) => [e.head, e.failed])).toEqual([
			["git status", false],
			["bun run lint", true],
		]);
		expect(events[1]!.error).toBe("lint: N errors found");
	});

	it("treats exit 1 from a pipeline ending in a search as no match", () => {
		expect(searchCommand("ls src | grep needle")).toBe(true);
		expect(searchCommand("cd /work && LC_ALL=C rg -n needle")).toBe(true);
		expect(searchCommand("rg needle src | bun run lint")).toBe(true);
		expect(searchCommand("bun run lint")).toBe(false);
		const input =
			'await Promise.all([tools.exec_command({cmd:"git log --oneline | grep fix"}), tools.exec_command({cmd:"bun run lint"})]);';
		const output = [
			"Script completed",
			'{"which":0,"result":{"exit_code":1,"output":""}}',
			'{"which":1,"result":{"exit_code":1,"output":"lint: 3 errors found"}}',
		].join("\n");
		const events = codexEvents("exec", input, output, T(3), T(3, 1));
		expect(events.map((e) => [e.head, e.failed])).toEqual([
			["git log", false],
			["bun run lint", true],
		]);
	});

	it("names the failing tool of a failed script", () => {
		const [event] = codexEvents(
			"exec",
			"await tools.apply_patch('...')",
			"Script failed\nWall time 0.1 seconds\nOutput:\n Script error:\napply_patch verification failed: Failed to find expected lines in /work/acme/a.ts:",
			T(3),
			T(3),
		);
		expect(event).toMatchObject({ head: "apply_patch", failed: true });
		expect(event!.error).toBe(
			"apply_patch verification failed: Failed to find expected lines in <path>:",
		);
	});
});

describe("repeatedRequests", () => {
	const ask = (text: string, session: string, day: number) => ({
		text,
		session,
		at: T(day),
	});

	it("clusters near-identical asks and keeps those at 5+ times in 3+ sessions", () => {
		const asks = [
			ask("commit and push", "s1", 1),
			ask("Commit and push.", "s1", 1),
			ask("commit + push please", "s2", 2),
			ask("ok commit and push", "s3", 3),
			ask("commit and push now", "s3", 4),
			// Too few sessions.
			ask("rebuild the cache", "s1", 1),
			ask("rebuild the cache", "s1", 2),
			ask("rebuild the cache", "s2", 2),
			ask("rebuild the cache", "s2", 3),
			ask("rebuild the cache", "s2", 4),
			// Acknowledgements are not requests.
			...["s1", "s2", "s3", "s1", "s2"].map((s, i) => ask("yes", s, i + 1)),
		];
		const ranked = repeatedRequests(asks);
		expect(ranked).toHaveLength(1);
		expect(ranked[0]).toMatchObject({
			count: 5,
			sessions: 3,
			last: "2026-03-04",
		});
		expect(ranked[0]!.label.toLowerCase()).toContain("commit and push");
	});
});

describe("frictionHotspots", () => {
	const fail = (head: string, at: string, error = "boom"): ToolEvent => ({
		head,
		failed: true,
		denied: false,
		error,
		at,
		ms: 1000,
	});

	it("counts recurring failures, retry loops and stalls across sessions", () => {
		const sessions = ["s1", "s2"].map((sessionId, i) => ({
			sessionId,
			tools: [
				fail("bun run test:run", T(i + 1, 1)),
				fail("bun run test:run", T(i + 1, 2)),
				fail("bun run test:run", T(i + 1, 3)),
				{
					...fail("bun run build", T(i + 1, 4)),
					failed: false,
					error: "",
					ms: 9 * 60_000,
				},
			],
		}));
		const labels = frictionHotspots(sessions).map(
			(r) => `${r.label} x${r.count}`,
		);
		expect(labels).toEqual([
			"Failing: bun run test:run (boom) x6",
			"Retry loop: bun run test:run failed 3+ times in a row x2",
			"Long stall: bun run build took over 5 minutes x2",
		]);
	});
});

describe("decisions", () => {
	it("extracts cited decisions from the model and merges duplicates", async () => {
		const candidates = [
			{
				text: "Let's go with D1 batches instead of transactions since D1 rejects BEGIN",
				session: "aaaaaaaa-1",
				at: T(1),
			},
			{ text: "Please fix the header", session: "bbbbbbbb-2", at: T(2) },
			{
				text: "We'll use D1 batch rather than transactions",
				session: "cccccccc-3",
				at: T(3),
			},
		];
		const prompts: string[] = [];
		const decisions = await extractDecisions(candidates, async (prompt) => {
			prompts.push(prompt);
			return 'Here: [{"i":1,"decision":"Use D1 batches instead of transactions","because":"D1 rejects BEGIN"},{"i":3,"decision":"Use D1 batches, not transactions","because":""},{"i":9,"decision":"bogus"}]';
		});
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain("2. Please fix the header");
		const log = decisionLog(decisions);
		expect(log).toHaveLength(1);
		expect(log[0]).toMatchObject({ count: 2, sessions: 2, last: "2026-03-03" });
		expect(log[0]!.label).toContain("because D1 rejects BEGIN");
		expect(log[0]!.note).toBe(
			"first session aaaaaaaa, 2026-03-01 10:00 UTC; latest session cccccccc, 2026-03-03 10:00 UTC",
		);
	});
});

describe("projectFor", () => {
	const id = "11111111-2222-4333-8444-555555555555";
	it("takes a scoped project, or a bare one only when there is one organization", () => {
		expect(projectFor("acme/org_acme", [`acme/org_acme=${id}`], 2)).toBe(id);
		expect(projectFor("acme/org_acme", [id], 1)).toBe(id);
		expect(projectFor("acme/org_acme", [id], 2)).toBeNull();
		expect(() => projectFor("acme/org_acme", ["nope"], 1)).toThrow();
	});
});

describe("runAnalyzeSessions", () => {
	const files = ["x-1", "x-2", "x-3", "x-4", "x-5"].map((id) => ({
		harness: "codex" as const,
		path: id,
	}));
	const rollouts: Record<string, any[]> = Object.fromEntries(
		files.map((f, i) => [
			f.path,
			codexRollout(f.path, i + 1, "commit and push"),
		]),
	);
	const base = {
		files,
		readFile: (path: string) => rollouts[path]!,
		targets: new Map([[normalizeGitOrigin(ORIGIN), TARGET]]),
		defaultTarget: undefined,
		home: tmpdir(),
	};

	it("dry-run reports ranked signals per organization and sends nothing", async () => {
		const out: string[] = [];
		const code = await runAnalyzeSessions(["--dry-run", "--no-model"], {
			...base,
			write: (line) => out.push(line),
			read: async () => {
				throw new Error("must not call Tedix");
			},
		});
		expect(code).toBe(0);
		const report = JSON.parse(out.join("\n"));
		const target = report.targets["acme/org_acme"];
		expect(target.sessions).toEqual({ "claude-code": 0, codex: 5 });
		expect(target.requests[0]).toMatchObject({
			label: "commit and push",
			count: 5,
		});
		expect(target.friction.map((r: { label: string }) => r.label)).toEqual([
			"Failing: bun run test:run (FAIL <path> > totals)",
			"Permission denied or blocked: bun deploy.ts web (refusing to deploy: no credential on the environment)",
		]);
		expect(target.decisions).toBeUndefined();
	});

	it("writes one item per category to the routed organization, idempotently", async () => {
		const calls: Array<{ args: string[]; source: string }> = [];
		const out: string[] = [];
		const project = "11111111-2222-4333-8444-555555555555";
		const code = await runAnalyzeSessions(["--project", project], {
			...base,
			runModel: async () => "[]",
			write: (line) => out.push(line),
			read: async (args, _timeout, source) => {
				calls.push({ args, source: source ?? "" });
				return { id: "w-1", action: "created" };
			},
		});
		expect(code).toBe(0);
		expect(calls).toHaveLength(3);
		expect(calls[0]!.args).toEqual([
			"-w",
			"acme",
			"--organization",
			"org_acme",
			"code",
		]);
		const first = calls[0]!.source;
		expect(first).toContain(CATEGORIES.requests.intent);
		expect(first).toContain(project);
		expect(first).toContain("update_work_item_specification");
		// An empty decision log never creates an item, it only refreshes one.
		expect(calls[2]!.source).toContain('"create":false');
	});

	it("skips sessions from an unbound repository", async () => {
		const out: string[] = [];
		await runAnalyzeSessions(["--dry-run", "--no-model"], {
			...base,
			targets: new Map(),
			write: (line) => out.push(line),
		});
		const report = JSON.parse(out.join("\n"));
		expect(report.targets).toEqual({});
		expect(report.unrouted.unboundRepository).toEqual({ acme: 5 });
	});
});

describe("syncSource", () => {
	/** Runs the Code Mode program against an in-memory board. */
	async function run(
		source: string,
		rows: any[] | { ok: false; error: string },
	) {
		const calls: string[] = [];
		const work = {
			list_work_items: async (input: { titleContains: string }) => {
				calls.push(`list:${input.titleContains}`);
				return Array.isArray(rows) ? { data: rows } : rows;
			},
			update_work_item_specification: async (input: { id: string }) => {
				calls.push(`update:${input.id}`);
				return {};
			},
			create_work_items: async (input: { sourceIntentId: string }) => {
				calls.push(`create:${input.sourceIntentId}`);
				return { id: "new" };
			},
		};
		const program = new Function("work", `return (${source})();`);
		return { result: await program(work), calls };
	}
	const want = {
		title: CATEGORIES.friction.title,
		intent: CATEGORIES.friction.intent,
		description: "list v2",
		projectId: "11111111-2222-4333-8444-555555555555",
		create: true,
	};

	it("updates the existing item, leaves an identical one alone and creates once", async () => {
		const existing = {
			id: "w-1",
			title: want.title,
			sourceIntentId: want.intent,
			disposition: "proposed",
		};
		expect(
			await run(syncSource(want), [{ ...existing, description: "list v1" }]),
		).toEqual({
			result: { id: "w-1", action: "updated" },
			calls: ["list:Session analysis", "update:w-1"],
		});
		expect(
			(await run(syncSource(want), [{ ...existing, description: "list v2" }]))
				.result,
		).toEqual({
			id: "w-1",
			action: "unchanged",
		});
		expect((await run(syncSource(want), [])).calls).toEqual([
			"list:Session analysis",
			`create:${want.intent}`,
		]);
	});

	it("never creates when the listing fails", async () => {
		const { result, calls } = await run(syncSource(want), {
			ok: false,
			error: "Internal Server Error",
		});
		expect(result.ok).toBe(false);
		expect(calls).toEqual(["list:Session analysis"]);
	});
});

describe("renderDescription", () => {
	it("states the source and lists ranked entries", () => {
		const text = renderDescription(
			"friction",
			{ sessions: { "claude-code": 1, codex: 2 }, from: T(1), to: T(4) },
			[
				{
					label: "Failing: bun run build (boom)",
					count: 4,
					sessions: 2,
					last: "2026-03-04",
				},
			],
		);
		expect(text).toContain(
			"Source: 3 local sessions (1 Claude Code, 2 Codex), 2026-03-01 to 2026-03-04.",
		);
		expect(text).toContain(
			"1. Failing: bun run build (boom) (4 times in 2 sessions, last 2026-03-04)",
		);
	});
});
