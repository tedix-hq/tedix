import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ActivityFeedItemSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { FocusDecisionRow } from "./focus-feed";

vi.mock("@/lib/use-tedi-names", () => ({ useTediNames: () => ({}) }));
vi.mock("@/lib/use-decision-inbox", () => ({ useDecisionInbox: vi.fn() }));
vi.mock("@/lib/webmcp/use-app-webmcp-tools", () => ({
	useAppWebMcpTools: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: { attention: { getDeckCard: vi.fn() } },
}));

const requestId = "11111111-1111-4111-8111-111111111111";
const item = (at: string) => ({
	score: 1,
	unseen: true,
	deadline: false,
	factors: {},
	...ActivityFeedItemSchema.parse({
		id: `decision:${requestId}`,
		actor: "Robin",
		sentence: "Confirm who staffs the booth?",
		source: `/work/interactions/${requestId}`,
		projectId: null,
		workItemId: null,
		tediId: null,
		kind: "decision",
		classId: "event.booth",
		importance: "high",
		at,
		dueAt: null,
		needsAction: true,
		stalled: false,
		done: false,
		explanation:
			"Confirm who staffs the booth and send the guest list yourself for Demo Day on 20 October.",
		reactions: [],
	}),
});
const card = (presentation: unknown, faceText?: string) => ({
	id: requestId,
	kind: "decision",
	label: "Confirm who staffs the booth?",
	project: "Unfiled",
	urgency: "later",
	decision: null,
	source: "/work",
	requestedAt: new Date().toISOString(),
	dueAt: null,
	score: 0,
	presentation,
	...(faceText ? { faceText } : {}),
});
const FACE = {
	version: 2,
	title: "Who staffs the booth?",
	context: "Demo Day is on 20 October.",
	body: "Saves your answer; sends nothing.",
	recommendation: "Decide today because setup ends at 13:59.",
};
const key = osQuery.attention.getDeckCard.queryOptions({
	input: { cardId: requestId, limit: 100 },
}).queryKey;
let client: QueryClient;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	client?.clear();
	vi.useRealTimers();
});
async function mount(at: string) {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const render = () =>
		act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<FocusDecisionRow item={item(at)} actor="Robin" />
				</QueryClientProvider>,
			),
		);
	return render;
}
const title = () => host.querySelector(".focus-story")?.textContent;
// TanStack notifies observers on a macrotask; let one pass before asserting.
const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

it("titles a fresh row with the real ask and shows a one-line skeleton only while the summary is written", async () => {
	vi.mocked(osApi.attention.getDeckCard).mockReturnValue(new Promise(() => {}));
	const render = await mount(new Date().toISOString());
	await render();
	expect(title()).toBe("Confirm who staffs the booth?");
	expect(host.textContent).not.toContain("Preparing a shorter summary");
	const skeleton = host.querySelector("[data-face-pending]")!;
	expect(skeleton.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(1);
	expect(skeleton.textContent).toContain("Writing a short summary…");
	await act(async () => {
		client.setQueryData<unknown>(key, card(FACE));
	});
	await settle();
	expect(host.querySelector("[data-face-pending]")).toBeNull();
	expect(title()).toBe(FACE.title);
	expect(host.querySelector(".fd-face-enter")?.textContent).toContain(
		FACE.body,
	);
});

it("falls back immediately for an old request and after the wait for a fresh one, with Retry", async () => {
	vi.mocked(osApi.attention.getDeckCard).mockResolvedValue(card(null) as never);
	const render = await mount(new Date(Date.now() - 6 * 3600_000).toISOString());
	await render();
	await settle();
	expect(host.querySelector("[data-face-pending]")).toBeNull();
	const note = host.querySelector("[data-face-fallback]")!;
	expect(note.textContent).toContain("Summary unavailable");
	expect(title()).toBe("Confirm who staffs the booth?");
	expect(host.querySelector(".focus-face-fallback")?.textContent).toContain(
		"send the guest list yourself",
	);
	const retry = [...host.querySelectorAll("button")].find(
		(button) => button.textContent === "Retry",
	)!;
	expect(retry.disabled).toBe(false);
	vi.mocked(osApi.attention.getDeckCard).mockClear();
	await act(async () => retry.click());
	await settle();
	expect(osApi.attention.getDeckCard).toHaveBeenCalledTimes(1);
});

it("replaces a fresh row's skeleton with the original request once the summary takes too long", async () => {
	vi.useFakeTimers();
	vi.mocked(osApi.attention.getDeckCard).mockReturnValue(new Promise(() => {}));
	const render = await mount(new Date().toISOString());
	await render();
	expect(host.querySelector("[data-face-pending]")).not.toBeNull();
	await act(async () => {
		vi.advanceTimersByTime(8000);
	});
	expect(host.querySelector("[data-face-pending]")).toBeNull();
	expect(host.querySelector("[data-face-fallback]")).not.toBeNull();
	expect(title()).toBe("Confirm who staffs the booth?");
});

it("falls back at once when the writer reported the summary unavailable", async () => {
	const render = await mount(new Date().toISOString());
	client.setQueryData<unknown>(
		key,
		card(null, "Summary unavailable. Open Details to review the source."),
	);
	await render();
	expect(host.querySelector("[data-face-pending]")).toBeNull();
	expect(host.querySelector("[data-face-fallback]")).not.toBeNull();
	expect(host.textContent).not.toContain("Summary unavailable.");
});
