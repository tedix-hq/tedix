import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { CardReviewConfig } from "@tedix/api-contract/schemas/os-card-review";
import type {
	WebMcpToolDef,
	WebMcpToolResult,
} from "@tedix/webmcp-core/model-context";
import {
	setModelContextResolverForTests,
	setWebMcpInvocationObserver,
} from "@tedix/webmcp-core/registry";

type Cell = string | number | boolean | null;
type Sheet = {
	id: string;
	title: string;
	revision: number;
	columns: string[];
	rows: Cell[][];
};

const api = vi.hoisted(() => ({
	outputs: { list: vi.fn(), get: vi.fn(), setSheetRange: vi.fn() },
	schedules: { runNow: vi.fn(), setPersonalAccess: vi.fn() },
}));

vi.mock("@/lib/api", () => ({ osApi: { osWorkspaces: api } }));

import { CardReviewApp } from "./card-review-app";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const CARDS_ID = "44444444-4444-4444-8444-444444444444";
const RULES_ID = "55555555-5555-4555-8555-555555555555";

const config: CardReviewConfig = {
	version: 1,
	sources: [
		{
			label: "Social",
			workspaceId: WORKSPACE_ID,
			cardSheetPrefix: "Social cards ",
			maxRuns: 3,
			columns: {
				number: "#",
				type: "Type",
				source: "Source",
				who: "Who",
				why: "Why",
				draft: "Draft",
				useful: "Useful?",
				reason: "Reason",
				done: "Did it?",
			},
			doIt: "approve",
			rules: {
				sheetTitle: "Rules",
				idColumn: "Rule id",
				textColumn: "Rule",
				statusColumn: "Status",
			},
			channels: [
				{ label: "LinkedIn", match: ["linkedin.com"] },
				{ label: "X", match: ["x.com"] },
			],
		},
	],
};

let sheets: Map<string, Sheet>;

function seed() {
	sheets = new Map([
		[
			CARDS_ID,
			{
				id: CARDS_ID,
				title: "Social cards 2026-10-01",
				revision: 1,
				columns: [
					"#",
					"Type",
					"Source",
					"Who",
					"Why",
					"Draft",
					"Useful?",
					"Reason",
					"Did it?",
				],
				rows: [
					[
						"1",
						"Comment",
						"https://linkedin.com/posts/mira-okafor-1",
						"Mira Okafor",
						"R9: asked about pricing",
						"Happy to share our notes.",
						null,
						null,
						null,
					],
					[
						"2",
						"Reply",
						"https://x.com/jonasfeld/status/2",
						"Jonas Feld",
						"Mentioned the launch",
						"Thanks for the mention!",
						null,
						null,
						null,
					],
					[
						"3",
						"Comment",
						"https://linkedin.com/posts/ada-lind-3",
						"Ada Lind",
						"New role",
						"Congratulations!",
						null,
						null,
						null,
					],
				],
			},
		],
		[
			RULES_ID,
			{
				id: RULES_ID,
				title: "Rules",
				revision: 1,
				columns: ["Rule id", "Rule", "Status"],
				rows: [
					["R9", "Flag pricing questions", "active"],
					["R10", "Skip reposts", "proposed"],
				],
			},
		],
	]);
}

function outputRow(sheet: Sheet) {
	return {
		id: sheet.id,
		organizationId: "org_fictional",
		workspaceId: WORKSPACE_ID,
		kind: "sheet",
		title: sheet.title,
		status: "active",
		currentRevisionId: "66666666-6666-4666-8666-666666666666",
		createdByKind: "user",
		createdById: "user_fictional",
		createdAt: "2026-10-01T08:00:00.000Z",
		updatedAt: "2026-10-01T08:00:00.000Z",
	};
}

function detail(sheet: Sheet) {
	return {
		output: outputRow(sheet),
		currentRevision: {
			revision: sheet.revision,
			content: { kind: "sheet", columns: sheet.columns, rows: sheet.rows },
		},
	};
}

