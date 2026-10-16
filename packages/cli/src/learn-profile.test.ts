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
import { WorkProposalMetadataSchema } from "@tedix/api-contract/schemas/work-interactions";
import type { AskedProposal } from "./learn-proposals";
import {
	groundWeek,
	stabilizeWorkstreams,
	readProfileState,
	writeProfileState,
	GROUP_PROMPT,
	MERGE_PROMPT,
	PLAN_PROMPT,
	WHO_AM_I_SOURCE,
	TEAM_SOURCE,
	MAX_WORKSTREAMS,
	weigh,
	projectEvidence,
	linkWorkstream,
	mergeWorkstreams,
	planNow,
	priorities,
	type Board,
	type Workstream,
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
const profile = () =>
	toProfile({
		role: "Builds Acme Planner",
		style: ["Prefers small changes"],
	});
const plan = (possessive = false) => ({
	week: "You built Acme exports. The customer brief is still open.",
	actions: ["Draft", "Design", "Prepare"].map((verb) => ({
		title: possessive
			? `${verb} Mara's billing exports`
			: `${verb} billing exports with Mara`,
		why: "Mara left an export review open",
		workstream: "Billing exports",
		kind: "delegate" as const,
		start: "Collect the export requirements",
		tedi: "ledger",
	})),
});
const emptyBoard = (): Board => ({ me: null, items: new Map(), projects: [] });
async function thread(
	name: string,
	sessions: SessionFacts[],
): Promise<Workstream> {
	return (
		await groupWorkstreams(sessions, new Map(), async () =>
			JSON.stringify([
				{ name, description: name, sessions: sessions.map((_, n) => n + 1) },
			]),
		)
	)[0]!;
}

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
			profile: { ...profile(), week: "You built exports." },
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
			"Your week in Tedix",
			"3 things I can do for you right now",
			"Your active projects",
			"Open loops you left unfinished",
			"How you like to work",
		])
			expect(headings).toContain(heading);
		expect(headings.indexOf("Your week in Tedix")).toBeLessThan(
			headings.indexOf("3 things I can do for you right now"),
		);
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
	function fixture(possessive = false, asked: AskedProposal[] = []) {
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
			goals: new Map(),
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
					if (prompt.startsWith(MERGE_PROMPT))
						return JSON.stringify([
							{
								name: "Billing exports",
								description: "Acme export work",
								clusters: [1],
							},
						]);
					if (prompt.startsWith(PLAN_PROMPT))
						return JSON.stringify(plan(possessive));
					if (prompt.startsWith(STATE_PROMPT.split("TODAY")[0]!))
						return JSON.stringify([
							{
								w: 1,
								status: "active",
								state: "Export ready for review",
								next: "Review export",
								openLoops: ["Review export"],
								parts: [{ p: 1, line: "Export ready" }],
							},
						]);
					if (prompt.startsWith(PROFILE_PROMPT))
						return JSON.stringify(profile());
					throw new Error("Unexpected model prompt");
				},
			},
			read: async (_args, _timeout, source = "") => {
				sources.push(source);
				if (source === WHO_AM_I_SOURCE) return { me };
				if (source === TEAM_SOURCE)
					return { team: [{ slug: "ledger", name: "Ledger worker" }] };
				if (source.includes("Superseded by a newer tedix learn profile")) {
					const input = JSON.parse(source.match(/const input = (.*);/)![1]!);
					return Object.fromEntries(
						input.map((row: { id: string }) => [row.id, { ok: true }]),
					);
				}
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
					return { me, rows: asked };
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
			expect(prompts).toHaveLength(6);
			for (const [n, prefix] of [
				SUMMARY_PROMPT,
				GROUP_PROMPT,
				MERGE_PROMPT,
				STATE_PROMPT.split("TODAY")[0]!,
				PROFILE_PROMPT,
				PLAN_PROMPT,
			].entries())
				expect(prompts[n]!.startsWith(prefix)).toBe(true);
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
				expect(
					WorkProposalMetadataSchema.safeParse(request.metadata).success,
				).toBe(true);
				expect(request.metadata.proposal.start).toEqual({
					kind: "delegate",
					brief: "Collect the export requirements",
					tedi: "ledger",
				});
				expect(request.prompt).toContain(
					"Accept and Tedix starts it right away: Ledger worker takes the first step",
				);
			}
			expect(sources.find((s) => s.includes("create_os_output"))).toContain(
				"What Tedix knows about you",
			);
			const state = JSON.parse(
				readFileSync(join(dir, "profile/state.json"), "utf8"),
			);
			expect(state.space.outputId).toBe(outputId);
			expect(Object.values(state.workstreams)).toEqual([
				expect.objectContaining({ name: "Billing exports", order: 0 }),
			]);
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

	it("withdraws superseded profile proposals and retains a matching open proposal", async () => {
		const asked: AskedProposal[] = [
			{
				id: "old-acme",
				version: 4,
				state: "open",
				key: "profile:old",
				title: "Arrange the Acme workshop",
				subject: "",
				prompt: "",
			},
			{
				id: "keep-acme",
				version: 2,
				state: "open",
				key: "profile:keep",
				hasStart: true,
				title: "Draft billing exports with Mara",
				subject: "",
				prompt: "",
			},
			{
				id: "other-acme",
				version: 1,
				state: "open",
				key: "context:other",
				title: "Organize Acme research",
				subject: "",
				prompt: "",
			},
		];
		const { dir, deps, sources } = fixture(false, asked);
		try {
			expect(await runProfile([], deps)).toBe(0);
			const cancellations = sources.filter((source) =>
				source.includes("Superseded by a newer tedix learn profile"),
			);
			expect(cancellations).toHaveLength(1);
			expect(
				JSON.parse(cancellations[0]!.match(/const input = (.*);/)![1]!),
			).toEqual([{ id: "old-acme", version: 4 }]);
			const publish = sources.find((source) =>
				source.includes("create_work_interaction"),
			)!;
			const proposals = JSON.parse(publish.match(/const input = (.*);/)![1]!);
			expect(proposals).toHaveLength(2);
			for (const { request } of proposals)
				expect(request.subject).not.toContain("Draft");
			const output = sources.find((source) =>
				source.includes("create_os_output"),
			)!;
			expect(output).toContain("/work/interactions/keep-acme");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("files an open proposal that cannot start anything again, with a start", async () => {
		const asked: AskedProposal[] = [
			{
				id: "legacy-acme",
				version: 1,
				state: "open",
				key: "profile:legacy",
				title: "Draft billing exports with Mara",
				subject: "",
				prompt: "",
			},
		];
		const { dir, deps, sources } = fixture(false, asked);
		try {
			expect(await runProfile([], deps)).toBe(0);
			const publish = sources.find((source) =>
				source.includes("create_work_interaction"),
			)!;
			const proposals = JSON.parse(publish.match(/const input = (.*);/)![1]!);
			expect(proposals).toHaveLength(3);
			expect(
				proposals.every(
					(p: { request: { metadata: { proposal: { start?: unknown } } } }) =>
						p.request.metadata.proposal.start,
				),
			).toBe(true);
			const withdrawn = sources.find((source) =>
				source.includes("Superseded by a newer tedix learn profile"),
			)!;
			expect(JSON.parse(withdrawn.match(/const input = (.*);/)![1]!)).toEqual([
				{ id: "legacy-acme", version: 1 },
			]);
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

describe("strategic workstreams", () => {
	it("weighs days worked more than a burst of sessions on one day", async () => {
		const base = await facts();
		const burst = Array.from({ length: 20 }, (_, n) => ({
			...base,
			key: `acme-burst-${n}`,
		}));
		const spread = Array.from({ length: 4 }, (_, n) => ({
			...base,
			key: `acme-day-${n}`,
			to: `2026-03-0${n + 1}T10:00:00Z`,
		}));
		const summaries = new Map(
			[...burst, ...spread].map((f) => [
				f.key,
				toSummary({ ...summary(), status: "done" }),
			]),
		);
		expect(weigh(burst, summaries).days).toBe(1);
		expect(weigh(spread, summaries).days).toBe(4);
		expect(weigh(burst, summaries).weight).toBeLessThan(
			weigh(spread, summaries).weight,
		);
	});

	it.each(["work item", "project key", "repository path"])(
		"links projects using %s evidence",
		async (evidence) => {
			const session = await facts();
			session.workItems = evidence === "work item" ? { [workId]: 1 } : {};
			if (evidence === "project key")
				session.asks = [{ text: "Ship ACME-BILLING exports", at: date }];
			if (evidence === "repository path")
				session.filesWritten = [
					"/home/dev/acme/packages/billing/src/export.ts",
				];
			const board = emptyBoard();
			board.projects = [
				[
					"p-acme",
					"ACME-BILLING",
					"Acme Billing",
					"Owns packages/billing exports",
				],
			];
			board.items.set(workId, {
				id: workId,
				title: "Export invoices",
				disposition: "accepted",
				projectId: "p-acme",
			});
			expect(projectEvidence([session], board)).toEqual(
				new Map([["p-acme", 1]]),
			);
			const w = await thread("Acme exports", [session]);
			linkWorkstream(w, board);
			expect(w.project).toEqual({
				id: "p-acme",
				key: "ACME-BILLING",
				name: "Acme Billing",
			});
		},
	);

	it("does not link by similar words alone or scattered evidence below 40%", async () => {
		const session = await facts();
		session.workItems = {};
		const board = emptyBoard();
		board.projects = [
			["p-acme", "ACME-BILLING", "Acme Planner billing exports", "Export work"],
		];
		const w = await thread("Acme Planner billing exports", [session]);
		expect(projectEvidence(w.sessions, board).size).toBe(0);
		linkWorkstream(w, board);
		expect(w.project).toBeUndefined();
		const scattered = await Promise.all(
			Array.from({ length: 6 }, async (_, n) => {
				const f = await facts(`acme-scatter-${n}`);
				f.workItems = {};
				f.asks = [{ text: `ACME-PROJECT-${Math.floor(n / 2)}`, at: date }];
				return f;
			}),
		);
		board.projects = [0, 1, 2].map((n) => [
			`p-${n}`,
			`ACME-PROJECT-${n}`,
			`Acme project ${n}`,
			"",
		]);
		const scatteredStream = await thread("Acme initiatives", scattered);
		expect([...projectEvidence(scattered, board).values()]).toEqual([2, 2, 2]);
		linkWorkstream(scatteredStream, board);
		expect(scatteredStream.project).toBeUndefined();
	});

	async function fineThreads(count: number) {
		return Promise.all(
			Array.from({ length: count }, async (_, n) => {
				const f = await facts(`acme-thread-${n}`);
				f.workItems = n < 2 ? { [workId]: 1 } : {};
				return thread(`Acme thread ${n}`, [f]);
			}),
		);
	}

	it("caps garbage-model merges, preserves each session once and keeps shared Work threads together", async () => {
		const fine = await fineThreads(30);
		const board = emptyBoard();
		board.items.set(workId, {
			id: workId,
			title: "Acme exports",
			disposition: "accepted",
			projectId: null,
		});
		const merged = await mergeWorkstreams(
			fine,
			new Map(),
			board,
			async () => "garbage",
		);
		expect(merged.length).toBeLessThanOrEqual(MAX_WORKSTREAMS);
		const keys = merged.flatMap((w) => w.sessions.map((f) => f.key));
		expect(keys.sort()).toEqual(
			fine.flatMap((w) => w.sessions.map((f) => f.key)).sort(),
		);
		expect(new Set(keys).size).toBe(30);
		const shared = merged.find((w) =>
			w.sessions.includes(fine[0]!.sessions[0]!),
		)!;
		expect(shared.sessions).toContain(fine[1]!.sessions[0]!);
		expect(shared.parts.map((p) => p.name)).toEqual(
			expect.arrayContaining(["Acme thread 0", "Acme thread 1"]),
		);
	});

	it("uses model names when merging numbered clusters", async () => {
		const fine = await fineThreads(3);
		const merged = await mergeWorkstreams(
			fine,
			new Map(),
			emptyBoard(),
			async (prompt) => {
				expect(prompt.startsWith(MERGE_PROMPT)).toBe(true);
				return JSON.stringify([
					{
						name: "Acme customer launch",
						description: "Launch the export service",
						clusters: [1, 2, 3],
					},
				]);
			},
		);
		expect(merged).toHaveLength(1);
		expect(merged[0]!.name).toBe("Acme customer launch");
		expect(merged[0]!.parts).toHaveLength(3);
	});

	it("ranks customer deadlines and fresh work higher, excluding the common internal org", async () => {
		const streams = await fineThreads(4);
		const summaries = new Map(
			streams.map((w, n) => [
				w.sessions[0]!.key,
				toSummary({
					...summary(),
					orgs: n === 0 ? ["Acme", "Quill Labs"] : ["Acme"],
				}),
			]),
		);
		streams[0]!.state = "Customer brief due tomorrow";
		streams[2]!.to = "2026-02-09T10:00:00Z";
		const ranked = priorities(streams, summaries, "2026-03-01");
		const priority = (n: number) =>
			ranked.find((p) => p.workstream === streams[n])!;
		expect(ranked[0]!.workstream).toBe(streams[0]!);
		expect(priority(0).customers).toEqual(["Quill Labs"]);
		expect(priority(0).signals).toContain("deadline");
		expect(priority(0).score).toBeGreaterThan(priority(1).score);
		expect(priority(2).daysAgo).toBe(20);
		expect(priority(2).score).toBeLessThan(priority(1).score);
		for (const p of ranked) expect(p.customers).not.toContain("Acme");
		const known = priorities(streams, summaries, "2026-03-01", ["Orbit Co"]);
		for (const p of known) expect(p.customers).not.toContain("Quill Labs");
	});

	it("keeps clusters apart when the model merges most of a long history", async () => {
		const fine = await fineThreads(40);
		const merged = await mergeWorkstreams(
			fine,
			new Map(),
			emptyBoard(),
			async () =>
				JSON.stringify([
					{
						name: "Everything at Acme",
						clusters: Array.from({ length: 20 }, (_, n) => n + 1),
					},
				]),
		);
		expect(merged.map((w) => w.name)).not.toContain("Everything at Acme");
		expect(merged.length).toBeLessThanOrEqual(MAX_WORKSTREAMS);
	});

	it("filters housekeeping, fills strategic actions from ranked workstreams and passes week text through", async () => {
		const streams = await fineThreads(4);
		const ranked = priorities(streams, new Map(), "2026-03-01");
		const week = "You built Acme exports. Quill Labs needs a launch brief.";
		const result = await planNow({
			ranked,
			goals: [],
			notes: [],
			today: "2026-03-01",
			run: async (prompt) => {
				expect(prompt.startsWith(PLAN_PROMPT)).toBe(true);
				return JSON.stringify({
					week,
					actions: [
						"Verify exports",
						"Commit export changes",
						"Run type-check on exports",
						"Confirm the release",
						"Draft customer brief",
					].map((title) => ({
						title,
						why: "Acme launch",
						workstream: streams[0]!.name,
						kind: "delegate",
						start: "Gather requirements",
					})),
				});
			},
		});
		expect(result.week).toBe(week);
		expect(result.actions).toHaveLength(3);
		expect(result.actions[0]!.title).toBe("Draft customer brief");
		expect(result.actions.slice(1).map((a) => [a.workstream, a.kind])).toEqual([
			[ranked[1]!.workstream.name, "doc"],
			[ranked[2]!.workstream.name, "doc"],
		]);
		for (const a of result.actions)
			expect(a.title).not.toMatch(/^(Verify|Commit|Run type-check|Confirm) /);
	});

	it("spreads the three actions over different workstreams before repeating one", async () => {
		const streams = await fineThreads(2);
		const ranked = priorities(streams, new Map(), "2026-03-01");
		const action = (title: string, n: number) => ({
			title,
			why: "Acme launch",
			workstream: streams[n]!.name,
			kind: "delegate",
			start: "Gather requirements",
		});
		const result = await planNow({
			ranked,
			goals: [],
			notes: [],
			today: "2026-03-01",
			pending: ["Draft the Acme brief"],
			run: async (prompt) => {
				expect(prompt).toContain("ALREADY IN THEIR INBOX FROM AN EARLIER RUN");
				expect(prompt).toContain("- Draft the Acme brief");
				return JSON.stringify({
					week: "",
					actions: [
						action("Draft the Acme brief", 0),
						action("Delegate the Acme pricing study", 0),
						action("Set up the Orbit report factory", 1),
					],
				});
			},
		});
		expect(result.actions.map((a) => a.title)).toEqual([
			"Draft the Acme brief",
			"Set up the Orbit report factory",
			"Delegate the Acme pricing study",
		]);
	});

	it("renders unlinked work and its parts in two separate lists", async () => {
		const fine = await fineThreads(2);
		const streams = await mergeWorkstreams(
			fine,
			new Map(),
			emptyBoard(),
			async () => JSON.stringify([{ name: "Acme launch", clusters: [1, 2] }]),
		);
		streams[0]!.parts[0]!.line = "Export requirements ready";
		const blocks = renderDocument({
			who: "Mara Quill",
			sessions: streams[0]!.sessions,
			files: 2,
			summaries: new Map(),
			workstreams: streams,
			profile: profile(),
			actions: [],
			model: "fake",
			meter: newMeter(),
			seconds: 0,
			today: "2026-03-01",
		});
		const heading = blocks.findIndex(
			(b) => b.type === "heading" && b.text === "Acme launch",
		);
		const lists = blocks
			.slice(heading + 1, heading + 4)
			.filter((b) => b.type === "list");
		expect(lists).toHaveLength(2);
		expect(lists[0]!.items.some((item) => item.includes("No board link"))).toBe(
			true,
		);
		expect(lists[1]!.items).toHaveLength(2);
		expect(lists[1]!.items[0]).toContain("Acme thread 0");
		expect(lists[1]!.items[0]).toContain("Export requirements ready");
		expect(lists[1]!.items[1]).toContain("Acme thread 1");
	});
});

describe("stable workstream identity", () => {
	it("keeps names, descriptions and ids after a model rename and small regrouping", async () => {
		const sessions = await Promise.all(
			Array.from({ length: 10 }, (_, i) => facts(`stable-${i}`)),
		);
		const first = stabilizeWorkstreams([
			await thread("Billing exports", sessions),
		]);
		const renamed = await thread("Revenue reports", sessions.slice(1));
		renamed.description = "";
		const second = stabilizeWorkstreams([renamed], first.registry);
		expect(second.workstreams[0]!.key).toBe(first.workstreams[0]!.key);
		expect(second.workstreams[0]!.name).toBe("Billing exports");
		expect(second.workstreams[0]!.description).toBe("Billing exports");
	});

	it("uses a new id and name when the project changes", async () => {
		const w = await thread("Exports", [await facts()]);
		w.project = { id: "project-elm", key: "ELM", name: "Elm" };
		const first = stabilizeWorkstreams([w]);
		const second = stabilizeWorkstreams(
			[
				{
					...w,
					name: "Onboarding",
					project: { id: "project-fir", key: "FIR", name: "Fir" },
				},
			],
			first.registry,
		);
		expect(second.workstreams[0]!.key).not.toBe(first.workstreams[0]!.key);
		expect(second.workstreams[0]!.name).toBe("Onboarding");
	});

	it("matches project, repository and item evidence when sessions are replaced", async () => {
		const original = await thread("Exports", [await facts("old-evidence")]);
		const replacement = await thread("Reports", [await facts("new-evidence")]);
		for (const evidence of ["project", "repository", "items"] as const) {
			const a = structuredClone(original);
			const b = structuredClone(replacement);
			for (const w of [a, b])
				for (const f of w.sessions)
					f.repository = evidence === "repository" ? "acme" : null;
			if (evidence === "project")
				for (const w of [a, b])
					w.project = { id: "project-elm", key: "ELM", name: "Elm" };
			if (evidence === "items")
				for (const w of [a, b])
					w.items = [
						{
							id: workId,
							title: "Exports",
							disposition: "accepted",
							projectId: null,
						},
					];
			const first = stabilizeWorkstreams([a]);
			const second = stabilizeWorkstreams([b], first.registry);
			expect(second.workstreams[0]!.key).toBe(first.workstreams[0]!.key);
			expect(second.workstreams[0]!.name).toBe("Exports");
		}
	});

	it("keeps separate monorepo streams through regrouping and orders new sections last", async () => {
		const sessions = await Promise.all(
			Array.from({ length: 10 }, (_, i) => facts(`mono-${i}`)),
		);
		for (const f of sessions) f.repository = "acme";
		const a = await thread("Exports", sessions.slice(0, 5));
		const b = await thread("Onboarding", sessions.slice(5));
		a.weight = 10;
		b.weight = 5;
		const first = stabilizeWorkstreams([a, b]);
		const nextA = {
			...a,
			name: "Reports",
			weight: 1,
			sessions: sessions.slice(0, 4),
		};
		const nextB = {
			...b,
			name: "Welcome",
			weight: 20,
			sessions: sessions.slice(4),
		};
		const fresh = await thread("Invoices", [
			{ ...(await facts("mono-new")), repository: "acme" },
		]);
		fresh.weight = 100;
		const second = stabilizeWorkstreams([fresh, nextB, nextA], first.registry);
		expect(second.workstreams.map((w) => w.name)).toEqual([
			"Exports",
			"Onboarding",
			"Invoices",
		]);
		expect(second.workstreams.slice(0, 2).map((w) => w.key)).toEqual(
			first.workstreams.map((w) => w.key),
		);
		expect(new Set(second.workstreams.map((w) => w.key)).size).toBe(3);
		const blocks = renderDocument({
			who: "Mara Quill",
			sessions,
			files: 10,
			summaries: new Map(),
			workstreams: [...second.workstreams].reverse(),
			profile: profile(),
			actions: [],
			model: "fake",
			meter: newMeter(),
			seconds: 0,
			today: "2026-03-01",
		});
		expect(
			blocks
				.filter((b) => b.type === "heading")
				.filter((b) => b.level === 3)
				.map((b) => b.text),
		).toEqual(["Exports", "Onboarding", "Invoices"]);
		expect(
			blocks.some(
				(b) => b.type === "heading" && b.text === "Your week in Tedix",
			),
		).toBe(false);
	});

	it("loads old version 1 state and persists bounded registry evidence", async () => {
		const dir = mkdtempSync(join(tmpdir(), "profile-registry-"));
		try {
			const path = join(dir, "state.json");
			writeProfileState(path, { version: 1, facts: {}, summaries: {} });
			const state = readProfileState(path);
			expect(state.workstreams).toBeUndefined();
			const f = await facts();
			const w = await thread(
				"Exports",
				Array.from({ length: 210 }, (_, i) => ({ ...f, key: `bounded-${i}` })),
			);
			state.workstreams = stabilizeWorkstreams([w]).registry;
			writeProfileState(path, state);
			expect(
				Object.values(readProfileState(path).workstreams!)[0]!.sessions,
			).toHaveLength(200);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("week grounding", () => {
	it("drops unsupported versions without confusing their periods with sentence endings", () => {
		expect(
			groundWeek(
				"You released CLI 0.11.2. You finished exports.",
				"CLI 0.10.0 exports",
			),
		).toBe("You finished exports.");
		expect(groundWeek("You released CLI (0.11.2).", "CLI 0.10.0")).toBe(
			"You released CLI.",
		);
		expect(
			groundWeek("You released CLI, v1.2.3-beta, for users.", "CLI v1.1"),
		).toBe("You released CLI for users.");
		expect(groundWeek("You released CLI 0.10.0.", "CLI 0.10.0")).toBe(
			"You released CLI 0.10.0.",
		);
	});

	it("drops unsupported numbers but allows exact evidence, years, dates and computed counts", () => {
		expect(
			groundWeek(
				"You shipped 42 exports. You finished review.",
				"exports review",
			),
		).toBe("You finished review.");
		expect(groundWeek("You shipped exports (42 total).", "exports")).toBe(
			"You shipped exports.",
		);
		expect(groundWeek("You shipped 4 exports.", "14 exports")).toBe("");
		expect(groundWeek("You released v1.2.", "v1.2.3")).toBe("");
		expect(groundWeek("You released 2026.1.", "2026")).toBe("");
		expect(groundWeek("You released v1.2.3-beta.", "v1.2.3-beta")).toBe(
			"You released v1.2.3-beta.",
		);
		const clean = "You worked in 3 sessions on 2026-03-01 in 2026.";
		expect(groundWeek(clean, "", [3])).toBe(clean);
	});

	it("keeps known customers case-insensitively and rejects unknown names at word boundaries", () => {
		const clean =
			"This week you built exports for Quill Labs. The review is open.";
		expect(groundWeek(clean, "quill labs exports review")).toBe(clean);
		expect(
			groundWeek(
				"You built exports for Nebula. You finished review.",
				"Nebulary review",
			),
		).toBe("You finished review.");
		expect(groundWeek("You worked with Élodie.", "exports")).toBe("");
	});

	it("leaves a clean paragraph unchanged", () => {
		const clean =
			"This week you built exports. You have a review open for Monday.";
		expect(groundWeek(clean, "exports review")).toBe(clean);
	});
});
