import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeGitOrigin } from "./agent-context";
import {
	humanReply,
	parseClaudeSession,
	parseCodexSession,
	planImport,
	runLearnCommand,
	scrub,
} from "./learn-import";

const T = (minute: number) =>
	`2026-03-02T10:${String(minute).padStart(2, "0")}:00.000Z`;

/** A fictional Claude Code transcript with every noise class the importer drops. */
const claudeRows = [
	{ type: "mode", sessionId: "c-1" },
	{
		type: "user",
		sessionId: "c-1",
		cwd: "/work/acme",
		gitBranch: "main",
		uuid: "u-0",
		timestamp: T(0),
		origin: { kind: "human" },
		message: {
			role: "user",
			content: "Please add a CSV export to the reports page.",
		},
	},
	{
		type: "assistant",
		sessionId: "c-1",
		message: {
			id: "m-1",
			role: "assistant",
			content: [
				{
					type: "text",
					text: "Added the export. Should I open a pull request?",
				},
			],
		},
	},
	{
		type: "user",
		uuid: "u-1",
		timestamp: T(1),
		toolUseResult: {},
		message: {
			role: "user",
			content: [{ type: "tool_result", content: "ok" }],
		},
	},
	{
		type: "user",
		uuid: "u-2",
		timestamp: T(2),
		isMeta: true,
		message: {
			role: "user",
			content: "<system-reminder>hook context</system-reminder>",
		},
	},
	{
		type: "user",
		uuid: "u-3",
		timestamp: T(3),
		origin: { kind: "task-notification" },
		message: {
			role: "user",
			content: "<task-notification>done</task-notification>",
		},
	},
	{
		type: "user",
		uuid: "u-4",
		timestamp: T(4),
		origin: { kind: "human" },
		message: {
			role: "user",
			// A fictional token, assembled so the repository secret scan stays clean.
			content: `No pull requests in this repo; commit to main. My token is ${"ghp"}_${"abcdefghijklmnopqrstuvwxyz0123"} and mail dana@example.org`,
		},
	},
	{
		type: "assistant",
		isSidechain: true,
		message: {
			id: "m-s",
			content: [{ type: "text", text: "sub-agent chatter" }],
		},
	},
	{
		type: "assistant",
		message: {
			id: "m-2",
			content: [{ type: "text", text: "Pushed. Anything else?" }],
		},
	},
	{
		type: "user",
		uuid: "u-5",
		timestamp: T(5),
		origin: { kind: "human" },
		message: { role: "user", content: "<command-name>/clear</command-name>" },
	},
	{
		type: "user",
		uuid: "u-6",
		timestamp: T(6),
		origin: { kind: "human" },
		message: { role: "user", content: "continue" },
	},
];

/** A fictional Codex rollout: injected context parts, then the person's request. */
const codexRows = [
	{
		type: "session_meta",
		timestamp: T(0),
		payload: {
			id: "x-1",
			session_id: "x-1",
			cwd: "/nowhere/acme",
			thread_source: "user",
			git: {
				repository_url: "git@github.com:acme-co/acme.git",
				branch: "main",
			},
		},
	},
	{
		type: "response_item",
		timestamp: T(0),
		payload: {
			type: "message",
			role: "user",
			content: [
				{
					type: "input_text",
					text: "# AGENTS.md instructions for /nowhere/acme\n<INSTRUCTIONS>rules</INSTRUCTIONS>",
				},
			],
		},
	},
	{
		type: "response_item",
		timestamp: T(1),
		payload: {
			type: "message",
			role: "assistant",
			content: [
				{
					type: "output_text",
					text: "I can write the long technical summary now.",
				},
			],
		},
	},
	{
		type: "response_item",
		timestamp: T(2),
		payload: {
			type: "message",
			role: "user",
			content: [
				{
					type: "input_text",
					text: '\n<in-app-browser-context source="ambient-ui-state">\nCurrent URL: https://example.com/a?token=zzz\n</in-app-browser-context>\n\n## My request:\nkeep it short and in plain English, I read fifteen sessions at once\n',
				},
				{
					type: "input_text",
					text: '<image name=[Image #1] path="/tmp/a.png">',
				},
			],
		},
	},
	{
		type: "response_item",
		timestamp: T(3),
		payload: {
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text: "Here is the build log." }],
		},
	},
	{
		type: "response_item",
		timestamp: T(4),
		payload: {
			type: "message",
			role: "user",
			content: [
				{
					type: "input_text",
					text: "2026-03-02 10:00:01 error: boom\n  at main (a.ts:1:2)\n  at run (b.ts:3:4)\n[worker] retry\n{\n}\nwhy?",
				},
			],
		},
	},
];

