import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeGitOrigin, type OrganizationTarget } from "./agent-context";
import {
	boardMatchSource,
	type Candidate,
	extractCandidates,
	judge,
	matchBoard,
	memoryNotes,
	planContext,
	planNotes,
	runContext,
	runOnboard,
	runReview,
	type SessionDigest,
} from "./learn-context";
import { emptyUnrouted, sessionLocator } from "./learn-import";

const ORIGIN = "git@github.com:acme/app.git";
const TARGET: OrganizationTarget = {
	status: "bound",
	workspace: "acme",
	org: "org_acme",
	organization: "org_acme",
	mcpUrl: "https://acme.example/mcp",
} as OrganizationTarget;
const T = (day: number, minute = 0) =>
	`2026-03-${String(day).padStart(2, "0")}T10:${String(minute).padStart(2, "0")}:00.000Z`;

function claudeSession(id: string, title: string, asks: string[], day: number) {
	return [
		{ type: "ai-title", aiTitle: title, sessionId: id },
		...asks.flatMap((ask, i) => [
			{
				type: "user",
				sessionId: id,
				cwd: tmpdir(),
				uuid: `${id}-${i}`,
				timestamp: T(day, i * 2),
				message: { role: "user", content: ask },
			},
			{
				type: "assistant",
				sessionId: id,
				timestamp: T(day, i * 2 + 1),
				message: {
					id: `${id}-a${i}`,
					content: [{ type: "text", text: "Done." }],
				},
			},
		]),
	];
}

function codexSession(id: string, asks: string[], day: number) {
	return [
		{
			type: "session_meta",
			timestamp: T(day),
			payload: {
				id,
				cwd: "/x",
				thread_source: "user",
				git: { repository_url: ORIGIN },
			},
		},
		...asks.map((ask, i) => ({
			type: "response_item",
			timestamp: T(day, i + 1),
			payload: {
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: ask }],
			},
		})),
	];
}

/** An in-memory board the Code Mode programs run against. */
class Board {
	items: any[] = [];
	created: any[] = [];
	/** Work interactions, answered as the server does (see work-interactions.ts). */
	interactions: any[] = [];
	constructor(
		public projectRows: any[],
		public me = { id: "Uada0000xyz", name: "Ada Lovelace" },
	) {}
	async run(source: string) {
		const work = {
			list_work_items: async (input: any) => {
				let rows = this.items.filter(
					(r) =>
						(!input.disposition || r.disposition === input.disposition) &&
						(!input.projectId || r.projectId === input.projectId) &&
						(!input.titleContains ||
							r.title
								.toLowerCase()
								.includes(input.titleContains.toLowerCase())),
				);
				const offset = input.offset ?? 0;
				const page = rows.slice(offset, offset + input.limit);
				rows = page;
				return {
					data: rows,
					pagination: { hasMore: offset + input.limit < this.items.length },
				};
			},
			create_work_items: async (input: any) => {
				const row = {
					id: `w-${this.items.length + 1}`,
					disposition: "proposed",
					parentWorkItemId: null,
					createdAt: T(20),
					...input,
				};
				this.items.push(row);
				this.created.push(row);
				return { id: row.id };
			},
			create_work_interaction: async (input: any) => {
				const request = {
					id: `00000000-0000-4000-8000-${String(this.interactions.length + 1).padStart(12, "0")}`,
					version: 1,
					status: "open",
					...input,
				};
				this.interactions.push(request);
				return request;
			},
			list_work_interactions: async (input: any) => ({
				data: this.interactions
					.filter(
						(r) =>
							r.requestedFrom.id === this.me.id &&
							(!input.states || input.states.includes(r.status)),
					)
					.map((request) => ({
						request,
						effectiveState: request.status,
						canRespond: true,
					})),
				hasMore: false,
				nextCursor: null,
			}),
			respond_work_interaction: async (input: any) => {
				const request = this.interactions.find((r) => r.id === input.requestId);
				if (!request || request.status !== "open")
					return { ok: false, error: "conflict" };
				const ids: string[] = [];
				if (input.responseKind === "handoff_accepted") {
					const { proposal } = request.metadata;
					const make = async (item: any, parent?: string) => {
						const existing = this.items.find(
							(r) => r.sourceIntentId === item.sourceIntentId,
						);
						if (existing) return existing.id;
						return (
							await work.create_work_items({
								...item,
								projectId: proposal.projectId,
								...(parent ? { parentWorkItemId: parent } : {}),
							})
						).id;
					};
					ids.push(await make(proposal.item, proposal.parentWorkItemId));
					for (const child of proposal.children)
						ids.push(await make(child, ids[0]));
				}
				request.status = "resolved";
				request.version++;
				return {
					request,
					response: {
						responseKind: input.responseKind,
						metadata: { ...input.metadata, workItemIds: ids },
					},
				};
			},
		};
		const projects = {
			list_projects: async () => ({
				data: this.projectRows,
				pagination: { hasMore: false },
			}),
		};
		const user = { get_mine: async () => this.me };
		const program = new Function(
			"work",
			"projects",
			"user",
			`return (${source})();`,
		);
		return program(work, projects, user);
	}
}

