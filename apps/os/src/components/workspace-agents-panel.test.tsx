import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { ConversationSummary } from "@/lib/workspace-chat-protocol";

const mocks = vi.hoisted(() => ({
	schedules: vi.fn(),
	resources: vi.fn(),
	runs: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			resources: { list: mocks.resources },
			schedules: { list: mocks.schedules },
		},
		skills: { runWorkflowHistory: mocks.runs },
	},
}));
import { WorkspaceAgentsPanel } from "./workspace-agents-panel";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const now = () => new Date().toISOString();

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	mocks.schedules.mockReset().mockResolvedValue({
		items: [
			{
				resourceId: "22222222-2222-4222-8222-222222222222",
				skillId: "digest",
				name: "Morning digest",
				purpose: null,
				enabled: true,
				cron: "0 8 * * *",
				dailyTimes: [],
				nextRunAt: null,
				lastRun: null,
				personalRead: null,
				tediName: "Research Tedi",
				hasWorkflow: true,
			},
		],
	});
	mocks.resources.mockReset().mockResolvedValue({
		items: [
			{
				providerId: "tedix",
				resourceType: "tedi",
				providerResourceId: "tedi-ops",
				name: "Ops Tedi",
			},
		],
	});
	mocks.runs.mockReset().mockResolvedValue({
		runs: [
			{ id: "run-1", status: "paused", trigger: "scheduled", pausedAt: now() },
			{
				id: "run-2",
				status: "completed",
				trigger: "scheduled",
				// A second earlier: two runs stamped in the same instant have no
				// order of their own, and the list shows the newest first.
				completedAt: new Date(Date.now() - 1_000).toISOString(),
			},
		],
	});
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

async function mount(
	conversations: ConversationSummary[],
	settled: () => boolean,
	onOpenConversation = vi.fn(),
) {
	await act(async () => {
		root.render(
			<QueryClientProvider
				client={
					new QueryClient({ defaultOptions: { queries: { retry: false } } })
				}
			>
				<WorkspaceAgentsPanel
					workspaceId={WORKSPACE_ID}
					conversations={conversations}
					onOpenConversation={onOpenConversation}
				/>
			</QueryClientProvider>,
		);
	});
	// The runs are asked for only after the linked skills arrive, so wait for
	// what the test expects rather than for a fixed number of ticks.
	for (let tries = 0; tries < 100 && !settled(); tries++)
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
	return onOpenConversation;
}

const agentRow = (key: string) =>
	host.querySelector<HTMLElement>(`[data-workspace-agent="${key}"]`)!;
const counts = (key: string) =>
	agentRow(key)?.querySelector("[data-agent-counts]")?.textContent;

describe("WorkspaceAgentsPanel", () => {
	it("shows one row per agent with its counts and opens its latest runs", async () => {
		const onOpen = await mount(
			[
				{
					id: "c-run",
					title: "Nightly check",
					updatedAt: now(),
					lastTurnAt: now(),
					pendingApprovals: 1,
					startedBy: { kind: "tedi", id: "tedi-ops" },
				},
				// A person's own conversation is not an agent's run.
				{ id: "c-mine", title: "Mine", updatedAt: now(), lastTurnAt: now() },
			],
			() =>
				counts("skill:digest") === "1 needs you · 2 today" &&
				agentRow("tedi:tedi-ops")?.textContent?.includes("Ops Tedi") === true,
		);
		expect(mocks.runs).toHaveBeenCalledWith(
			expect.objectContaining({ skillId: "digest", limit: 30 }),
			expect.anything(),
		);
		expect(counts("skill:digest")).toBe("1 needs you · 2 today");
		expect(counts("tedi:tedi-ops")).toBe("1 needs you · 1 today");
		expect(agentRow("tedi:tedi-ops").textContent).toContain("Ops Tedi");
		expect(host.querySelectorAll("[data-workspace-agent]")).toHaveLength(2);
		expect(host.querySelector("[data-agent-run]")).toBeNull();

		act(() => agentRow("tedi:tedi-ops").querySelector("button")!.click());
		const review = agentRow("tedi:tedi-ops").querySelector<HTMLButtonElement>(
			'[data-agent-run="c-run"] button',
		)!;
		expect(review.textContent).toBe("Review");
		act(() => review.click());
		expect(onOpen).toHaveBeenCalledWith("c-run");

		act(() => agentRow("skill:digest").querySelector("button")!.click());
		const links = [
			...agentRow("skill:digest").querySelectorAll<HTMLAnchorElement>("a"),
		].map((link) => [link.textContent, link.getAttribute("href")]);
		expect(links).toEqual([
			["Review", "/work/runs/run-1"],
			["Open", "/work/runs/run-2"],
			["See all runs", "/skills/digest/runs"],
		]);
	});

	it("does not call an agent idle when its runs could not be loaded", async () => {
		mocks.runs.mockRejectedValue(new Error("offline"));
		await mount(
			[],
			() => counts("skill:digest") === "Its runs could not be loaded",
		);
		expect(counts("skill:digest")).toBe("Its runs could not be loaded");
	});

	it("says so when no agent works in the workspace", async () => {
		mocks.schedules.mockResolvedValue({ items: [] });
		await mount(
			[],
			() => host.textContent?.includes("No agents work") === true,
		);
		expect(host.textContent).toContain("No agents work in this workspace yet");
	});
});
