import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { CardReviewConfigSchema } from "@tedix/api-contract/schemas/os-card-review";
import { DECISION_DECK_EXAMPLES } from "../../dev/decision-deck-fixture";
import { cardsContent } from "../../dev/local-output-content";
import { CardFaceContext } from "./deck-presentation-context";
import { CardReviewApp } from "./card-review-app";
import { osApi } from "@/lib/api";
import { Sheet, SheetContent, SheetTitle } from "./kumo/sheet";
import { Button } from "./kumo/button";

vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			outputs: {
				list: vi.fn(),
				get: vi.fn(),
				setSheetRange: vi.fn(),
				history: vi.fn(),
			},
		},
		learningFeedback: {
			model: vi.fn(),
			listInteractions: vi.fn().mockResolvedValue({ events: [] }),
			recordInteraction: vi.fn(),
			correct: vi.fn(),
		},
		userProfile: { getMine: vi.fn() },
		userSettings: { getPreferences: vi.fn() },
		attention: { decideDeckCard: vi.fn() },
	},
}));
vi.mock("@/components/blueprints-page", () => ({
	isConflictError: () => false,
}));
vi.mock("@/components/decision-learning-feedback", () => ({
	DecisionLearningFeedback: () => null,
}));
vi.mock("@/lib/webmcp/use-app-webmcp-tools", () => ({
	useAppWebMcpTools: () => {},
}));
vi.mock("@/components/kumo/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const outputId = "00000000-0000-4000-8000-000000000001";
const config = CardReviewConfigSchema.parse({
	version: 1,
	sources: [
		{
			label: "Practice",
			workspaceId: "00000000-0000-4000-8000-000000000002",
			cardSheetPrefix: "Practice cards",
			doIt: "approve",
			run: { skillId: "practice-rewrite" },
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
				action: "Action",
			},
		},
	],
});
const examples = DECISION_DECK_EXAMPLES.slice(0, 3);
function makeSheet() {
	if (cardsContent.kind !== "sheet")
		throw new Error("Expected card sheet fixture");
	return {
		...structuredClone(cardsContent),
		columns: [...cardsContent.columns, "Action"],
		rows: cardsContent.rows.map((row, index) => [
			...row.slice(0, 1),
			"opportunity",
			...row.slice(2),
			examples[index]!.proposal,
		]),
	};
}
let sheet = makeSheet();
let revision: number;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot> | undefined;
let client: QueryClient;
const storageKey = () =>
	`tedix.cardReview.snoozes:${location.host}:practice-viewer`;
const detail = () => ({
	output: { id: outputId },
	currentRevision: { revision, content: structuredClone(sheet) },
});

