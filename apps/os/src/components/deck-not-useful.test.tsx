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

const api = vi.hoisted(() => ({
	markDeckCardNotUseful: vi.fn(),
	getDeckPipelineStatus: vi.fn(),
	removeDeckRule: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		workInteractions: { reviseCard: vi.fn() },
		attention: api,
		workItems: {},
		learningFeedback: {},
		workAgentSessions: {},
	},
}));
vi.mock("@/lib/os-query-options", () => ({
	osQuery: {
		workInteractions: { key: () => ["wi"] },
		attention: {
			key: () => ["attention"],
			getDeckPipelineStatus: {
				queryOptions: () => ({
					queryKey: ["attention", "status"],
					queryFn: () => api.getDeckPipelineStatus(),
				}),
			},
		},
		workItems: { key: () => ["wi2"] },
		learningFeedback: { key: () => ["lf"] },
		workAgentSessions: { key: () => ["was"] },
	},
}));
import { DeckNotUseful } from "./deck-not-useful";
import { DeckCurationFooter } from "./deck-curation-footer";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: QueryClient;

beforeEach(() => {
	api.markDeckCardNotUseful.mockReset();
	api.getDeckPipelineStatus.mockReset();
	api.removeDeckRule
		.mockReset()
		.mockResolvedValue({ removed: true, rules: [] });
});
afterEach(async () => {
	if (root) await act(async () => root.unmount());
	host?.remove();
	client?.clear();
});
async function mount(node: React.ReactNode) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>{node}</QueryClientProvider>,
		),
	);
}
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("button")];

describe("DeckNotUseful", () => {
	it("asks for one of five reasons and reports a learned rule with undo", async () => {
		api.markDeckCardNotUseful.mockResolvedValue({
			requestId: "10000000-0000-4000-8000-000000000001",
			reason: "expired",
			retired: true,
			learningEventId: "evt",
			rule: {
				sentence:
					"Cards from deck-truth (agent) retire automatically once their deadline passes.",
			},
			undo: {
				requestId: "10000000-0000-4000-8000-000000000001",
				expectedRequestVersion: 4,
				expectedRevision: 2,
				restoreRevision: 1,
			},
		});
		await mount(
			<DeckNotUseful
				request={{ id: "10000000-0000-4000-8000-000000000001", version: 3 }}
			/>,
		);
		await act(async () => buttons()[0]!.click());
		expect(buttons().map((button) => button.textContent)).toEqual([
			"Already decided",
			"Expired",
			"Agent could do this",
			"Duplicate",
			"Not for me",
		]);
		await act(async () => buttons()[1]!.click());
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(api.markDeckCardNotUseful).toHaveBeenCalledWith({
			requestId: "10000000-0000-4000-8000-000000000001",
			expectedRequestVersion: 3,
			reason: "expired",
		});
		expect(host.textContent).toContain("From now on: Cards from deck-truth");
		expect(buttons().map((button) => button.textContent)).toEqual(["Undo"]);
	});
});

describe("DeckCurationFooter", () => {
	it("shows the last clean, the staleness alarm and removable rules", async () => {
		api.getDeckPipelineStatus.mockResolvedValue({
			lastCleanedAt: "2026-10-21T06:45:00.000Z",
			stale: true,
			staleAfterHours: 2,
			lastSweep: null,
			metrics: null,
			rules: [
				{
					id: "rule-1",
					recipientId: "u",
					sourceKey: "external_agent:a",
					reason: "not_for_me",
					sentence: "Cards from agent a stay off your Deck.",
					evidenceIds: ["a", "b", "c"],
					createdAt: "2026-10-21T06:45:00.000Z",
				},
			],
		});
		await mount(<DeckCurationFooter />);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(host.textContent).toContain("Last cleaned");
		expect(host.querySelector('[role="alert"]')?.textContent).toContain(
			"has not run for over 2 h",
		);
		const rules = buttons().find((button) =>
			button.textContent?.includes("Learned rules"),
		)!;
		expect(rules.getAttribute("aria-expanded")).toBe("false");
		await act(async () => rules.click());
		expect(rules.getAttribute("aria-expanded")).toBe("true");
		const removeRule = buttons().find(
			(button) => button.textContent?.trim() === "Remove",
		)!;
		await act(async () => removeRule.click());
		expect(api.removeDeckRule).toHaveBeenCalledWith({ ruleId: "rule-1" });
	});
});