const PROJECTS = [
	{
		id: "p-site",
		key: "SITE",
		name: "Public website",
		status: "active",
		description: "Landing pages and docs",
	},
	{
		id: "p-billing",
		key: "BILLING",
		name: "Billing and invoices",
		status: "active",
		description: null,
	},
];

function digest(
	id: string,
	title: string,
	extra: Partial<SessionDigest> = {},
): SessionDigest {
	return {
		harness: "claude-code",
		sessionId: id,
		title,
		goal: false,
		asks: [],
		repository: "app",
		from: T(1),
		to: T(1, 5),
		...extra,
	};
}

describe("memoryNotes", () => {
	it("reads only preference memories and Codex preference bullets", () => {
		const home = mkdtempSync(join(tmpdir(), "learn-notes-"));
		const memory = join(home, ".claude", "projects", "-app", "memory");
		mkdirSync(memory, { recursive: true });
		writeFileSync(
			join(memory, "short.md"),
			'---\nname: short\ndescription: "Answer in short bullet points, never tables"\nmetadata:\n  type: feedback\n---\nbody',
		);
		writeFileSync(
			join(memory, "client.md"),
			'---\nname: client\ndescription: "The Acme contact is reachable at someone, project detail"\nmetadata:\n  type: project\n---\n',
		);
		writeFileSync(join(memory, "MEMORY.md"), "- [short](short.md)\n");
		mkdirSync(join(home, ".codex", "memories"), { recursive: true });
		writeFileSync(
			join(home, ".codex", "memories", "memory_summary.md"),
			"## User Profile\n\nWorks on billing.\n\n## User preferences\n\n- Draft external messages for review, never send them.\n- ok\n\n## General Tips\n\n- Use the queue for pushes, not raw push.\n",
		);
		const notes = memoryNotes(home);
		expect(notes.map((n) => [n.harness, n.text])).toEqual([
			["claude-code", "Answer in short bullet points, never tables"],
			["codex", "Draft external messages for review, never send them."],
		]);
		const routed = planNotes({
			notes,
			targets: new Map(),
			defaultTarget: TARGET,
			locate: sessionLocator(),
			cwdOf: () => null,
			unrouted: emptyUnrouted(),
		});
		const decisions = routed.get("acme/org_acme")!.decisions;
		expect(decisions).toHaveLength(2);
		expect(decisions[0]).toMatchObject({
			topic: "preference",
			agentMessage: "",
			repository: null,
		});
		// The same note always has the same turn id, so a re-import is a duplicate.
		expect(
			planNotes({
				notes,
				targets: new Map(),
				defaultTarget: TARGET,
				locate: sessionLocator(),
				cwdOf: () => null,
				unrouted: emptyUnrouted(),
			}).get("acme/org_acme")!.decisions[0]!.turnId,
		).toBe(decisions[0]!.turnId);
	});
});

describe("planContext", () => {
	it("digests each session by its title and real asks, routed like the importer", () => {
		const rows: Record<string, any[]> = {
			a: claudeSession(
				"s-a",
				"Fix invoice rounding",
				["status now?", "fix the rounding of invoice totals to two decimals"],
				2,
			),
			b: codexSession(
				"s-b",
				["the invoice totals still round wrong for EUR"],
				3,
			),
		};
		const plan = planContext({
			files: [
				{ harness: "claude-code", path: "a" },
				{ harness: "codex", path: "b" },
			],
			targets: new Map([[normalizeGitOrigin(ORIGIN), TARGET]]),
			defaultTarget: TARGET,
			titles: new Map([["s-b", "Invoice rounding for EUR"]]),
			goals: new Map([
				[
					"s-b",
					"Make invoice totals correct in every currency. Then add tests.",
				],
			]),
			read: (path) => rows[path]!,
			originOf: () => null,
		});
		const sessions = plan.byTarget.get("acme/org_acme")!.sessions;
		expect(sessions.map((s) => [s.title, s.goal, s.asks])).toEqual([
			[
				"Fix invoice rounding",
				false,
				["fix the rounding of invoice totals to two decimals"],
			],
			[
				"Make invoice totals correct in every currency.",
				true,
				["the invoice totals still round wrong for EUR"],
			],
		]);
	});
});

