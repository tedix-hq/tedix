import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	orgs: vi.fn(),
	search: vi.fn(),
	citations: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/organizations", () => ({
	listOrganizations: mocks.orgs,
}));
vi.mock("@tedix/db/queries/memory-graph/hybrid-recall", () => ({
	backfillFactSearch: mocks.search,
}));
vi.mock("@tedix/db/queries/memory-graph/fact-citations", () => ({
	backfillFactCitations: mocks.citations,
}));
import { runMemoryReflection } from "./memory-reflection";
beforeEach(() => {
	vi.clearAllMocks();
	mocks.orgs.mockResolvedValue([
		{ id: "fictional-one" },
		{ id: "fictional-two" },
		{ id: "fictional-three" },
	]);
	mocks.search.mockResolvedValue(0);
	mocks.citations.mockResolvedValue(0);
});
function environment() {
	const create = vi.fn().mockResolvedValue({ id: "fictional-workflow" });
	return {
		env: {
			DB: {},
			MEMORY_REFLECTION_WORKFLOW: { create },
		} as unknown as CloudflareEnv,
		create,
	};
}
describe("memory maintenance citation backfill", () => {
	it("drains each org in pages and caps the tick at 2000 facts while dispatching every org", async () => {
		const { env, create } = environment();
		mocks.citations
			.mockResolvedValueOnce(100)
			.mockResolvedValueOnce(30)
			.mockImplementation(async (_db, _org, limit: number) =>
				Math.min(100, limit),
			);
		expect(await runMemoryReflection(env, "tick")).toMatchObject({
			citationFactsBackfilled: 2000,
			organizationsDispatched: 3,
		});
		const calls = mocks.citations.mock.calls.map((call) => call.slice(1));
		expect(calls.slice(0, 3)).toEqual([
			["fictional-one", 2000],
			["fictional-one", 1900],
			["fictional-two", 1870],
		]);
		expect(calls).toHaveLength(21);
		expect(calls.at(-1)).toEqual(["fictional-two", 70]);
		expect(create).toHaveBeenCalledTimes(3);
	});
	it("continues reflection and subsequent orgs when a backfill batch fails", async () => {
		const { env, create } = environment();
		mocks.citations.mockRejectedValueOnce(
			new Error("fixture backfill unavailable"),
		);
		expect(await runMemoryReflection(env, "tick")).toMatchObject({
			citationFactsBackfilled: 0,
			workflowsDispatched: 3,
		});
		expect(mocks.citations).toHaveBeenCalledTimes(3);
		expect(create).toHaveBeenCalledTimes(3);
	});
});
