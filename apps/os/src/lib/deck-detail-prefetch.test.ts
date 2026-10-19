import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	DECK_DETAIL_WINDOW,
	prefetchDeckDetails,
} from "./deck-detail-prefetch";
const fetchDetail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/os-query-options", () => ({
	osQuery: {
		tediApprovals: {
			getById: {
				queryOptions: ({ input }: { input: { id: string } }) => ({
					queryKey: ["test-approval", input.id],
					queryFn: ({ signal }: { signal: AbortSignal }) =>
						fetchDetail(`approval:${input.id}`, signal),
				}),
			},
		},
	},
	workInteractionDetailQueryOptions: (id: string) => ({
		queryKey: ["test-detail", id],
		queryFn: ({ signal }: { signal: AbortSignal }) => fetchDetail(id, signal),
	}),
}));
afterEach(() => vi.clearAllMocks());
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
describe("Deck detail prefetch budget", () => {
	it("bounds lookahead to four, shares reads and serializes concurrent owners", async () => {
		const client = new QueryClient();
		let active = 0,
			maximum = 0;
		fetchDetail.mockImplementation(async (id) => {
			maximum = Math.max(maximum, ++active);
			await tick();
			active--;
			return { id };
		});
		const stop = prefetchDeckDetails(client, [
			"a",
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
		]);
		const stopOther = prefetchDeckDetails(client, ["a", "b", "c", "d"]);
		await vi.waitFor(() =>
			expect(fetchDetail).toHaveBeenCalledTimes(DECK_DETAIL_WINDOW),
		);
		await tick();
		expect(maximum).toBe(1);
		expect(fetchDetail.mock.calls.map(([id]) => id)).toEqual([
			"a",
			"b",
			"c",
			"d",
		]);
		stop();
		stopOther();
		client.clear();
	});
	it("warms runtime approvals and skips Work approvals already complete in the inbox", async () => {
		const client = new QueryClient();
		fetchDetail.mockResolvedValue({});
		const stop = prefetchDeckDetails(client, [
			"approval:a",
			"work-approval:b",
			"c",
		]);
		await vi.waitFor(() => expect(fetchDetail).toHaveBeenCalledTimes(2));
		expect(fetchDetail.mock.calls.map(([id]) => id)).toEqual([
			"approval:a",
			"c",
		]);
		stop();
		client.clear();
	});

	it("cancels an unobserved in-flight read and never starts remaining reads after unmount", async () => {
		const client = new QueryClient();
		fetchDetail.mockImplementation(() => new Promise(() => {}));
		const stop = prefetchDeckDetails(client, ["a", "b", "c", "d"]);
		const signal = fetchDetail.mock.calls[0]![1] as AbortSignal;
		stop();
		await tick();
		expect(signal.aborted).toBe(true);
		expect(fetchDetail).toHaveBeenCalledTimes(1);
		client.clear();
	});
	it("leaves an observed detail read alive when speculative ownership ends", async () => {
		const client = new QueryClient();
		fetchDetail.mockImplementation(() => new Promise(() => {}));
		const stop = prefetchDeckDetails(client, ["a", "b"]);
		const observer = new QueryObserver(client, {
			queryKey: ["test-detail", "a"],
			enabled: false,
		});
		const unsubscribe = observer.subscribe(() => {});
		const signal = fetchDetail.mock.calls[0]![1] as AbortSignal;
		stop();
		expect(signal.aborted).toBe(false);
		unsubscribe();
		client.clear();
	});
});