beforeEach(() => {
	vi.resetAllMocks();
	localStorage.clear();
	sheet = makeSheet();
	revision = 1;
	vi.mocked(osApi.osWorkspaces.outputs.list).mockResolvedValue({
		items: [
			{
				id: outputId,
				kind: "sheet",
				status: "active",
				title: "Practice cards today",
				createdAt: new Date().toISOString(),
			},
		],
	} as never);
	vi.mocked(osApi.osWorkspaces.outputs.get).mockImplementation(
		async () => detail() as never,
	);
	vi.mocked(osApi.osWorkspaces.outputs.history).mockResolvedValue({
		revisions: [],
		pending: [],
		nextBeforeRevision: null,
	} as never);
	vi.mocked(osApi.userProfile.getMine).mockResolvedValue({
		id: "practice-viewer",
	} as never);
	vi.mocked(osApi.userSettings.getPreferences).mockResolvedValue({
		preferences: { timezone: "UTC" },
	} as never);
	vi.mocked(osApi.learningFeedback.model).mockResolvedValue({
		config: { enabled: false },
	} as never);
	vi.mocked(osApi.learningFeedback.recordInteraction).mockResolvedValue({
		event: { id: "practice-event" },
	} as never);
	vi.mocked(osApi.osWorkspaces.outputs.setSheetRange).mockImplementation(
		async (input) => {
			for (const [rowOffset, cells] of input.cells.entries()) {
				for (const [columnOffset, cell] of cells.entries()) {
					sheet.rows[input.startRow + rowOffset]![
						input.startColumn + columnOffset
					] = cell;
				}
			}
			revision += 1;
			return {
				output: { id: outputId },
				revision: detail().currentRevision,
			} as never;
		},
	);
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
		},
	});
	host = document.createElement("div");
	document.body.append(host);
});
afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	client.clear();
	host.remove();
	vi.restoreAllMocks();
	localStorage.clear();
});
async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}
async function mount(inDeck = true, overlay = false, appConfig = config) {
	root ??= createRoot(host);
	await act(async () =>
		root!.render(
			<QueryClientProvider client={client}>
				<CardFaceContext value={{ presentation: null, confidence: null }}>
					<CardReviewApp config={appConfig} inDeck={inDeck} />
					{overlay && (
						<Sheet open>
							<SheetContent>
								<SheetTitle>Review settings</SheetTitle>
								<Button>Overlay action</Button>
							</SheetContent>
						</Sheet>
					)}
				</CardFaceContext>
			</QueryClientProvider>,
		),
	);
	for (let i = 0; i < 5; i++) await flush();
}
function button(label: string) {
	const found = [...host.querySelectorAll("button")].find(
		(node) => node.textContent?.trim() === label,
	);
	expect(found, label).toBeDefined();
	return found!;
}
async function click(label: string) {
	await act(async () => button(label).click());
	await flush();
}
function heading(index: number) {
	return host.querySelector(
		`section[aria-label="${examples[index]!.proposal}"]`,
	);
}
async function key(target: Element, value: string) {
	await act(async () =>
		target.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: value,
				bubbles: true,
				cancelable: true,
			}),
		),
	);
}
async function type(selector: string, value: string) {
	const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(
		selector,
	)!;
	expect(input).not.toBeNull();
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			input instanceof HTMLTextAreaElement
				? HTMLTextAreaElement.prototype
				: HTMLInputElement.prototype,
			"value",
		)!.set!.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("CardReviewApp decision interactions", () => {
	it.each([true, false])(
		"explains denied source sheets without a write (deck=%s)",
		async (inDeck) => {
			vi.mocked(osApi.osWorkspaces.outputs.get).mockRejectedValue(
				Object.assign(new Error("Output source access is unavailable"), {
					code: "FORBIDDEN",
				}),
			);
			await mount(inDeck);
			expect(host.textContent).toContain("Cards are unavailable");
			expect(host.textContent).toContain("workspace or source sheet");
			expect(host.textContent).toContain("restricted source sheets");
			expect(host.textContent).not.toContain("Loading your activity");
			expect(osApi.osWorkspaces.outputs.setSheetRange).not.toHaveBeenCalled();
		},
	);

	it.each([
		["Useful", "yes"],
		["Not useful", "no"],
	])(
		"keeps the original headline and saves %s once while a summary is pending",
		async (label, verdict) => {
			await mount();
			expect(heading(0)).not.toBeNull();
			expect(host.textContent).toContain("Writing a short summary…");
			for (const action of ["Useful", "Not useful", "Later"])
				expect(button(action).disabled).toBe(false);
			await click(label);
			expect(osApi.osWorkspaces.outputs.setSheetRange).toHaveBeenCalledTimes(1);
			expect(osApi.osWorkspaces.outputs.setSheetRange).toHaveBeenCalledWith(
				expect.objectContaining({ outputId, startRow: 0 }),
			);
			expect(sheet.rows[0]![6]).toBe(verdict);
			expect(heading(1)).not.toBeNull();
			expect(osApi.learningFeedback.recordInteraction).toHaveBeenCalledTimes(1);
		},
	);
	it("Later snoozes just the current card without writing a verdict", async () => {
		await mount();
		await click("Later");
		expect(heading(1)).not.toBeNull();
		expect(osApi.osWorkspaces.outputs.setSheetRange).not.toHaveBeenCalled();
		expect(osApi.learningFeedback.recordInteraction).toHaveBeenCalledTimes(1);
		expect(osApi.learningFeedback.recordInteraction).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					decisionChoice: "later",
					rowIndex: 0,
				}),
			}),
		);
		expect(
			JSON.parse(localStorage.getItem(storageKey())!)[`${outputId}:0`],
		).toBeTypeOf("string");
	});
	it("retains the current card, unsent changes and feedback after a rejected save", async () => {
		vi.mocked(osApi.osWorkspaces.outputs.setSheetRange).mockRejectedValueOnce(
			new Error("Connection unavailable"),
		);
		await mount();
		await click("Ask for changes");
		await type(
			'textarea[aria-label="What should change?"]',
			"Please keep Friday as the delivery date.",
		);
		await click("Give feedback");
		await type(
			'textarea[aria-label="Optional feedback"]',
			"Keep the original facts.",
		);
		await click("Useful");
		expect(heading(0)).not.toBeNull();
		expect(host.querySelector('[role="alert"]')?.textContent).toContain(
			"Connection unavailable",
		);
		expect(
			host.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label="What should change?"]',
			)?.value,
		).toBe("Please keep Friday as the delivery date.");
		expect(host.textContent).toContain(String(sheet.rows[0]![5]));
		expect(
			host.querySelector<HTMLTextAreaElement>(
				'textarea[aria-label="Optional feedback"]',
			)?.value,
		).toBe("Keep the original facts.");
		expect(osApi.learningFeedback.recordInteraction).not.toHaveBeenCalled();
		await click("Useful");
		expect(heading(1)).not.toBeNull();
		expect(osApi.osWorkspaces.outputs.setSheetRange).toHaveBeenCalledTimes(2);
	});
	it("fences repeated decisions while a save is pending and advances only one card", async () => {
		const save = vi
			.mocked(osApi.osWorkspaces.outputs.setSheetRange)
			.getMockImplementation()!;
		let resolve!: () => void;
		vi.mocked(osApi.osWorkspaces.outputs.setSheetRange).mockImplementationOnce(
			async (input) => {
				await new Promise<void>((done) => {
					resolve = done;
				});
				return save(input);
			},
		);
		await mount();
		await key(heading(0)!, "ArrowRight");
		await key(heading(0)!, "ArrowRight");
		await act(async () =>
			host
				.querySelector<HTMLButtonElement>('[data-decision-intent="reject"]')!
				.click(),
		);
		expect(osApi.osWorkspaces.outputs.setSheetRange).toHaveBeenCalledTimes(1);
		expect(heading(0)).not.toBeNull();
		await act(async () => resolve());
		await flush();
		expect(heading(1)).not.toBeNull();
		expect(heading(2)).toBeNull();
		expect(sheet.rows[1]![6]).toBe("");
	});
	it.each(["Useful", "Snooze", "Skip"])(
		"undo restores the expected card after %s in the review view",
		async (action) => {
			await mount(false);
			const original = sheet.rows[0]![5];
			await click(action);
			expect(host.textContent).toContain(String(sheet.rows[1]![5]));
			const undo = [...host.querySelectorAll("button")].find((node) =>
				node.textContent?.startsWith("Undo:"),
			)!;
			await act(async () => undo.click());
			await flush();
			expect(host.textContent).toContain(String(original));
			if (action === "Useful") {
				expect(sheet.rows[0]![6]).toBe("");
				expect(osApi.osWorkspaces.outputs.setSheetRange).toHaveBeenCalledTimes(
					2,
				);
			} else
				expect(osApi.osWorkspaces.outputs.setSheetRange).not.toHaveBeenCalled();
		},
	);
	it("renders an empty queue without decision actions", async () => {
		sheet.rows = [];
		await mount();
		expect(host.querySelector('[role="status"]')?.textContent).toContain(
			"No cards yet",
		);
		expect(host.querySelector(".fd-decision")).toBeNull();
		expect(osApi.osWorkspaces.outputs.setSheetRange).not.toHaveBeenCalled();
	});
	it.each(["invalid JSON", "null", '"stale"', '{"old":42}'])(
		"ignores stale storage %s",
		async (stored) => {
			localStorage.setItem(storageKey(), stored);
			await mount();
			expect(heading(0)).not.toBeNull();
			await click("Useful");
			expect(heading(1)).not.toBeNull();
		},
	);
	it("shows expired snoozes and keeps future snoozes out of the queue", async () => {
		localStorage.setItem(
			storageKey(),
			JSON.stringify({
				[`${outputId}:0`]: new Date(Date.now() - 60_000).toISOString(),
				[`${outputId}:1`]: new Date(Date.now() + 86_400_000).toISOString(),
			}),
		);
		await mount();
		expect(heading(0)).not.toBeNull();
		await click("Useful");
		expect(heading(2)).not.toBeNull();
	});
	it("keeps local snooze and undo usable when storage reads and writes are blocked", async () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("Storage blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("Storage blocked");
		});
		await mount(false);
		await click("Snooze");
		expect(host.textContent).toContain(String(sheet.rows[1]![5]));
		await click("Undo: snoozed until tomorrow");
		expect(host.textContent).toContain(String(sheet.rows[0]![5]));
	});
	it("ignores decision shortcuts while typing unsent changes", async () => {
		await mount();
		await click("Ask for changes");
		await type(
			'textarea[aria-label="What should change?"]',
			"Keep this draft.",
		);
		const input = host.querySelector("textarea")!;
		input.focus();
		for (const shortcut of ["ArrowRight", "ArrowLeft", "l", "d"])
			await key(input, shortcut);
		expect(heading(0)).not.toBeNull();
		expect(input.value).toBe("Keep this draft.");
		expect(osApi.osWorkspaces.outputs.setSheetRange).not.toHaveBeenCalled();
		expect(osApi.learningFeedback.recordInteraction).not.toHaveBeenCalled();
	});
	it("ignores review shortcuts while typing and returns focus on Escape", async () => {
		await mount(false);
		await type(
			'input[aria-label="Reason in your words (optional)"]',
			"Keep this reason.",
		);
		const input = host.querySelector("input")!;
		input.focus();
		for (const shortcut of ["ArrowRight", "ArrowLeft", "s", "k", "z", "1"])
			await key(input, shortcut);
		expect(input.value).toBe("Keep this reason.");
		expect(host.textContent).toContain(String(sheet.rows[0]![5]));
		expect(osApi.osWorkspaces.outputs.setSheetRange).not.toHaveBeenCalled();
		expect(osApi.learningFeedback.recordInteraction).not.toHaveBeenCalled();
		await key(input, "Escape");
		expect(document.activeElement).toBe(
			host.querySelector("[data-card-review]"),
		);
		await key(document.activeElement!, "ArrowRight");
		await flush();
		expect(sheet.rows[0]![6]).toBe("yes");
		expect(sheet.rows[0]![7]).toBe("Keep this reason.");
	});
	it("browses every open card from the Waiting list without a verdict, skip or learning event", async () => {
		await mount(false);
		expect(
			host.querySelector("[data-card-review-card]")?.getAttribute("aria-label"),
		).toBe("Card 1: opportunity");
		await click("3 of 3 left");
		const list = host.querySelector("[data-card-review-waiting]")!;
		expect(list).not.toBeNull();
		expect(list.querySelectorAll("button")).toHaveLength(4); // Back + 3 rows
		for (const example of examples)
			expect(list.textContent).toContain(example.proposal);
		expect(host.querySelector("[data-card-review-card]")).toBeNull();
		await act(async () =>
			[...list.querySelectorAll("button")]
				.find((node) => node.textContent?.includes(examples[1]!.proposal))!
				.click(),
		);
		await flush();
		expect(
			host.querySelector("[data-card-review-card]")?.getAttribute("aria-label"),
		).toBe("Card 2: opportunity");
		expect(host.querySelector("[data-card-review-waiting]")).toBeNull();
		await click("3 of 3 left");
		await click("Back");
		expect(
			host.querySelector("[data-card-review-card]")?.getAttribute("aria-label"),
		).toBe("Card 2: opportunity");
		await key(host.querySelector("[data-card-review]")!, "w");
		expect(host.querySelector("[data-card-review-waiting]")).not.toBeNull();
		await key(host.querySelector("[data-card-review]")!, "Escape");
		expect(host.querySelector("[data-card-review-waiting]")).toBeNull();
		expect(osApi.learningFeedback.recordInteraction).not.toHaveBeenCalled();
		expect(osApi.osWorkspaces.outputs.setSheetRange).not.toHaveBeenCalled();
	});
	it("leaves shortcuts with an interactive overlay that owns focus", async () => {
		await mount();
		await mount(true, true);
		const dialog = document.querySelector('[role="dialog"]')!;
		expect(dialog).not.toBeNull();
		const control = [...dialog.querySelectorAll("button")].find(
			(node) => node.textContent === "Overlay action",
		)!;
		control.focus();
		for (const shortcut of ["ArrowRight", "ArrowLeft", "l", "d"])
			await key(control, shortcut);
		expect(document.activeElement).toBe(control);
		expect(heading(0)).not.toBeNull();
		expect(osApi.osWorkspaces.outputs.setSheetRange).not.toHaveBeenCalled();
		expect(osApi.learningFeedback.recordInteraction).not.toHaveBeenCalled();
	});
});