let tools: WebMcpToolDef[] = [];
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
	seed();
	// Invocation telemetry posts to the network; it has its own suite.
	setWebMcpInvocationObserver(null);
	tools = [];
	setModelContextResolverForTests(() => ({
		provideContext: (context) => {
			tools = context.tools;
		},
	}));
	api.outputs.list.mockImplementation(async () => ({
		items: [...sheets.values()].map(outputRow),
		truncated: false,
	}));
	api.outputs.get.mockImplementation(async ({ outputId }) =>
		detail(sheets.get(outputId)!),
	);
	api.outputs.setSheetRange.mockImplementation(
		async ({ outputId, startRow, startColumn, cells, expectedRevision }) => {
			const sheet = sheets.get(outputId)!;
			if (expectedRevision !== sheet.revision)
				throw Object.assign(new Error("conflict"), { code: "CONFLICT" });
			(cells as Cell[][]).forEach((row, r) =>
				row.forEach((value, c) => {
					sheet.rows[startRow + r]![startColumn + c] = value;
				}),
			);
			sheet.revision += 1;
			const next = detail(sheet);
			return { output: next.output, revision: next.currentRevision };
		},
	);
});

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
	setModelContextResolverForTests(null);
	vi.clearAllMocks();
});

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1)
			await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function mount(appConfig: CardReviewConfig = config) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() =>
		root?.render(
			createElement(
				QueryClientProvider,
				{ client },
				createElement(CardReviewApp, { config: appConfig }),
			),
		),
	);
	await flush();
}

async function call(
	name: string,
	args: Record<string, unknown> = {},
): Promise<WebMcpToolResult & { data: Record<string, unknown> }> {
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`tool not registered: ${name}`);
	let result: WebMcpToolResult | undefined;
	await act(async () => {
		result = await tool.execute(args);
	});
	await flush();
	return {
		...result!,
		data: (result!.structuredContent ?? {}) as Record<string, unknown>,
	};
}

const shownWho = () =>
	host?.querySelector("[data-card-review-card] p")?.textContent ?? null;
const shownProgress = () =>
	host?.querySelector("[data-card-review-progress]")?.textContent ?? null;
const NEXT_CARD = "card_review_next_card";
const nextCard = async () =>
	(await call("card_review_next_card")).data.card as {
		cardKey: string;
		who: string;
	};

