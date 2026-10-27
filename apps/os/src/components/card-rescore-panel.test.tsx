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
import { CardReviewSourceSchema } from "@tedix/api-contract/schemas/os-card-review";
import { cardsFromSheet } from "@tedix/api-contract/utils/card-review";
import { osApi } from "@/lib/api";
import { useCanManageTedis } from "@/lib/tedi-permissions";
import { cardReplayParams } from "@/lib/card-replay";
import { CardReviewBrowser } from "./card-review-browser";

vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: { outputs: { get: vi.fn(), setSheetRange: vi.fn() } },
		skills: { runWorkflow: vi.fn() },
		learningFeedback: { recordInteraction: vi.fn() },
	},
}));
vi.mock("@/lib/tedi-permissions", () => ({
	useCanManageTedis: vi.fn(() => true),
}));

const source = CardReviewSourceSchema.parse({
	label: "Opportunities",
	workspaceId: "00000000-0000-4000-8000-000000000001",
	cardSheetPrefix: "Cards",
	doIt: "approve",
	columns: {
		number: "#",
		source: "URL",
		why: "Title",
		useful: "Decision",
		reason: "Feedback",
		done: "Done",
	},
	replay: {
		skillId: "scoring",
		tediId: "00000000-0000-4000-8000-000000000002",
		columns: { url: "URL", title: "Title", text: "Text" },
	},
});
function makeSheet() {
	return {
		kind: "sheet" as const,
		columns: [
			"#",
			"URL",
			"Title",
			"Text",
			"Decision",
			"Feedback",
			"Done",
			"Score",
			"Prüfstatus",
		],
		rows: Array.from({ length: 26 }, (_, index) => [
			index + 1,
			`https://example.com/${index}`,
			`Title ${index}`,
			`Text ${index}`,
			index % 2 ? "no" : "yes",
			`Keep feedback ${index}`,
			"yes",
			0.2,
			"old",
		]),
	};
}
let sheet = makeSheet();
function cards() {
	const result = cardsFromSheet({
		source,
		sourceIndex: 0,
		outputId: "sheet-1",
		sheetTitle: "Cards today",
		runCreatedAt: "2026-01-01",
		body: sheet,
	});
	if ("missing" in result) throw new Error("Invalid fixture");
	return result.cards;
}
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(useCanManageTedis).mockReturnValue(true);
	sheet = makeSheet();
	vi.mocked(osApi.osWorkspaces.outputs.get).mockImplementation(
		async () => ({ currentRevision: { content: sheet } }) as never,
	);
	vi.mocked(osApi.skills.runWorkflow).mockResolvedValue({
		runId: "run-1",
	} as never);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	client.clear();
	host.remove();
});
async function click(label: string) {
	const button = [...host.querySelectorAll("button")].find(
		(node) => node.textContent?.trim() === label,
	);
	expect(button, label).toBeDefined();
	await act(async () => button!.click());
}
async function mount() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<CardReviewBrowser
					cards={cards()}
					sources={[source]}
					onBack={() => {}}
				/>
			</QueryClientProvider>,
		),
	);
	await click("Re-score cards…");
}
async function check(index: number) {
	const inputs = host.querySelectorAll<HTMLInputElement>(
		'input[type="checkbox"]',
	);
	expect(inputs.length).toBe(27);
	await act(async () => inputs[index]!.click());
}

describe("Re-score selected cards", () => {
	it("dispatches only selected decided cards using fresh inputs, without writing decisions or feedback", async () => {
		await mount();
		await check(2);
		await check(4);
		sheet.rows[1]![2] = "Updated title";
		const before = structuredClone(sheet);
		await click("Re-score these cards");
		expect(osApi.skills.runWorkflow).toHaveBeenCalledExactlyOnceWith({
			skillId: "scoring",
			tediId: source.replay!.tediId,
			params: {
				mode: "replay",
				items: [
					{
						url: "https://example.com/1",
						title: "Updated title",
						text: "Text 1",
					},
					{ url: "https://example.com/3", title: "Title 3", text: "Text 3" },
				],
			},
			idempotencyKey: expect.any(String),
			confirmDestructive: true,
			reason: expect.any(String),
		});
		expect(sheet).toEqual(before);
		expect(osApi.osWorkspaces.outputs.setSheetRange).not.toHaveBeenCalled();
		expect(osApi.learningFeedback.recordInteraction).not.toHaveBeenCalled();
		expect(host.querySelector('a[href="/work/runs/run-1"]')).not.toBeNull();
		expect(host.textContent).toContain("0 selected");
	});
	it("selects more than 25 cards without hand-written JSON", async () => {
		await mount();
		await check(0);
		await click("Re-score these cards");
		expect(
			vi.mocked(osApi.skills.runWorkflow).mock.calls[0]![0].params?.items,
		).toHaveLength(26);
	});
	it("blocks changed row identities before dispatch", async () => {
		await mount();
		await check(1);
		sheet.rows.reverse();
		await click("Re-score these cards");
		expect(osApi.skills.runWorkflow).not.toHaveBeenCalled();
		expect(host.querySelector('[role="alert"]')?.textContent).toContain(
			"selected cards changed",
		);
	});
	it("keeps selection and reuses the dispatch key after a failed response", async () => {
		await mount();
		await check(1);
		vi.mocked(osApi.skills.runWorkflow).mockRejectedValueOnce(
			new Error("Dispatch unavailable"),
		);
		await click("Re-score these cards");
		expect(host.textContent).toContain("Dispatch unavailable");
		expect(host.textContent).toContain("1 selected");
		await click("Re-score these cards");
		const calls = vi.mocked(osApi.skills.runWorkflow).mock.calls;
		expect(calls[0]![0].idempotencyKey).toBe(calls[1]![0].idempotencyKey);
	});
	it("requires permission and a selection", async () => {
		vi.mocked(useCanManageTedis).mockReturnValue(false);
		await mount();
		await click("Re-score these cards");
		expect(osApi.skills.runWorkflow).not.toHaveBeenCalled();
		expect(host.textContent).toContain("You need permission");
	});
	it("rejects missing columns, duplicate URLs, mixed sheets and empty selection", () => {
		const selected = cards();
		expect(() => cardReplayParams(source.replay!, [], sheet)).toThrow(
			"Select between",
		);
		expect(() =>
			cardReplayParams(source.replay!, selected, { columns: [], rows: [] }),
		).toThrow("missing URL");
		expect(() =>
			cardReplayParams(source.replay!, [selected[0]!, selected[0]!], sheet),
		).toThrow("duplicate URLs");
		expect(() =>
			cardReplayParams(
				source.replay!,
				[selected[0]!, { ...selected[1]!, outputId: "other" }],
				sheet,
			),
		).toThrow("one sheet");
	});
});