describe("transcript extraction", () => {
	it("pairs the agent's last message with a genuine Claude Code reply", () => {
		const session = parseClaudeSession(claudeRows);
		expect(session).toMatchObject({
			sessionId: "c-1",
			cwd: "/work/acme",
			branch: "main",
		});
		expect(session.pairs).toHaveLength(1);
		const [pair] = session.pairs;
		expect(pair).toMatchObject({
			turnId: "u-4",
			occurredAt: T(4),
			agentMessage: "Added the export. Should I open a pull request?",
		});
		expect(pair!.reply).toContain(
			"No pull requests in this repo; commit to main.",
		);
		expect(pair!.reply).not.toContain("ghp_");
		expect(pair!.reply).not.toContain("dana@example.org");
	});

	it("keeps only the person's request from a Codex turn and drops pasted logs", () => {
		const session = parseCodexSession(codexRows);
		expect(session).toMatchObject({
			sessionId: "x-1",
			origin: "git@github.com:acme-co/acme.git",
		});
		expect(session.pairs.map((p) => p.reply)).toEqual([
			"keep it short and in plain English, I read fifteen sessions at once",
		]);
		expect(session.pairs[0]!.agentMessage).toBe(
			"I can write the long technical summary now.",
		);
	});

	it("skips sub-agent and automation threads", () => {
		const meta = (payload: object) => [
			{ type: "session_meta", payload: { id: "s", ...payload } },
		];
		expect(parseCodexSession(meta({ thread_source: "subagent" })).skipped).toBe(
			"subagent",
		);
		expect(
			parseCodexSession(meta({ thread_source: "automation" })).skipped,
		).toBe("automation");
		expect(
			parseClaudeSession([{ ...claudeRows[1], entrypoint: "sdk-cli" }]).skipped,
		).toBe("automation");
	});

	it("rejects injected and command text", () => {
		expect(
			humanReply("<local-command-stdout>x</local-command-stdout>"),
		).toBeNull();
		expect(humanReply("Base directory for this skill: /x\n# Skill")).toBeNull();
		expect(humanReply("[Request interrupted by user]")).toBeNull();
		expect(humanReply("ok")).toBeNull();
		expect(
			humanReply(
				'why does the bump command hang at the end?\n<pasted_content id="a1">\n$ bun bump\nlog line',
			),
		).toBe("why does the bump command hang at the end?");
	});

	it("names a bound origin the same way however it is written", () => {
		expect(normalizeGitOrigin("git@github.com:Acme-Co/acme.git")).toBe(
			"github.com/acme-co/acme",
		);
		expect(normalizeGitOrigin("https://github.com/acme-co/acme/")).toBe(
			"github.com/acme-co/acme",
		);
	});

	it("redacts random-looking credential runs but keeps ordinary words", () => {
		expect(scrub("trace cto:embed:Q7fidlFmAxlK54X7H8wJEkniG7mu ok")).toBe(
			"trace cto:embed:[redacted] ok",
		);
		expect(scrub("workstationSessionLockedInvocation")).toBe(
			"workstationSessionLockedInvocation",
		);
	});

	it("scrubs secret references, emails, URL queries and the home path", () => {
		expect(
			scrub(
				"use pass://Vault/KEY, ask bo@example.com, see https://x.dev/p?sig=abc in /home/pat/src",
				"/home/pat",
			),
		).toBe("use [secret ref] ask [email], see https://x.dev/p in ~/src");
	});
});

const target = {
	workspace: "acme",
	org: "org_acme",
	mcpUrl: "https://acme.example/mcp",
};

describe("planImport", () => {
	const files = [
		{ harness: "claude-code" as const, path: "claude" },
		{ harness: "codex" as const, path: "codex" },
		{ harness: "codex" as const, path: "codex-fork" },
	];
	const read = (path: string) => (path === "claude" ? claudeRows : codexRows);

	it("routes by bound origin, never guesses, and dedupes replayed turns", () => {
		const plan = planImport({
			files,
			read,
			targets: new Map([["github.com/acme-co/acme", target]]),
			defaultTarget: undefined,
			// The Claude session's checkout is gone: unknown, not "no repository".
			originOf: () => undefined,
		});
		expect(plan.pairs).toBe(1);
		expect(plan.unrouted.unknownLocation).toBe(1);
		const [bucket] = [...plan.byTarget.values()];
		expect(bucket!.decisions[0]).toMatchObject({
			harness: "codex",
			repository: "acme",
			topic: "plain-english",
			sessionId: "x-1",
		});
	});

	it("counts sessions in unbound repositories instead of routing them", () => {
		const plan = planImport({
			files: [files[1]!],
			read,
			targets: new Map(),
			defaultTarget: target,
		});
		expect(plan.pairs).toBe(0);
		expect(plan.unrouted.unboundRepository).toEqual({ acme: 1 });
	});

	it("sends a session outside any repository to the default organization only", () => {
		const outside = claudeRows.map((row) => ({ ...row, cwd: "/" }));
		const plan = planImport({
			files: [files[0]!],
			read: () => outside,
			targets: new Map(),
			defaultTarget: undefined,
			originOf: () => null,
		});
		expect(plan.unrouted.noDefaultOrganization).toBe(1);
		const routed = planImport({
			files: [files[0]!],
			read: () => outside,
			targets: new Map(),
			defaultTarget: target,
			originOf: () => null,
		});
		expect(
			[...routed.byTarget.values()][0]!.decisions[0]!.repository,
		).toBeNull();
	});
});