describe("Card review WebMCP tools", () => {
	it("registers while the app is open and unregisters when it closes", async () => {
		await mount();
		expect(tools.map((t) => t.name)).toEqual([
			"card_review_next_card",
			"card_review_set_verdict",
			"card_review_do_it",
			"card_review_snooze",
			"card_review_skip",
			"card_review_undo",
			"card_review_filter",
			"card_review_pending_rules",
			"card_review_decide_rule",
		]);
		const readOnly = tools
			.filter((t) => t.annotations.readOnlyHint)
			.map((t) => t.name);
		expect(readOnly).toEqual([
			"card_review_next_card",
			"card_review_pending_rules",
		]);
		const filter = tools.find((t) => t.name === "card_review_filter")!;
		expect(
			(filter.inputSchema.properties as { channel: { enum: string[] } }).channel
				.enum,
		).toEqual(["all", "linkedin", "x"]);

		act(() => root?.unmount());
		root = null;
		expect(tools).toEqual([]);
	});

	it("reads the card the screen shows", async () => {
		await mount();
		const result = await call("card_review_next_card");
		expect(result.data).toMatchObject({
			card: {
				cardKey: `${CARDS_ID}:0`,
				number: "1",
				channel: "LinkedIn",
				type: "Comment",
				who: "Mira Okafor",
				source: "https://linkedin.com/posts/mira-okafor-1",
				link: "https://linkedin.com/posts/mira-okafor-1",
				why: "R9: asked about pricing",
				rules: [{ id: "R9", text: "Flag pricing questions" }],
				draft: "Happy to share our notes.",
				sheet: {
					outputId: CARDS_ID,
					title: "Social cards 2026-10-01",
					rowIndex: 0,
				},
			},
			progress: { left: 3, total: 3, filter: "all" },
			filters: ["all", "LinkedIn", "X"],
			doIt: "approve",
		});
		expect(shownWho()).toBe("Mira Okafor");
	});

	it("filters the screen by channel", async () => {
		await mount();
		await call("card_review_filter", { channel: "x" });
		expect(shownWho()).toBe("Jonas Feld");
		expect(shownProgress()).toBe("1 of 1 left");
		expect(
			host?.querySelector('[aria-pressed="true"]')?.textContent?.trim(),
		).toBe("X");

		const unknown = await call("card_review_filter", { channel: "inbox" });
		expect(unknown.isError).toBe(true);

		await call("card_review_filter", { channel: "all" });
		expect(shownProgress()).toBe("3 of 3 left");
	});

	it("writes a verdict with reasons into the row and undoes it", async () => {
		await mount();
		const card = await nextCard();
		const result = await call("card_review_set_verdict", {
			cardKey: card.cardKey,
			verdict: "not_useful",
			chips: ["Wrong person"],
			reason: "already a customer",
		});
		expect(result.isError).toBeUndefined();
		expect(sheets.get(CARDS_ID)!.rows[0]!.slice(6)).toEqual([
			"no",
			"Wrong person: already a customer",
			"no",
		]);
		expect(shownWho()).toBe("Jonas Feld");
		expect(shownProgress()).toBe("2 of 3 left");

		await call("card_review_undo");
		expect(sheets.get(CARDS_ID)!.rows[0]!.slice(6)).toEqual([null, null, null]);
		expect(shownWho()).toBe("Mira Okafor");
		expect(shownProgress()).toBe("3 of 3 left");
		expect((await call("card_review_undo")).isError).toBe(true);
	});

	it("refuses a stale card key, an unknown chip and a bad verdict", async () => {
		await mount();
		const card = await nextCard();
		for (const args of [
			{ cardKey: `${CARDS_ID}:2`, verdict: "useful" },
			{ cardKey: card.cardKey, verdict: "useful", chips: ["Made up"] },
			{ cardKey: card.cardKey, verdict: "maybe" },
		]) {
			expect((await call("card_review_set_verdict", args)).isError).toBe(true);
		}
		expect(api.outputs.setSheetRange).not.toHaveBeenCalled();
	});

	it("marks Do it in the done column only", async () => {
		await mount();
		const card = await nextCard();
		await call("card_review_do_it", { cardKey: card.cardKey });
		expect(sheets.get(CARDS_ID)!.rows[0]!.slice(6)).toEqual(["yes", "", "yes"]);
		expect(shownWho()).toBe("Jonas Feld");
	});

	it("names Do it after the card's action and hides it without one", async () => {
		const sheet = sheets.get(CARDS_ID)!;
		sheet.columns.push("Action");
		sheet.rows.forEach((row, index) =>
			row.push(index === 0 ? "Reply to Mira" : ""),
		);
		const source = config.sources[0]!;
		await mount({
			...config,
			sources: [
				{ ...source, columns: { ...source.columns, action: "Action" } },
			],
		});
		const doItButton = () =>
			host?.querySelector('button[aria-keyshortcuts="D"]') ?? null;
		expect((await call(NEXT_CARD)).data.doItLabel).toBe("Reply to Mira");
		expect(doItButton()?.textContent).toBe("Reply to Mira");
		expect(host?.textContent).toContain("Asked about pricing");
		expect(host?.textContent).not.toContain("R9:");

		await call("card_review_skip", { cardKey: (await nextCard()).cardKey });
		expect((await call(NEXT_CARD)).data.doItLabel).toBeNull();
		expect(doItButton()).toBeNull();
		const refused = await call("card_review_do_it", {
			cardKey: (await nextCard()).cardKey,
		});
		expect(refused.isError).toBe(true);
		expect(api.outputs.setSheetRange).not.toHaveBeenCalled();
	});

	it("skips and snoozes on screen, each undoable", async () => {
		await mount();
		await call("card_review_skip", { cardKey: (await nextCard()).cardKey });
		expect(shownWho()).toBe("Jonas Feld");
		await call("card_review_undo");
		expect(shownWho()).toBe("Mira Okafor");

		await call("card_review_snooze", { cardKey: (await nextCard()).cardKey });
		expect(shownWho()).toBe("Jonas Feld");
		expect(shownProgress()).toBe("2 of 3 left");
		await call("card_review_undo");
		expect(shownWho()).toBe("Mira Okafor");
		expect(api.outputs.setSheetRange).not.toHaveBeenCalled();
	});

	it("lists and decides a suggested rule", async () => {
		await mount();
		const box = host?.querySelector('[aria-label="Suggested changes"]');
		expect(box?.textContent).toContain("Suggested change");
		expect(box?.textContent).toContain("Yes, change it");
		expect(box?.textContent).not.toContain("R10");
		const listed = await call("card_review_pending_rules");
		expect(listed.data.rules).toEqual([
			{
				ruleKey: `${RULES_ID}:1`,
				id: "R10",
				text: "Skip reposts",
				sourceLabel: "Social",
			},
		]);
		const decided = await call("card_review_decide_rule", {
			ruleKey: `${RULES_ID}:1`,
			decision: "reject",
		});
		expect(decided.data).toMatchObject({ id: "R10", status: "rejected" });
		expect(sheets.get(RULES_ID)!.rows[1]![2]).toBe("rejected");
		expect(host?.textContent).not.toContain("Suggested change");
		expect((await call("card_review_pending_rules")).data.rules).toEqual([]);
	});
});

