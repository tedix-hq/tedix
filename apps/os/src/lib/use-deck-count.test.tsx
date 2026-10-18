import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { useDeckCount } from "./use-deck-count";
import { deckBatchKey, useDeckBatch } from "./use-deck-batch";
import { deckBatchWindow } from "./deck-attention";
import { osQuery, userProfileQueryOptions } from "./os-query-options";
vi.mock("./use-decision-inbox", () => ({
	useDecisionInbox: () => ({
		requests: ["a", "b", "c"].map((id) => ({ request: { id } })),
		work: [],
		approvals: { data: { data: [] } },
		count: 3,
		factoryCount: 0,
		pending: false,
		failed: false,
	}),
}));
const config = DecisionDeckConfigSchema.parse({
	version: 1,
	dailyAttentionBudget: 2,
	batchTimesUtc: ["00:00"],
});
const key = deckBatchKey(
	"workspace",
	"morgan",
	undefined,
	deckBatchWindow(config.batchTimesUtc).key,
);
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	sessionStorage.clear();
});
function Count() {
	const queue = useDeckCount(config, "workspace");
	return <output>{queue.count}</output>;
}
function Deck() {
	const { dismiss } = useDeckBatch(key, ["a", "b", "c"], 2, true);
	return <button onClick={() => dismiss("a")}>Later</button>;
}
it("Feed, sidebar and Deck observers share the saved batch and update together after Later", async () => {
	const client = new QueryClient({
		defaultOptions: {
			queries: { enabled: false, staleTime: Infinity, retry: false },
		},
	});
	client.setQueryData(userProfileQueryOptions().queryKey, {
		id: "morgan",
		email: "morgan@example.com",
		name: "Morgan",
		avatarUrl: null,
		revision: 0,
		updatedAt: null,
	});
	client.setQueryData(
		osQuery.learningFeedback.listInteractions.queryOptions({
			input: { scopeKind: "personal", limit: 200 },
		}).queryKey,
		{ events: [] },
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<Count />
				<Count />
				<Count />
				<Deck />
			</QueryClientProvider>,
		),
	);
	expect(
		[...host.querySelectorAll("output")].map((el) => el.textContent),
	).toEqual(["2", "2", "2"]);
	await act(async () => host.querySelector("button")!.click());
	expect(
		[...host.querySelectorAll("output")].map((el) => el.textContent),
	).toEqual(["1", "1", "1"]);
});
