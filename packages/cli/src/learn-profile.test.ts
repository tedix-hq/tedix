import { describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claudeFacts,
	type SessionFacts,
	type TranscriptFile,
} from "./learn-facts";
import {
	GROUP_PROMPT,
	PROFILE_PROMPT,
	STATE_PROMPT,
	SUMMARY_PROMPT,
	groupWorkstreams,
	newMeter,
	publicText,
	renderDocument,
	runProfile,
	sessionDigest,
	summarise,
	toProfile,
	toSummary,
	type ProfileDeps,
	type ProfileState,
} from "./learn-profile";

const date = "2026-03-01T10:00:00Z";
const workId = "11111111-2222-4333-8444-555555555555";
const outputId = "22222222-3333-4444-8555-666666666666";
const workspaceId = "33333333-4444-4555-8666-777777777777";
const rows = (id: string) => [
	{ type: "ai-title", sessionId: id, aiTitle: "Acme Planner exports" },
	...[
		"Build the billing export",
		`Finish the export for Work Item ${workId}`,
	].map((text) => ({
		type: "user",
		sessionId: id,
		timestamp: date,
		cwd: "/home/dev/acme",
		message: { content: text },
	})),
	{
		type: "assistant",
		message: {
			content: [{ type: "text", text: "Export built; review remains." }],
		},
	},
];
const transcript: TranscriptFile = {
	harness: "claude-code",
	path: "/home/dev/acme/session.jsonl",
	subagent: false,
	bytes: 0,
	mtimeMs: 0,
};
const facts = async (id = "session-acme"): Promise<SessionFacts> =>
	(await claudeFacts(transcript, rows(id)))!;
const summary = (goal = "Finish exports") =>
	toSummary({
		goal,
		outcome: "Export built",
		status: "open",
		workstream: "Billing exports",
		openLoops: ["Review export"],
		people: ["Mara Quill"],
	});
const profile = (possessive = false) =>
	toProfile({
		role: "Builds Acme Planner",
		style: ["Prefers small changes"],
		actions: ["Review", "Document", "Test"].map((verb) => ({
			title: possessive
				? `${verb} Mara's billing exports`
				: `${verb} billing exports with Mara`,
			why: "Mara left an export review open",
			workstream: "Billing exports",
			kind: "finish",
		})),
	});

describe("profile summaries", () => {
	it("removes contact details and secrets while preserving dates and short numbers", () => {
		const secret = "AcmeFakeToken0123456789".repeat(3);
		const text = publicText(
			`mara@example.test +49 151 2345 6789 ${secret} 2026-03-01 42`,
		);
		for (const privateText of [
			"mara@example.test",
			"+49 151 2345 6789",
			secret,
		])
			expect(text).not.toContain(privateText);
		expect(text).toContain("2026-03-01");
		expect(text).toContain("42");
	});

	it("digests the title, typed asks, commits and ending", async () => {
		const session = await facts();
		session.commits = [{ sha: "abc1234", subject: "feat: billing export" }];
		const digest = sessionDigest(session, 1);
		for (const text of [
			"Title: Acme Planner exports",
			"typed: Build the billing export",
			"feat: billing export",
			"Ended with: Export built; review remains.",
		])
			expect(digest).toContain(text);
		session.asks = Array.from({ length: 30 }, () => ({
			text: "Review export ".repeat(40),
			at: date,
		}));
		session.filesWritten = Array.from(
			{ length: 200 },
			(_, n) => `src/exports/${n}-${"part".repeat(30)}.ts`,
		);
		expect(sessionDigest(session, 1).length).toBeLessThanOrEqual(4000);
	});

	it("maps numbered summaries to sessions and reuses unchanged cached summaries", async () => {
		const sessions = await Promise.all([facts("acme-a"), facts("acme-b")]);
		const state: ProfileState = { version: 1, facts: {}, summaries: {} };
		const meter = newMeter();
		let calls = 0;
		const run = async (prompt: string) => {
			calls++;
			expect(prompt.startsWith(SUMMARY_PROMPT)).toBe(true);
			return JSON.stringify([
				{ n: 2, ...summary("Document exports") },
				{ n: 1, ...summary("Review exports") },
			]);
		};
		const first = await summarise(
			sessions,
			state,
			run,
			meter,
			() => {},
			() => {},
		);
		expect(first.get(sessions[0]!.key)?.goal).toBe("Review exports");
		expect(first.get(sessions[1]!.key)?.goal).toBe("Document exports");
		const second = await summarise(
			sessions,
			state,
			run,
			meter,
			() => {},
			() => {},
		);
		expect(second).toEqual(first);
		expect(calls).toBe(1);
		expect(meter.cached).toBe(2);
	});
});

