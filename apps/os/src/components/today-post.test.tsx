import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { TODAY_COLUMNS } from "@/lib/today-digest";
import { TodayPost } from "./today-post";
vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: { outputs: { get: vi.fn() } },
		organizationPurpose: { getActive: vi.fn() },
		attention: { listDeckCards: vi.fn() },
		learningFeedback: {
			listInteractions: vi.fn().mockResolvedValue({ events: [] }),
		},
		agentTurnTriage: {
			listLessons: vi.fn().mockResolvedValue({ lessons: [] }),
		},
		skills: { runWorkflow: vi.fn() },
	},
}));
const config = {
	outputId: "11111111-1111-4111-8111-111111111111",
	skillId: "22222222-2222-4222-8222-222222222222",
	tediId: "33333333-3333-4333-8333-333333333333",
	personId: "fictional-person",
	timeZone: "Europe/Berlin",
};
const outputKey = osQuery.osWorkspaces.outputs.get.queryOptions({
	input: { outputId: config.outputId },
}).queryKey;
const deckKey = osQuery.attention.listDeckCards.queryOptions({
	input: { limit: 100 },
}).queryKey;
const revision = (
	id: string,
	updated: string,
	createdAt = new Date().toISOString(),
) => ({
	currentRevision: {
		id,
		createdAt,
		content: {
			kind: "document",
			blocks: [
				{ type: "paragraph", text: "Help the team." },
				{ type: "paragraph", text: updated },
				{ type: "paragraph", text: "6 projects quiet" },
				{
					type: "table",
					headers: TODAY_COLUMNS,
					rows: [
						[
							"Website",
							"Make the page useful.",
							"1 task finished.",
							"Nothing running now.",
							"2",
							"/work/projects/example",
							"/work?view=feed",
							"/work?view=deck",
						],
					],
				},
			],
		},
	},
});
let client: QueryClient;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	client?.clear();
});
async function mount() {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	return async () =>
		act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<TodayPost config={config} onUpdate={() => {}} />
				</QueryClientProvider>,
			),
		);
}

it.each([true, false])(
	"shows the saved digest (deck complete: %s), never the saved purpose or a charter blurb, and keeps it visible with a Refreshing chip until a new revision lands",
	async (complete) => {
		const render = await mount();
		client.setQueryData<unknown>(deckKey, {
			cards: [],
			count: 7,
			complete,
			observedAt: new Date().toISOString(),
		});
		client.setQueryData<unknown>(
			osQuery.organizationPurpose.getActive.queryOptions({ input: {} })
				.queryKey,
			{ charter: { purpose: "Make customer work easier." } },
		);
		client.setQueryData<unknown>(
			outputKey,
			revision("rev-1", "Updated today."),
		);
		vi.mocked(osApi.osWorkspaces.outputs.get).mockResolvedValue(
			revision("rev-1", "Updated today.") as never,
		);
		vi.mocked(osApi.skills.runWorkflow).mockResolvedValue({
			runId: "run",
			workflowInstanceId: "workflow",
			status: "queued",
			workItemId: null,
			deduplicated: false,
		});
		await render();
		expect(host.textContent).not.toContain("Help the team.");
		expect(host.textContent).not.toContain("Make customer work easier.");
		expect(host.textContent).not.toContain("Checking Decisions");
		expect(host.querySelector('a[href="/work?view=deck"]')?.textContent).toBe(
			complete
				? "7 decisions waiting → Decisions"
				: "Open Decisions · count unavailable",
		);
		expect(host.textContent).toContain("Updated today.");
		await act(async () => {
			Array.from(host.querySelectorAll("button"))
				.find((b) => b.textContent === "Refresh")!
				.click();
		});
		expect(osApi.skills.runWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({
				params: {
					manual: true,
					outputId: config.outputId,
					personId: config.personId,
					timeZone: config.timeZone,
				},
			}),
		);
		// Stale while revalidating: the last digest stays, a quiet chip says a new one is coming.
		expect(host.querySelector("[data-today-refreshing]")?.textContent).toBe(
			"Refreshing…",
		);
		expect(host.textContent).toContain("Updated today.");
		expect(host.textContent).toContain("Website");
		expect(host.querySelector("[data-today-pending]")).toBeNull();
		await act(async () => {
			client.setQueryData<unknown>(
				outputKey,
				revision("rev-2", "Updated a minute ago."),
			);
			// TanStack notifies observers on a macrotask.
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(host.querySelector("[data-today-refreshing]")).toBeNull();
		expect(host.textContent).toContain("Updated a minute ago.");
	},
);

it("renders skeleton lines while Today and the Deck count open, never a status sentence", async () => {
	const render = await mount();
	vi.mocked(osApi.osWorkspaces.outputs.get).mockReturnValue(
		new Promise(() => {}),
	);
	vi.mocked(osApi.attention.listDeckCards).mockReturnValue(
		new Promise(() => {}),
	);
	await render();
	expect(host.querySelector("[data-today-pending]")).not.toBeNull();
	expect(
		host.querySelectorAll('[data-today-pending] [data-slot="skeleton"]').length,
	).toBeGreaterThanOrEqual(3);
	expect(host.querySelector("[data-today-deck-pending]")).not.toBeNull();
	for (const text of ["Checking Decisions…", "Opening Today…"])
		expect(host.textContent).not.toContain(text);
});

it("shows an honest empty state when no digest exists yet", async () => {
	const render = await mount();
	client.setQueryData<unknown>(deckKey, {
		cards: [],
		count: 0,
		complete: true,
		observedAt: new Date().toISOString(),
	});
	client.setQueryData<unknown>(outputKey, { currentRevision: null });
	await render();
	expect(host.querySelector("[data-today-empty]")?.textContent).toBe(
		"Your first summary of today arrives after the next refresh.",
	);
	expect(host.querySelector("[data-today-pending]")).toBeNull();
});

it("warns that refresh is late instead of repeating the saved schedule promise", async () => {
	const render = await mount();
	client.setQueryData<unknown>(deckKey, {
		cards: [],
		count: 0,
		complete: true,
		observedAt: new Date().toISOString(),
	});
	client.setQueryData<unknown>(
		outputKey,
		revision(
			"rev-stale",
			"Updated 23 October at 20:46. Refreshes every two hours during the day.",
			"2020-10-23T18:46:00.000Z",
		),
	);
	await render();
	const warning = host.querySelector("[data-today-stale]");
	expect(warning?.textContent).toContain("Summary refresh is late.");
	expect(warning?.textContent).toContain("Try Refresh.");
	expect(host.textContent).not.toContain("Refreshes every two hours");
	expect(host.textContent).toContain("Website");
});
