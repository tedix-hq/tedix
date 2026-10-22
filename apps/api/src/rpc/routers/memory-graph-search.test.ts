import { createRouterClient } from "@orpc/server";
import {
	beforeAll,
	beforeEach,
	afterEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	recall: vi.fn(),
	inventory: vi.fn(),
	hydrate: vi.fn(),
	topic: vi.fn(),
	count: vi.fn(),
	access: vi.fn(),
}));
vi.mock("@tedix/db/queries/memory-graph/hybrid-recall", () => ({
	hydrateRecall: mocks.hydrate,
	recordRecallAccess: mocks.access,
}));
vi.mock("../../services/memory-hybrid-recall", async (original) => ({
	...(await original<typeof import("../../services/memory-hybrid-recall")>()),
	recallMemoryFacts: mocks.recall,
}));
vi.mock(
	"@tedix/db/queries/memory-graph/fact-search",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@tedix/db/queries/memory-graph/fact-search")
		>()),
		countActiveFactsUpTo: mocks.count,
		searchFactsWithVisibility: mocks.inventory,
	}),
);
vi.mock("@tedix/db/queries/memory-graph/facts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/memory-graph/facts")
	>()),
	getFactsByIds: mocks.hydrate,
	findCurrentFactsByTopicKey: mocks.topic,
}));
const context = {
	authType: "user",
	db: {},
	env: { ENVIRONMENT: "production" },
	organizationId: "0b90b0e2-14da-4a34-bd35-a416ab604f25",
	headers: new Headers(),
	url: new URL("https://api.tedix.test/rpc/memory-graph"),
	user: {
		aud: "test",
		dct: "tenant-1",
		exp: 2,
		iat: 1,
		iss: "test",
		permissions: ["tedis:read"],
		roles: [],
		sub: "user-1",
	},
} as BaseContext;
async function search(input: { query?: string; topicKey?: string }) {
	const { memoryGraphContractRouter } = await import("./memory-graph");
	return createRouterClient(memoryGraphContractRouter, { context }).search(
		input,
	);
}
beforeAll(async () => {
	await import("./memory-graph");
}, 120_000);
beforeEach(() => {
	vi.clearAllMocks();
	mocks.recall.mockResolvedValue([]);
	mocks.hydrate.mockResolvedValue([]);
	mocks.topic.mockResolvedValue([]);
	mocks.count.mockResolvedValue({ count: 20, capped: false });
	mocks.access.mockResolvedValue(undefined);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("governed memory search", () => {
	it("does not let a hung informational count hold the recall response", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2090-01-01T00:00:00.000Z"));
		mocks.count.mockImplementation(() => new Promise(() => {}));
		const pending = search({ query: "cobalt" });
		await vi.advanceTimersByTimeAsync(51);
		const result = await pending;
		expect(result.totalFactsApproximate).toBe(true);
		expect(result.results).toEqual([]);
		expect(result.retrievalMs).toBeLessThan(100);
	});
	it("reports a capped fact count as an approximate lower bound in the public response shape", async () => {
		// A later system time expires the isolate's one-minute count cache.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2091-01-01T00:00:00.000Z"));
		mocks.count.mockResolvedValue({ count: 1_000, capped: true });
		const result = await search({ query: "cobalt" });
		expect(mocks.count).toHaveBeenCalledWith(
			context.db,
			context.organizationId,
			1_000,
		);
		const { memoryGraphContract } =
			await import("@tedix/api-contract/contracts/memory-graph");
		const [output] = (
			memoryGraphContract.search["~orpc"] as unknown as {
				outputSchemas: Array<{
					safeParse(value: unknown): { success: boolean };
				}>;
			}
		).outputSchemas;
		expect(output!.safeParse(result).success).toBe(true);
		expect(Object.keys(result).sort()).toEqual([
			"query",
			"results",
			"retrievalMs",
			"totalFacts",
			"totalFactsApproximate",
		]);
		expect(result.totalFacts).toBe(1_000);
		expect(result.totalFactsApproximate).toBe(true);

		vi.setSystemTime(new Date("2092-01-01T00:00:00.000Z"));
		mocks.count.mockResolvedValue({ count: 20, capped: false });
		const exact = await search({ query: "cobalt" });
		expect(exact.totalFacts).toBe(20);
		expect(exact).not.toHaveProperty("totalFactsApproximate");
	});
	it("keeps computed recall projection fields outside the canonical fact contract", async () => {
		const factId = "11111111-1111-4111-8111-111111111111";
		const provenance = {
			arms: [{ arm: "lexical", rank: 1, score: 2 }],
			fusionScore: 1 / 61,
			replacesFactIds: ["older-fact"],
		};
		mocks.recall.mockResolvedValue([
			{
				factId,
				score: 1 / 61,
				provenance,
				fact: {
					id: factId,
					organizationId: context.organizationId,
					content: "Fictional recall evidence",
					factType: "technical",
					confidence: 0.8,
					visibility: "org",
					accessCount: 0,
					usageCount: 0,
					replacesFactIds: ["older-fact"],
				},
			},
		]);
		const result = await search({ query: "recall evidence" });
		expect(result.results).toHaveLength(1);
		expect(mocks.access).toHaveBeenCalledTimes(1);
		expect(mocks.access).toHaveBeenCalledWith(
			context.db,
			context.organizationId,
			[factId],
		);
		expect(result.results[0]!.fact).not.toHaveProperty("replacesFactIds");
		expect(result.results[0]!.provenance).toEqual(provenance);
	});
	it("does not fill an empty recall with unrelated inventory and logs production timing", async () => {
		const result = await search({ query: "private question text" });
		expect(result.results).toEqual([]);
		expect(mocks.inventory).not.toHaveBeenCalled();
		const logs = JSON.stringify(vi.mocked(console.log).mock.calls);
		expect(logs).toContain("hybrid");
		expect(logs).toContain("hybridMs");
		expect(logs).toContain("empty");
		expect(logs).not.toContain("private question text");
	});
	it("fails soft without pretending an outage found relevant facts", async () => {
		mocks.recall.mockRejectedValue(new Error("unavailable"));
		expect((await search({ query: "question" })).results).toEqual([]);
		expect(mocks.inventory).not.toHaveBeenCalled();
		expect(JSON.stringify(vi.mocked(console.log).mock.calls)).toContain(
			"error",
		);
	});
	it("uses exact D1 topic matches without invoking semantic recall", async () => {
		mocks.topic.mockResolvedValue([
			{ id: "11111111-1111-4111-8111-111111111111" },
		]);
		await search({ topicKey: "ops.rule" });
		expect(mocks.recall).not.toHaveBeenCalled();
		expect(JSON.stringify(vi.mocked(console.log).mock.calls)).toContain(
			"d1_topic",
		);
	});
});