describe("extractCandidates", () => {
	it("keeps topics two sessions share and drops one-offs, without a model", async () => {
		const candidates = await extractCandidates(
			[
				digest("1", "Fix invoice rounding"),
				digest("2", "Invoice rounding fix"),
				digest("3", "Weather this weekend"),
			],
			null,
		);
		expect(candidates.map((c) => [c.title, c.sessions.length])).toEqual([
			["Fix invoice rounding", 2],
		]);
	});

	it("keeps a broad entry its narrower entries explain only as a project", async () => {
		const model = async () =>
			JSON.stringify([
				{
					kind: "goal",
					title: "Grow the public website",
					sessions: [1, 2, 3],
					confidence: 0.8,
				},
				{
					kind: "task",
					title: "Rewrite landing page hero copy",
					sessions: [1, 2],
					confidence: 0.8,
				},
				{
					kind: "task",
					title: "Add pricing page FAQ section",
					sessions: [3],
					confidence: 0.9,
				},
			]);
		const candidates = await extractCandidates(
			[digest("1", "Hero"), digest("2", "Hero copy"), digest("3", "FAQ")],
			model,
		);
		expect(candidates.map((c) => [c.kind, c.title])).toEqual([
			["project", "Grow the public website"],
			["task", "Rewrite landing page hero copy"],
			["task", "Add pricing page FAQ section"],
		]);
	});
});

function candidate(title: string, extra: Partial<Candidate> = {}): Candidate {
	return {
		key: title.toLowerCase().replace(/\W+/g, "-"),
		kind: "task",
		title,
		confidence: 0.8,
		sessions: ["1", "2"],
		from: T(1),
		to: T(2),
		goal: false,
		...extra,
	};
}