describe("CardReviewApp scored factory cards", () => {
	const scored = CardReviewConfigSchema.parse({
		version: 1,
		sources: [
			{
				...config.sources[0]!,
				columns: {
					...config.sources[0]!.columns,
					effort: "Effort",
					timing: "Timing",
					score: "Score",
					features: "Features",
				},
				scoring: {
					weights: { fresh_thread: 1, buyer_intent: 0.5, karma: 0.1 },
					skipReasonChips: [
						{ label: "Already covered", mapsTo: "duplicate" },
						{ label: "Too much effort", mapsTo: null },
					],
				},
			},
		],
	});
	beforeEach(() => {
		sheet.columns.push("Effort", "Timing", "Score", "Features");
		for (const row of sheet.rows)
			row.push(
				"5 min",
				"Today",
				"0.8",
				'{"fresh_thread":0.9,"buyer_intent":0.4,"karma":1}',
			);
	});

	it.each([true, false])(
		"shows effort, timing and why this card (in Deck: %s)",
		async (inDeck) => {
			await mount(inDeck, false, scored);
			const chips = host.querySelector("[data-card-review-chips]");
			expect(chips?.textContent).toBe("5 minToday");
			expect(
				host.querySelector("[data-card-review-ranked-for]")?.textContent,
			).toBe("Why this card: fresh thread, buyer intent");
		},
	);

	it("asks for a factory skip reason in the Deck and records it", async () => {
		await mount(true, false, scored);
		await click("Not useful");
		expect(osApi.osWorkspaces.outputs.setSheetRange).not.toHaveBeenCalled();
		await click("Already covered");
		expect(sheet.rows[0]![6]).toBe("no");
		expect(sheet.rows[0]![7]).toBe("Already covered");
		expect(osApi.learningFeedback.recordInteraction).toHaveBeenCalledWith(
			expect.objectContaining({
				eventKind: "rejected",
				metadata: expect.objectContaining({
					decisionClass: "factory:Practice:opportunity",
					score: 0.8,
					features: { fresh_thread: 0.9, buyer_intent: 0.4, karma: 1 },
					factoryReason: "Already covered",
					sharedReason: "duplicate",
				}),
			}),
		);
	});

	it("asks for wording changes from the standalone gadget without a verdict", async () => {
		vi.mocked(osApi.attention.decideDeckCard).mockResolvedValue({} as never);
		await mount(false);
		const panel = host.querySelector('section[aria-label="Card revisions"]');
		expect(panel).not.toBeNull();
		await click("Ask for changes");
		await type(
			'textarea[aria-label="What should change?"]',
			"Mention Demo Day first.",
		);
		await click("Request changes");
		expect(osApi.attention.decideDeckCard).toHaveBeenCalledWith({
			decision: {
				kind: "factory_changes",
				cardId: `factory:${outputId}:0`,
				expectedRevision: 1,
				instruction: "Mention Demo Day first.",
			},
		});
		expect(osApi.osWorkspaces.outputs.setSheetRange).not.toHaveBeenCalled();
	});

	it("offers the skip reasons as Not useful chips on the review card", async () => {
		await mount(false, false, scored);
		expect(button("Already covered")).toBeDefined();
		expect(button("Too much effort")).toBeDefined();
	});
});