describe("workstreams and document", () => {
	it("keeps model omissions under the summary's suggested workstream", async () => {
		const sessions = await Promise.all([facts("acme-a"), facts("acme-b")]);
		const summaries = new Map(sessions.map((s) => [s.key, summary()]));
		summaries.get(sessions[1]!.key)!.workstream = "Planner onboarding";
		const groups = await groupWorkstreams(sessions, summaries, async () =>
			JSON.stringify([
				{ name: "Billing exports", description: "Export work", sessions: [1] },
			]),
		);
		expect(groups).toHaveLength(2);
		expect(
			groups
				.find((w) => w.name === "Planner onboarding")
				?.sessions.map((s) => s.key),
		).toEqual([sessions[1]!.key]);
	});

	it("merges equivalent workstream names across model chunks", async () => {
		const base = await facts();
		const sessions = Array.from({ length: 221 }, (_, n) => ({
			...base,
			key: `claude-code:acme-${n}`,
			sessionId: `acme-${n}`,
			from: new Date(Date.parse(date) + n * 1000).toISOString(),
		}));
		let calls = 0;
		const groups = await groupWorkstreams(
			sessions,
			new Map(),
			async (prompt) => {
				expect(prompt.startsWith(GROUP_PROMPT)).toBe(true);
				return JSON.stringify([
					{
						name: calls++ === 0 ? "Billing exports" : "billing export",
						description: "Export work",
						sessions: Array.from(
							{ length: calls === 1 ? 220 : 1 },
							(_, n) => n + 1,
						),
					},
				]);
			},
		);
		expect(calls).toBe(2);
		expect(groups).toHaveLength(1);
		expect(new Set(groups[0]!.sessions.map((s) => s.key)).size).toBe(221);
	});

	async function document(id: string) {
		const session = await facts();
		const s = summary();
		s.openLoops = ["Review export with mara@example.test"];
		const summaries = new Map([[session.key, s]]);
		const workstreams = await groupWorkstreams(
			[session],
			summaries,
			async () => "[]",
		);
		workstreams[0]!.openLoops = s.openLoops;
		workstreams[0]!.items = [
			{ id, title: "Review export", disposition: "accepted", projectId: null },
		];
		return renderDocument({
			who: "Mara Quill",
			sessions: [session],
			files: 1,
			summaries,
			workstreams,
			profile: profile(),
			actions: [],
			model: "fake",
			meter: newMeter(),
			seconds: 0,
			today: "2026-03-01",
		});
	}

	it("renders the required headings, Work links and scrubbed summary content", async () => {
		const blocks = await document("w-acme");
		const headings = blocks
			.filter((b) => b.type === "heading")
			.map((b) => b.text);
		for (const heading of [
			"What Tedix knows about you",
			"3 things I can do for you right now",
			"Your active projects",
			"Open loops you left unfinished",
			"How you like to work",
		])
			expect(headings).toContain(heading);
		expect(JSON.stringify(blocks)).toContain(
			"https://os.tedix.dev/work/items/w-acme",
		);
		expect(JSON.stringify(blocks)).toContain("Review export with [email]");
		for (const block of blocks)
			expect(JSON.stringify(block)).not.toContain("mara@example.test");
	});

	it("preserves UUID Work links in the rendered document", async () => {
		expect(JSON.stringify(await document(workId))).toContain(
			`https://os.tedix.dev/work/items/${workId}`,
		);
	});
});

