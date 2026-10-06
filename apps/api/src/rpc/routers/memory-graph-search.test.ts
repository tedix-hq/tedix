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
}));
vi.mock(
	"../../integrations/cloudflare/agent-memory",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../integrations/cloudflare/agent-memory")
		>()),
		recallCanonicalMemoryCandidates: mocks.recall,
	}),
);
vi.mock(
	"@tedix/db/queries/memory-graph/fact-search",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@tedix/db/queries/memory-graph/fact-search")
		>()),
		countFacts: mocks.count,
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
	mocks.count.mockResolvedValue(20);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("governed memory search", () => {
	it("does not fill an empty recall with unrelated inventory and logs production timing", async () => {
		const result = await search({ query: "private question text" });
		expect(result.results).toEqual([]);
		expect(mocks.inventory).not.toHaveBeenCalled();
		const logs = JSON.stringify(vi.mocked(console.log).mock.calls);
		expect(logs).toContain("agent_memory");
		expect(logs).toContain("agentMemoryMs");
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
