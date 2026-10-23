import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { getApiClient } = vi.hoisted(() => ({
	getApiClient: vi.fn(
		({ serviceFetch }: { serviceFetch: Fetcher }) => serviceFetch as never,
	),
}));

vi.mock("./lib/api-client", () => ({ getApiClient }));

import { prefetchAggregateEntries } from "./aggregate-prefetch";

describe("aggregate prefetch batching", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("keeps concurrent batches isolated by API service binding", async () => {
		vi.useFakeTimers();
		const createBinding = () => {
			const getBySlugsWithTools = vi.fn(async ({ apps }) => ({
				results: apps.map(({ slug }: { slug: string }) => ({
					slug,
					app: null,
					tools: [],
				})),
			}));
			return {
				fetch: vi.fn(),
				apps: { getBySlugsWithTools },
				getBySlugsWithTools,
			} as unknown as Fetcher & {
				getBySlugsWithTools: typeof getBySlugsWithTools;
			};
		};
		const bindingA = createBinding();
		const bindingB = createBinding();
		const prefetch = (slug: string, API_SERVICE: Fetcher) =>
			prefetchAggregateEntries(
				[{ slug }],
				{ API_SERVICE } as CloudflareEnv,
				new Set(),
				"epoch",
				false,
			);

		const pending = [
			prefetch("service-a-app", bindingA),
			prefetch("service-b-app", bindingB),
		];
		await vi.runAllTimersAsync();
		await Promise.all(pending);

		expect(bindingA.getBySlugsWithTools).toHaveBeenCalledWith({
			apps: [expect.objectContaining({ slug: "service-a-app" })],
		});
		expect(bindingB.getBySlugsWithTools).toHaveBeenCalledWith({
			apps: [expect.objectContaining({ slug: "service-b-app" })],
		});
	});
});