it("delivers earned cards as updates while audit samples and protected cards still ask", async () => {
	const appConfig = CardReviewConfigSchema.parse({
		...config,
		sources: config.sources.map((source) => ({
			...source,
			scoring: { agentDecidableClasses: ["opportunity"] },
		})),
	});
	vi.mocked(osApi.learningFeedback.listInteractions).mockResolvedValue({
		events: Array.from({ length: 5 }, (_, i) => ({
			id: `event-${i}`,
			clientEventId: `client-${i}`,
			actorType: "user",
			actorId: "practice-viewer",
			targetId: `earlier-${i}`,
			scopeId: "practice-viewer",
			eventKind: "accepted",
			surface: "decision_deck",
			occurredAt: `2026-10-20T10:0${i}:00Z`,
			metadata: {
				decisionClass: "factory:Practice:opportunity",
				decisionChoice: "do_it",
			},
		})),
	} as never);
	// All test cards are benign reversible choices; audit is controlled by policy.
	sheet.rows.forEach((row) => {
		row[row.length - 1] = "File this item";
	});
	await mount(false, false, appConfig);
	const renderPolicy = async (
		autoApprove: boolean,
		auditSampleRate: number,
	) => {
		await act(async () =>
			root!.render(
				<QueryClientProvider client={client}>
					<CardReviewApp
						config={appConfig}
						classPolicies={{
							"factory:Practice:opportunity": {
								autoApprove,
								unchangedThreshold: 5,
								auditSampleRate,
							},
						}}
					/>
				</QueryClientProvider>,
			),
		);
		await flush();
	};
	await renderPolicy(true, 0);
	expect(host.querySelector('[aria-label="Updates"]')?.textContent).toContain(
		"Update:",
	);
	expect(host.textContent).toContain("0 of 3 left");
	expect(osApi.osWorkspaces.outputs.setSheetRange).not.toHaveBeenCalled();
	await renderPolicy(true, 1);
	expect(host.querySelector('[aria-label="Updates"]')).toBeNull();
	expect(host.textContent).toContain("3 of 3 left");
	await renderPolicy(false, 0);
	expect(host.textContent).toContain("3 of 3 left");
	appConfig.sources[0]!.protectedEffects = ["message"];
	await renderPolicy(true, 0);
	expect(host.textContent).toContain("3 of 3 left");
});