describe("board match and judge", () => {
	it("finds completed work older than the sessions, places new work and never files a goal", async () => {
		const board = new Board(PROJECTS);
		board.items = [
			{
				id: "w-old",
				title: "Fix the rounding of invoice totals",
				projectId: "p-billing",
				disposition: "completed",
				parentWorkItemId: null,
				createdAt: "2020-03-01T00:00:00.000Z",
			},
			{
				id: "w-open",
				title: "Refresh the landing page",
				projectId: "p-site",
				disposition: "accepted",
				parentWorkItemId: null,
				createdAt: T(1),
			},
		];
		const candidates = [
			candidate("Fix invoice totals rounding"),
			candidate("Add a pricing FAQ to the public website"),
			candidate("Grow the public website", { kind: "goal", sessions: ["3"] }),
			candidate("Plan a holiday trip", { sessions: ["4", "5"] }),
		];
		const matches = await board.run(
			boardMatchSource({
				candidates: candidates.map((c) => ({ k: c.key, t: c.title })),
				dispositions: ["proposed", "accepted", "completed"],
				projects: true,
			}),
		);
		expect(matches.me.id).toBe("Uada0000xyz");
		const proposals = await judge(candidates, matches, null, new Map());
		expect(
			proposals.map((p) => [p.action, p.workId ?? p.projectKey ?? null]),
		).toEqual([
			["tracked", "w-old"],
			["create", "SITE"],
			["tracked", "SITE"],
			["unplaced", null],
		]);
	});

	it("splits many candidates across programs so no result outgrows the gateway cap", async () => {
		const board = new Board(PROJECTS);
		board.items = [
			{
				id: "w-1",
				title: "Topic 17 work",
				projectId: "p-site",
				disposition: "accepted",
				parentWorkItemId: null,
				createdAt: T(1),
			},
		];
		const sources: string[] = [];
		const many = Array.from({ length: 20 }, (_, i) =>
			candidate(`Topic ${i} work`),
		);
		const result = await matchBoard(many, (source) => {
			sources.push(source);
			return board.run(source);
		});
		expect(sources).toHaveLength(13);
		expect(Object.keys(result.matches)).toHaveLength(20);
		expect(result.matches[many[17]!.key]!.w[0]![0]).toBe("w-1");
		expect(result.me?.name).toBe("Ada Lovelace");
	});

	it("takes a second, focused look before proposing something close to an item", async () => {
		const candidates = [candidate("Stop the signup email abuse")];
		const board = {
			me: null,
			scanned: {},
			matches: {
				[candidates[0]!.key]: {
					w: [
						[
							"w-5",
							"Email abuse response: signup monitor and send cap",
							"p-billing",
							"accepted",
							null,
							0.45,
						] as any,
					],
					p: [["p-billing", "BILLING", "Billing and invoices", 0.3] as any],
				},
			},
		};
		const prompts: string[] = [];
		const model = async (prompt: string) => {
			prompts.push(prompt);
			return prompt.startsWith("Below is a piece of work")
				? "1"
				: '[{"c":1,"same":"","parent":"","project":"P1"}]';
		};
		const [proposal] = await judge(candidates, board, model, new Map());
		expect(proposal).toMatchObject({ action: "tracked", workId: "w-5" });
		expect(
			prompts.filter((p) => p.startsWith("Below is a piece of work")),
		).toHaveLength(1);
	});

	it("trusts the model's covering match and ignores references it did not offer", async () => {
		const candidates = [candidate("Ship the invoice export")];
		const board = {
			me: null,
			scanned: {},
			matches: {
				[candidates[0]!.key]: {
					w: [
						[
							"w-9",
							"Export invoices as CSV",
							"p-billing",
							"accepted",
							null,
							0.3,
						] as any,
					],
					p: [["p-billing", "BILLING", "Billing and invoices", 0.3] as any],
				},
			},
		};
		const same = await judge(
			candidates,
			board,
			async () => '[{"c":1,"same":"W1","parent":"","project":"P1"}]',
			new Map(),
		);
		expect(same[0]).toMatchObject({ action: "tracked", workId: "w-9" });
		const bogus = await judge(
			candidates,
			board,
			async () => '[{"c":1,"same":"W7","parent":"","project":"P1"}]',
			new Map(),
		);
		expect(bogus[0]).toMatchObject({ action: "create", projectKey: "BILLING" });
	});

	const SECOND = "Below is a piece of work";
	const closeBoard = (key: string, w: any[]) => ({
		me: null,
		scanned: {},
		matches: { [key]: { w, p: [] } },
		projects: [
			["p-billing", "BILLING", "Billing and invoices", ""],
			["p-site", "SITE", "Public website", "Landing pages and docs"],
		] as any,
	});

	it("files a specific task under a broad open item instead of calling it covered", async () => {
		const [c] = [candidate("Reconcile the September card payouts")];
		const board = closeBoard(c!.key, [
			[
				"w-close",
				"Reconcile January to September periods",
				"p-billing",
				"proposed",
				null,
				0.4,
			],
		]);
		// One batch vote calls the broad item covering, the other does not.
		let votes = 0;
		const [proposal] = await judge(
			[c!],
			board,
			async (prompt) =>
				prompt.startsWith(SECOND)
					? "B1"
					: votes++ === 0
						? '[{"c":1,"same":"W1","parent":"","project":"P1"}]'
						: '[{"c":1,"same":"","parent":"W1","project":"P1"}]',
			new Map(),
		);
		expect(proposal).toMatchObject({
			action: "create",
			projectKey: "BILLING",
			parentId: "w-close",
		});
		// Both votes agreeing on the match keeps it: a duplicate costs more.
		const agreed = await judge(
			[c!],
			board,
			async (prompt) =>
				prompt.startsWith(SECOND)
					? "B1"
					: '[{"c":1,"same":"W1","parent":"","project":"P1"}]',
			new Map(),
		);
		expect(agreed[0]).toMatchObject({ action: "tracked", workId: "w-close" });
	});

	it("checks a proposed parent even below the word-match threshold before creating a duplicate", async () => {
		const c = candidate("Tighten event pitch script and speaker notes");
		const board = closeBoard(c.key, [
			[
				"w-pitch",
				"Prepare and give the event pitch",
				"p-site",
				"proposed",
				null,
				0.34,
			],
		]);
		const prompts: string[] = [];
		const [proposal] = await judge(
			[c],
			board,
			async (prompt) => {
				prompts.push(prompt);
				return prompt.startsWith(SECOND)
					? "1"
					: '[{"c":1,"same":"","parent":"W1","project":"P1"}]';
			},
			new Map(),
		);
		expect(prompts.some((p) => p.startsWith(SECOND))).toBe(true);
		expect(proposal).toMatchObject({ action: "tracked", workId: "w-pitch" });
	});

	it("drops a match on words alone the second look rejects, and ignores a chatty answer", async () => {
		const [c] = [candidate("Keyboard navigation for the console")];
		const board = closeBoard(c!.key, [
			[
				"w-ime",
				"Make console keyboard actions IME-safe",
				"p-site",
				"completed",
				null,
				0.62,
			],
		]);
		const judged = (second: string) =>
			judge(
				[c!],
				board,
				async (prompt) =>
					prompt.startsWith(SECOND)
						? second
						: '[{"c":1,"same":"","parent":"","project":"P2"}]',
				new Map(),
			);
		expect((await judged("0"))[0]).toMatchObject({
			action: "create",
			projectKey: "SITE",
		});
		// Not a bare answer: the words still decide.
		expect(
			(await judged("I can't see item 1 in your message"))[0],
		).toMatchObject({
			action: "tracked",
			workId: "w-ime",
		});
	});

	it("places with the whole project catalog, not only the closest words", async () => {
		const [c] = [candidate("Translate the one-pager into German")];
		const prompts: string[] = [];
		const [proposal] = await judge(
			[c!],
			closeBoard(c!.key, []),
			async (prompt) => {
				prompts.push(prompt);
				return '[{"c":1,"same":"","parent":"","project":"P2"}]';
			},
			new Map(),
		);
		expect(proposal).toMatchObject({ action: "create", projectKey: "SITE" });
		expect(prompts[0]).toContain(
			"P2 SITE: Public website. Landing pages and docs",
		);
	});
});