describe("runLearnCommand", () => {
	it("uploads routed pairs through Code Mode, then mines until settled", async () => {
		const home = mkdtempSync(join(tmpdir(), "tedix-learn-"));
		const day = join(home, ".codex", "sessions", "2026", "03", "02");
		mkdirSync(day, { recursive: true });
		writeFileSync(
			join(day, "rollout-x.jsonl"),
			codexRows.map((row) => JSON.stringify(row)).join("\n"),
		);
		const calls: Array<{ args: string[]; source?: string }> = [];
		const lines: string[] = [];
		const code = await runLearnCommand(["import-sessions", "--json"], {
			home,
			read: async (args, _timeout, source) => {
				calls.push({ args, source });
				return source?.includes("import_agent_session_decisions")
					? { received: 1, recorded: 1, duplicates: 0 }
					: {
							factsWritten: calls.length === 2 ? 1 : 0,
							budgetHit: calls.length === 2,
						};
			},
			write: (line) => lines.push(line),
			targets: new Map([
				["github.com/acme-co/acme", { ...target, organization: "org_acme" }],
			]),
			defaultTarget: undefined,
		});
		rmSync(home, { recursive: true, force: true });
		expect(code).toBe(0);
		expect(calls[0]!.args).toEqual([
			"-w",
			"acme",
			"--organization",
			"org_acme",
			"code",
		]);
		expect(calls[0]!.source).toContain("plain English");
		expect(calls[0]!.source).not.toContain("token=zzz");
		expect(calls.slice(1).map((c) => c.source)).toEqual([
			"async () => await agent.mine_agent_session_lessons({})",
			"async () => await agent.mine_agent_session_lessons({})",
		]);
		expect(JSON.parse(lines.at(-1)!).results["acme/org_acme"]).toMatchObject({
			recorded: 1,
			mining: { passes: 2, factsWritten: 1, done: true },
		});
	});

	it("retries a rate-limited batch and keeps mining past a gateway timeout", async () => {
		const home = mkdtempSync(join(tmpdir(), "tedix-learn-"));
		const day = join(home, ".codex", "sessions", "2026", "03", "02");
		mkdirSync(day, { recursive: true });
		writeFileSync(
			join(day, "rollout-x.jsonl"),
			codexRows.map((row) => JSON.stringify(row)).join("\n"),
		);
		const replies = [
			{ ok: false, error: "Tool rate limit exceeded for bounded_write." },
			{ received: 1, recorded: 1, duplicates: 0 },
			{ ok: false, error: "Error: Request timed out after 15000ms" },
			{ factsWritten: 0, factsSuperseded: 0, budgetHit: false },
		];
		const pauses: number[] = [];
		const lines: string[] = [];
		const code = await runLearnCommand(["import-sessions", "--json"], {
			home,
			read: async () => replies.shift()!,
			sleep: async (ms) => {
				pauses.push(ms);
			},
			write: (line) => lines.push(line),
			targets: new Map([["github.com/acme-co/acme", target]]),
			defaultTarget: undefined,
		});
		rmSync(home, { recursive: true, force: true });
		expect(code).toBe(0);
		expect(pauses).toEqual([5000, 60000]);
		expect(JSON.parse(lines.at(-1)!).results["acme/org_acme"]).toMatchObject({
			recorded: 1,
			failedBatches: 0,
			mining: { passes: 1, timedOut: 1, done: true },
		});
	});

	it("dry-run sends nothing", async () => {
		const lines: string[] = [];
		const code = await runLearnCommand(
			["import-sessions", "--dry-run", "--json"],
			{
				home: "/nonexistent-home",
				read: async () => {
					throw new Error("must not call the gateway");
				},
				write: (line) => lines.push(line),
				targets: new Map(),
				defaultTarget: undefined,
			},
		);
		expect(code).toBe(0);
		expect(JSON.parse(lines[0]!)).toMatchObject({
			files: 0,
			pairs: 0,
			samples: [],
		});
	});
});