describe("Do it that runs the source's skill", () => {
	const MAILBOX = "77777777-7777-4777-8777-777777777777";
	const WORK = "/work/items/88888888-8888-4888-8888-888888888888";
	const inbox: CardReviewConfig = {
		version: 1,
		sources: [
			{
				label: "Inbox",
				workspaceId: WORKSPACE_ID,
				cardSheetPrefix: "Social cards ",
				maxRuns: 3,
				columns: {
					number: "#",
					type: "Type",
					source: "Source",
					who: "Who",
					why: "Why",
					action: "Action",
					draft: "Draft",
					useful: "Useful?",
					reason: "Reason",
					done: "Did it?",
					result: "Result",
				},
				doIt: "run_skill",
				run: {
					skillId: "inbox-actions",
					actions: [
						{ kind: "archive", match: ["archive"] },
						{ kind: "reply_draft", match: ["draft a reply"] },
					],
				},
			},
		],
	};

	/** The run's own write: outcome, and done when it worked. */
	function runWrites(row: number, result: string) {
		const sheet = sheets.get(CARDS_ID)!;
		if (!sheet.columns.includes("Result")) {
			sheet.columns.push("Result");
			for (const cells of sheet.rows) cells.push(null);
		}
		const cells = sheet.rows[row]!;
		cells[sheet.columns.indexOf("Result")] = result;
		if (!result.startsWith("Failed")) {
			cells[sheet.columns.indexOf("Useful?")] = "yes";
			cells[sheet.columns.indexOf("Did it?")] = "yes";
		}
		sheet.revision += 1;
	}

	beforeEach(() => {
		const sheet = sheets.get(CARDS_ID)!;
		sheet.columns.push("Action");
		const actions = [
			"Archive the thread",
			"Draft a reply to Jonas",
			"Book a call with Ada",
		];
		sheet.rows.forEach((row, index) => row.push(actions[index]!));
	});

	it("archives through a run, shows the outcome and moves on", async () => {
		api.schedules.runNow.mockImplementation(async ({ params }) => {
			runWrites(params.row, "Done ✓");
			return { status: "started", runId: "run-1" };
		});
		await mount(inbox);
		const card = await nextCard();
		const pressed = await call("card_review_do_it", { cardKey: card.cardKey });
		expect(pressed.isError).toBeFalsy();
		expect(pressed.data.result).toBe("Done ✓");
		expect(api.schedules.runNow).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceId: WORKSPACE_ID,
				skillId: "inbox-actions",
				needs: "organise",
				params: expect.objectContaining({
					cardSheetId: CARDS_ID,
					row: 0,
					kind: "archive",
					action: "Archive the thread",
				}),
			}),
		);
		// The app itself writes nothing; the run did.
		expect(api.outputs.setSheetRange).not.toHaveBeenCalled();
		expect(shownWho()).toBe("Jonas Feld");
		expect(
			host?.querySelector("[data-card-review-last-result]")?.textContent,
		).toContain("Archive the thread: Done ✓");
	});

	it("asks for organise access first, and the owner's click grants it", async () => {
		api.schedules.runNow.mockResolvedValue({
			status: "needs_access",
			level: "read",
			providerName: "Gmail",
			resourceId: MAILBOX,
		});
		api.schedules.setPersonalAccess.mockResolvedValue({
			level: "organise",
			skills: [],
		});
		await mount(inbox);
		const pressed = await call("card_review_do_it", {
			cardKey: (await nextCard()).cardKey,
		});
		expect(pressed.isError).toBe(true);
		expect(JSON.stringify(pressed)).toContain("Allow organising first");
		const box = host?.querySelector("[data-card-review-allow-organising]");
		expect(box?.textContent).toContain("Allow organising first");
		const allow = [...(box?.querySelectorAll("button") ?? [])].find((b) =>
			b.textContent?.includes("Let this organise my Gmail"),
		);
		expect(allow?.textContent).toContain("never sends or deletes");
		// The agent's press never grants anything by itself.
		expect(api.schedules.setPersonalAccess).not.toHaveBeenCalled();
		await act(async () => allow!.click());
		await flush();
		expect(api.schedules.setPersonalAccess).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			resourceId: MAILBOX,
			level: "organise",
		});
		expect(shownWho()).toBe("Mira Okafor");
	});

	it("files anything else as Work without asking for mailbox access", async () => {
		api.schedules.runNow.mockImplementation(async ({ params }) => {
			runWrites(params.row, "Filed as Work " + WORK);
			return { status: "started", runId: "run-2" };
		});
		await mount(inbox);
		await call("card_review_skip", { cardKey: (await nextCard()).cardKey });
		await call("card_review_skip", { cardKey: (await nextCard()).cardKey });
		const pressed = await call("card_review_do_it", {
			cardKey: (await nextCard()).cardKey,
		});
		expect(pressed.data.result).toBe("Filed as Work " + WORK);
		const [input] = api.schedules.runNow.mock.calls[0]!;
		expect(input.needs).toBeUndefined();
		expect(input.params.kind).toBe("work");
		expect(
			host
				?.querySelector("[data-card-review-last-result] a")
				?.getAttribute("href"),
		).toBe(WORK);
	});

	it("keeps a failed card open with its reason", async () => {
		api.schedules.runNow.mockImplementation(async ({ params }) => {
			runWrites(params.row, "Failed: Gmail refused the label");
			return { status: "started", runId: "run-3" };
		});
		await mount(inbox);
		const pressed = await call("card_review_do_it", {
			cardKey: (await nextCard()).cardKey,
		});
		expect(pressed.isError).toBe(true);
		expect(shownWho()).toBe("Mira Okafor");
		expect(host?.querySelector("[data-card-review-result]")?.textContent).toBe(
			"Last try: Failed: Gmail refused the label",
		);
	});
});