describe("epics and names", () => {
	it("turns sessions a project folded in into its tasks, and the epic's tasks go where it goes", async () => {
		const sessions = [1, 2, 3, 4].map((n) =>
			digest(String(n), `Garden planner part ${n}`, {
				asks: [`build garden planner part ${n} for my phone app`],
			}),
		);
		const model = async () =>
			JSON.stringify([
				{
					kind: "project",
					title: "Garden planner app",
					sessions: [1, 2, 3, 4],
					confidence: 0.9,
				},
				{
					kind: "task",
					title: "Build the seed catalog screen",
					sessions: [1],
					confidence: 0.9,
				},
				{ kind: "people", names: [] },
			]);
		const candidates = await extractCandidates(sessions, model);
		expect(
			candidates
				.filter((c) => c.kind === "task")
				.map((c) => c.title)
				.sort(),
		).toEqual([
			"Build the seed catalog screen",
			"Garden planner part 2",
			"Garden planner part 3",
			"Garden planner part 4",
		]);
		const board = {
			me: null,
			scanned: {},
			matches: {},
			projects: [["p-cat", "CATALOG", "MCP catalog apps", ""]] as any,
		};
		// The judge put the catalog screen in the MCP catalog project on a shared word.
		const proposals = await judge(
			candidates,
			board,
			async (prompt) =>
				prompt.startsWith("Each numbered")
					? JSON.stringify(
							candidates.map((c, i) => ({
								c: i + 1,
								same: "",
								parent: "",
								project: c.title.includes("catalog") ? "P1" : "",
							})),
						)
					: "0",
			new Map(),
		);
		const epic = proposals.find((p) => p.children?.length);
		expect(epic).toMatchObject({
			title: "Garden planner app",
			action: "create",
		});
		expect(epic!.projectId).toBeUndefined();
		expect(epic!.children!.map((c) => c.projectId)).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	it("takes the names of people the model saw out of session titles and its own titles", async () => {
		const sessions = [
			digest("1", "Outreach to Jana Kowalski at Northwind", {
				asks: ["write outreach to the Northwind ops lead"],
			}),
			digest("2", "Northwind outreach v2 with Jana", {
				asks: ["revise the Northwind outreach"],
			}),
		];
		const candidates = await extractCandidates(sessions, async () =>
			JSON.stringify([
				{
					kind: "task",
					title: "Write outreach sequence for Jana at Northwind",
					sessions: [1, 2],
					confidence: 0.8,
				},
				{ kind: "people", names: ["Jana Kowalski"] },
			]),
		);
		expect(candidates[0]!.title).toBe(
			"Write outreach sequence for [name] at Northwind",
		);
		expect(sessions.map((s) => s.title)).toEqual([
			"Outreach to [name] [name] at Northwind",
			"Northwind outreach v2 with [name]",
		]);
		expect(candidates[0]!.context).not.toContain("Jana");
	});
});

describe("context and review", () => {
	const rows: Record<string, any[]> = {
		a: claudeSession(
			"s-a",
			"Add pricing FAQ to the public website",
			["add a pricing FAQ section to the public website"],
			2,
		),
		b: claudeSession(
			"s-b",
			"Pricing FAQ for the public website",
			["the website pricing FAQ needs three more questions"],
			3,
		),
		c: claudeSession(
			"s-c",
			"Fix invoice rounding",
			["fix the rounding of invoice totals"],
			4,
		),
		d: claudeSession(
			"s-d",
			"Invoice rounding again",
			["invoice totals rounding is still off"],
			5,
		),
	};
	const files = Object.keys(rows).map((path) => ({
		harness: "claude-code" as const,
		path,
	}));

	function deps(board: Board, stateDir: string, out: string[]) {
		return {
			files,
			readFile: (path: string) => rows[path]!,
			home: "/nonexistent-home",
			targets: new Map(),
			defaultTarget: TARGET,
			originOf: () => null,
			stateDir,
			write: (line: string) => out.push(line),
			read: async (args: string[], _timeout: number, source?: string) => {
				expect(args).toEqual([
					"-w",
					"acme",
					"--organization",
					"org_acme",
					"code",
				]);
				return board.run(source!);
			},
		};
	}

	it("proposes first, files only what is accepted, and a re-run creates nothing new", async () => {
		const board = new Board(PROJECTS);
		board.items = [
			{
				id: "w-old",
				title: "Fix the rounding of invoice totals",
				projectId: "p-billing",
				disposition: "completed",
				parentWorkItemId: null,
				createdAt: T(1),
			},
		];
		const stateDir = mkdtempSync(join(tmpdir(), "learn-state-"));
		const out: string[] = [];
		expect(await runContext(["--no-model"], deps(board, stateDir, out))).toBe(
			0,
		);
		expect(board.created).toHaveLength(0);
		const text = out.join("\n");
		expect(text).toContain("Already on the board (1)");
		expect(text).toContain("now in your Tedix inbox");
		expect(text).toContain("1. Add pricing FAQ to the public website -> SITE");
		// The proposal waits in the member's inbox, with its evidence.
		expect(board.interactions).toHaveLength(1);
		const [request] = board.interactions;
		expect(request).toMatchObject({
			kind: "handoff",
			projectId: "p-site",
			subject: "Add to the board: Add pricing FAQ to the public website",
			requestedFrom: { type: "user", id: "Uada0000xyz" },
			metadata: {
				schema: "tedix.work-proposal.v1",
				proposal: { projectId: "p-site", children: [] },
			},
		});
		expect(
			request.metadata.evidence.citations.map((c: any) => c.session),
		).toEqual(["s-a", "s-b"]);
		expect(request.prompt).toContain("Sessions it came from:");

		// A re-run before anyone answered asks nothing new.
		out.length = 0;
		await runContext(["--no-model"], deps(board, stateDir, out));
		expect(board.interactions).toHaveLength(1);
		expect(out.join("\n")).toContain(
			"Asked or decided earlier and not asked again: 1",
		);

		out.length = 0;
		expect(
			await runReview(["--accept", "all"], deps(board, stateDir, out)),
		).toBe(0);
		expect(
			board.created.map((r) => [
				r.title,
				r.projectId,
				r.sourceIntentId.startsWith("learn-context:Uada0000xyz:"),
			]),
		).toEqual([["Add pricing FAQ to the public website", "p-site", true]]);
		expect(board.created[0]!.description).toContain(
			"Proposed from Ada's local agent sessions",
		);

		// Running again: the accepted item is on the board now; nothing to review.
		out.length = 0;
		await runContext(["--no-model"], deps(board, stateDir, out));
		expect(out.join("\n")).toContain("Nothing to review");
		out.length = 0;
		await runReview(["--accept", "all"], deps(board, stateDir, out));
		expect(board.created).toHaveLength(1);

		// A second member with the same work finds it on the board, not a duplicate.
		const second = new Board(PROJECTS, {
			id: "Ugrace000",
			name: "Grace Hopper",
		});
		second.items = board.items;
		const otherOut: string[] = [];
		await runContext(
			["--no-model"],
			deps(second, mkdtempSync(join(tmpdir(), "learn-state-")), otherOut),
		);
		expect(otherOut.join("\n")).toContain("Nothing to review");
		expect(second.created).toHaveLength(0);
	});

	it("keeps a new member's proposals and decisions in their own inbox on a shared machine", async () => {
		const board = new Board(PROJECTS);
		const stateDir = mkdtempSync(join(tmpdir(), "learn-state-"));
		const out: string[] = [];
		await runContext(["--no-model"], deps(board, stateDir, out));
		await runReview(["--reject", "all"], deps(board, stateDir, out));
		const firstMember = board.me;
		const earlier = [...board.interactions];

		board.me = { id: "Ugrace000", name: "Grace Hopper" };
		await runContext(["--no-model"], deps(board, stateDir, out));
		const own = board.interactions.slice(earlier.length);
		expect(own).toHaveLength(2);
		expect(own.every((r) => r.requestedFrom.id === board.me.id)).toBe(true);
		expect(
			own.every((r) =>
				r.metadata.proposal.item.sourceIntentId.startsWith(
					`learn-context:${board.me.id}:`,
				),
			),
		).toBe(true);
		await runContext(["--no-model"], deps(board, stateDir, out));
		expect(board.interactions).toHaveLength(4);

		await runReview(["--accept", "all"], deps(board, stateDir, out));
		expect(board.created).toHaveLength(2);
		expect(board.created.every((r) => r.description.includes("Grace's"))).toBe(
			true,
		);
		expect(
			earlier.every(
				(r) => r.requestedFrom.id === firstMember.id && r.status === "resolved",
			),
		).toBe(true);
		await runContext(["--no-model"], deps(board, stateDir, out));
		expect(board.interactions).toHaveLength(4);
		expect(board.created).toHaveLength(2);
	});

	it("remembers a rejection and never asks again", async () => {
		const board = new Board(PROJECTS);
		const stateDir = mkdtempSync(join(tmpdir(), "learn-state-"));
		const out: string[] = [];
		await runContext(["--no-model"], deps(board, stateDir, out));
		const answers = ["n"];
		await runReview([], {
			...deps(board, stateDir, out),
			ask: async () => answers.shift() ?? "q",
		});
		expect(board.created).toHaveLength(0);
		expect(board.interactions[0].status).toBe("resolved");
		out.length = 0;
		// Even from a fresh machine: the decline lives in Tedix, not locally.
		await runContext(
			["--no-model"],
			deps(board, mkdtempSync(join(tmpdir(), "learn-state-")), out),
		);
		expect(out.join("\n")).toContain(
			"Asked or decided earlier and not asked again: 2",
		);
		expect(board.interactions).toHaveLength(2);
	});

	it("proposes a body of work no project fits as one epic with its tasks", async () => {
		const board = new Board([]);
		board.items = [
			{
				id: "w-analysis",
				title:
					"Session analysis: repeated requests to turn into skills or commands",
				sourceIntentId: "session-analysis:repeated-requests:v1",
				projectId: "p-x",
				disposition: "accepted",
				parentWorkItemId: null,
				createdAt: T(1),
			},
		];
		const stateDir = mkdtempSync(join(tmpdir(), "learn-state-"));
		const runModel = async (prompt: string) =>
			prompt.startsWith("Below are numbered")
				? JSON.stringify([
						{
							kind: "project",
							title: "Garden planner app",
							sessions: [1, 2, 3, 4],
							confidence: 0.9,
						},
						{
							kind: "task",
							title: "Add pricing FAQ to the planner",
							sessions: [1, 2],
							confidence: 0.8,
						},
						{
							kind: "task",
							title: "Fix invoice rounding in the planner",
							sessions: [3],
							confidence: 0.8,
						},
						{
							kind: "task",
							title: "Write planner onboarding emails",
							sessions: [4],
							confidence: 0.8,
						},
					])
				: "[]";
		const out: string[] = [];
		expect(
			await runContext([], { ...deps(board, stateDir, out), runModel }),
		).toBe(0);
		expect(board.interactions).toHaveLength(1);
		const [request] = board.interactions;
		expect(request.workItemId).toBe("w-analysis");
		expect(request.subject).toBe(
			"New epic for the board: Garden planner app (3 tasks)",
		);
		expect(
			request.metadata.proposal.children.map((c: any) => c.title).sort(),
		).toEqual([
			"Add pricing FAQ to the planner",
			"Fix invoice rounding in the planner",
			"Write planner onboarding emails",
		]);
		await runReview(["--accept", "1"], deps(board, stateDir, out));
		const [epic, ...tasks] = board.created;
		expect(epic.title).toBe("Garden planner app");
		expect(tasks.map((t) => t.parentWorkItemId)).toEqual([
			epic.id,
			epic.id,
			epic.id,
		]);
	});

	it("asks the model once per prompt across runs, so a re-run proposes the same", async () => {
		const board = new Board(PROJECTS);
		const stateDir = mkdtempSync(join(tmpdir(), "learn-state-"));
		let calls = 0;
		const runModel = async (prompt: string) => {
			calls++;
			return prompt.startsWith("Below are numbered")
				? `[{"kind":"task","title":"Add pricing FAQ to the public website","sessions":[1,2],"confidence":${0.7 + calls / 100}}]`
				: "[]";
		};
		const out: string[] = [];
		await runContext([], { ...deps(board, stateDir, out), runModel });
		const first = calls;
		const firstText = out.join("\n");
		out.length = 0;
		await runContext([], { ...deps(board, stateDir, out), runModel });
		expect(calls).toBe(first);
		expect(firstText).toContain("1. Add pricing FAQ to the public website");
		// The same proposal again, so it is recognized and not asked twice.
		expect(out.join("\n")).toContain("not asked again: 1");
	});

	it("a dry run reads the board but saves and files nothing", async () => {
		const board = new Board(PROJECTS);
		const stateDir = join(mkdtempSync(join(tmpdir(), "learn-state-")), "never");
		const out: string[] = [];
		await runContext(["--no-model", "--dry-run"], deps(board, stateDir, out));
		expect(out.join("\n")).toContain("Dry run: nothing was saved or sent.");
		out.length = 0;
		await runReview([], deps(board, stateDir, out));
		expect(out.join("\n")).toContain("No proposals to review");
	});

	it("onboard previews 100 sessions without a model, gateway or worker", async () => {
		const out: string[] = [];
		const sessions = Object.fromEntries(
			Array.from({ length: 100 }, (_, i) => [
				`session-${i}`,
				claudeSession(
					`s-${i}`,
					"Build fictional Acme planner",
					["Build the planner interface"],
					1,
				),
			]),
		);
		const stateDir = join(mkdtempSync(join(tmpdir(), "learn-state-")), "never");
		const forbidden = async () => {
			throw new Error("Preview must stay local and skip the model");
		};
		const started = performance.now();
		expect(
			await runOnboard(["--dry-run"], {
				...deps(new Board(PROJECTS), stateDir, out),
				files: Object.keys(sessions).map((path) => ({
					harness: "claude-code",
					path,
				})),
				readFile: (path) => sessions[path]!,
				read: forbidden,
				runModel: forbidden,
				startWorker: () => {
					throw new Error("No worker in preview");
				},
			}),
		).toBe(0);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(out.join("\n")).toContain(
			"100 sessions (claude-code: 100, codex: 0), 0 preference notes",
		);
		expect(out.join("\n")).toContain("Build fictional Acme planner");
		expect(out.join("\n")).toContain("nothing was saved or sent");
		expect(existsSync(stateDir)).toBe(false);
	});

	it("onboard full dry run opts into the model with a duration warning", async () => {
		const out: string[] = [];
		let modelCalls = 0;
		const board = new Board(PROJECTS);
		const stateDir = join(mkdtempSync(join(tmpdir(), "learn-state-")), "never");
		expect(
			await runOnboard(["--dry-run", "--with-model"], {
				...deps(board, stateDir, out),
				runModel: async () => {
					modelCalls++;
					return "[]";
				},
			}),
		).toBe(0);
		expect(modelCalls).toBeGreaterThan(0);
		expect(out[0]).toContain("takes a few minutes");
		expect(out.at(-1)).toBe("Preview finished. Nothing was saved or sent.");
		expect(board.created).toHaveLength(0);
		expect(board.interactions).toHaveLength(0);
		expect(existsSync(stateDir)).toBe(false);
	});

	it("onboard hands off to a background worker and returns", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "learn-state-"));
		const started: string[][] = [];
		const out: string[] = [];
		const onboardDeps = {
			...deps(new Board(PROJECTS), stateDir, out),
			startWorker: (args: string[]) => {
				started.push(args);
				return 4242;
			},
			alive: () => true,
		};
		expect(await runOnboard(["--no-model"], onboardDeps)).toBe(0);
		expect(started).toEqual([["--no-model", "--worker"]]);
		expect(out.join("\n")).toContain("Tedix inbox");
		expect(out.join("\n")).toContain("Next: open Tedix > Work > Needs you");
		// A run that is still going is not started twice.
		writeFileSync(
			join(stateDir, "onboard.json"),
			JSON.stringify({
				pid: 4242,
				args: ["--no-model"],
				startedAt: T(1),
				done: {},
			}),
		);
		out.length = 0;
		await runOnboard(["--no-model"], onboardDeps);
		expect(started).toHaveLength(1);
		expect(out.join("\n")).toContain("already running");
	});

	it("a restarted worker resumes after the steps it finished", async () => {
		const board = new Board(PROJECTS);
		const stateDir = mkdtempSync(join(tmpdir(), "learn-state-"));
		writeFileSync(
			join(stateDir, "onboard.json"),
			JSON.stringify({
				pid: 1,
				args: ["--no-model"],
				startedAt: T(1),
				done: { import: T(1), analyze: T(1) },
			}),
		);
		const out: string[] = [];
		expect(
			await runOnboard(["--no-model", "--worker"], {
				...deps(board, stateDir, out),
				alive: () => false,
			}),
		).toBe(0);
		const text = out.join("\n");
		expect(text).toContain("import: finished in the earlier run, skipped.");
		expect(text).toContain("analyze: finished in the earlier run, skipped.");
		expect(text).toContain("Onboarding finished.");
		expect(out.at(-1)).toBe(
			"Onboarding finished. Next: open Tedix > Work > Needs you and accept or decline your proposals.",
		);
		expect(board.interactions.length).toBeGreaterThan(0);
	});
});