describe("runProfile", () => {
	function fixture(possessive = false) {
		const dir = mkdtempSync(join(tmpdir(), "acme-profile-"));
		const transcripts = ["acme-a", "acme-b"].map((id): TranscriptFile => {
			const path = join(dir, `${id}.jsonl`);
			writeFileSync(
				path,
				rows(id)
					.map((row) => JSON.stringify(row))
					.join("\n"),
			);
			const stat = statSync(path);
			return { ...transcript, path, bytes: stat.size, mtimeMs: stat.mtimeMs };
		});
		const sources: string[] = [];
		const prompts: string[] = [];
		const me = { id: "u1", name: "Mara Quill" };
		const deps: ProfileDeps = {
			transcripts,
			home: join(dir, "home"),
			stateDir: dir,
			notes: [],
			now: () => new Date(date),
			write: () => {},
			defaultTarget: {
				workspace: "acme",
				org: "org_acme",
				organization: "org_acme",
				mcpUrl: "https://mcp.example.test/mcp",
			},
			model: {
				name: "fake",
				run: async (prompt) => {
					prompts.push(prompt);
					if (prompt.startsWith(SUMMARY_PROMPT))
						return JSON.stringify(
							[1, 2].map((n) => ({ n, ...summary("Review Mara's exports") })),
						);
					if (prompt.startsWith(GROUP_PROMPT))
						return JSON.stringify([
							{
								name: "Billing exports",
								description: "Acme export work",
								sessions: [1, 2],
							},
						]);
					if (prompt.startsWith(STATE_PROMPT.split("TODAY")[0]!))
						return JSON.stringify([
							{
								w: 1,
								status: "active",
								state: "Export ready for review",
								next: "Review export",
								openLoops: ["Review export"],
							},
						]);
					if (prompt.startsWith(PROFILE_PROMPT))
						return JSON.stringify(profile(possessive));
					throw new Error("Unexpected model prompt");
				},
			},
			read: async (_args, _timeout, source = "") => {
				sources.push(source);
				if (source.includes("create_os_output"))
					return { workspaceId, outputId };
				if (source.includes("create_work_interaction")) {
					const input = JSON.parse(source.match(/const input = (.*);/)![1]!);
					return Object.fromEntries(
						input.map((entry: { key: string }, n: number) => [
							entry.key,
							{ id: `i-${n}` },
						]),
					);
				}
				if (
					source.includes("user.get_mine") &&
					source.includes("list_work_interactions")
				)
					return { me, rows: [] };
				if (source.includes("work.list_work_items"))
					return {
						me,
						scanned: {},
						matches: Object.fromEntries(
							[...source.matchAll(/"k":"([^"]+)"/g)].map((m) => [
								m[1],
								{ w: [], p: [] },
							]),
						),
					};
				if (source.includes("projects.list_projects"))
					return { projects: [], more: false };
				if (source.includes("get_work_items_by_id")) return { items: [] };
				throw new Error("Unexpected Code Mode program");
			},
		};
		return { dir, deps, sources, prompts };
	}

	it("publishes anonymous proposals and a profile document, recording the output", async () => {
		const { dir, deps, sources, prompts } = fixture();
		try {
			expect(await runProfile([], deps)).toBe(0);
			expect(prompts).toHaveLength(4);
			const publish = sources.find((s) =>
				s.includes("create_work_interaction"),
			);
			expect(publish).toBeDefined();
			const proposals = JSON.parse(publish!.match(/const input = (.*);/)![1]!);
			expect(proposals).toHaveLength(3);
			for (const { request } of proposals) {
				expect(request.subject).not.toContain("Mara");
				expect(request.prompt).not.toContain("Mara");
				expect(request.prompt).not.toContain("Quill");
			}
			expect(sources.find((s) => s.includes("create_os_output"))).toContain(
				"What Tedix knows about you",
			);
			const state = JSON.parse(
				readFileSync(join(dir, "profile/state.json"), "utf8"),
			);
			expect(state.space.outputId).toBe(outputId);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("removes possessive person names from published subjects and prompts", async () => {
		const { dir, deps, sources } = fixture(true);
		try {
			expect(await runProfile([], deps)).toBe(0);
			const publish = sources.find((s) =>
				s.includes("create_work_interaction"),
			)!;
			const proposals = JSON.parse(publish.match(/const input = (.*);/)![1]!);
			expect(proposals).toHaveLength(3);
			for (const { request } of proposals) {
				expect(request.subject).not.toContain("Mara");
				expect(request.prompt).not.toContain("Mara");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("dry-runs locally without calling the model or Code Mode reader", async () => {
		const { dir, deps, sources, prompts } = fixture();
		try {
			expect(await runProfile(["--dry-run"], deps)).toBe(0);
			expect(sources).toEqual([]);
			expect(prompts).toEqual([]);
			expect(existsSync(join(dir, "profile"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
