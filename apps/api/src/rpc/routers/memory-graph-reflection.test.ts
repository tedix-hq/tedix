import { createRouterClient } from "@orpc/server";
import {
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { BaseContext } from "../orpc";
const mocks = vi.hoisted(() => ({
	searchFacts: vi.fn(),
	getEdgesForFacts: vi.fn(),
	getEdgesForFact: vi.fn(),
	resetCollapsedConfidence: vi.fn(),
	decayConfidence: vi.fn(),
	archiveLowConfidence: vi.fn(),
	listDomains: vi.fn(),
	getOrCreateDomain: vi.fn(),
	createEdge: vi.fn(),
	recalculateExpertise: vi.fn(),
}));
vi.mock("@tedix/db/queries/memory-graph/fact-search", async (original) => ({
	...(await original<object>()),
	searchFacts: mocks.searchFacts,
}));
vi.mock("@tedix/db/queries/memory-graph/edges", async (original) => ({
	...(await original<object>()),
	getEdgesForFacts: mocks.getEdgesForFacts,
	getEdgesForFact: mocks.getEdgesForFact,
	createEdge: mocks.createEdge,
}));
vi.mock("@tedix/db/queries/memory-graph/fact-lifecycle", async (original) => ({
	...(await original<object>()),
	resetCollapsedConfidence: mocks.resetCollapsedConfidence,
	decayConfidence: mocks.decayConfidence,
	archiveLowConfidence: mocks.archiveLowConfidence,
}));
vi.mock("@tedix/db/queries/memory-graph/domains", async (original) => ({
	...(await original<object>()),
	listDomains: mocks.listDomains,
	getOrCreateDomain: mocks.getOrCreateDomain,
}));
vi.mock("@tedix/db/queries/memory-graph/expertise", async (original) => ({
	...(await original<object>()),
	recalculateExpertise: mocks.recalculateExpertise,
}));
const context = {
	authType: "user",
	db: {},
	env: { ENVIRONMENT: "test" },
	headers: new Headers(),
	organizationId: "0b90b0e2-14da-4a34-bd35-a416ab604f25",
	url: new URL("https://api.tedix.test/rpc"),
	user: {
		aud: "test",
		dct: "tenant",
		exp: 2,
		iat: 1,
		iss: "test",
		permissions: ["tedis:read"],
		roles: [],
		sub: "user",
	},
} as BaseContext;
async function reflect(input: {
	scope?: "recent" | "full" | "domain";
	domain?: string;
	tediId?: string;
}) {
	const { memoryGraphContractRouter } = await import("./memory-graph");
	return createRouterClient(memoryGraphContractRouter, { context }).reflect(
		input,
	);
}
describe("interactive reflection scope", () => {
	beforeAll(async () => {
		await import("./memory-graph");
	}, 120_000);
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.searchFacts.mockResolvedValue([
			{ id: "one", domainId: "domain" },
			{ id: "two", domainId: "domain" },
		]);
		mocks.getEdgesForFacts.mockResolvedValue([]);
		mocks.listDomains.mockResolvedValue([
			{ id: "domain", name: "code" },
			{ id: "other", name: "other" },
		]);
		mocks.getOrCreateDomain.mockResolvedValue({ id: "domain", name: "code" });
		mocks.resetCollapsedConfidence.mockResolvedValue(0);
		mocks.decayConfidence.mockResolvedValue(0);
		mocks.archiveLowConfidence.mockResolvedValue({ count: 0, archivedIds: [] });
		mocks.createEdge.mockResolvedValue({});
		mocks.recalculateExpertise.mockResolvedValue(undefined);
	});
	it("bounds recent selection and every lifecycle update to the selected facts", async () => {
		const result = await reflect({ scope: "recent", tediId: "tedi" });
		expect(mocks.searchFacts).toHaveBeenCalledTimes(1);
		expect(mocks.searchFacts).toHaveBeenCalledWith(
			context.db,
			expect.objectContaining({ limit: 100, tediId: "tedi" }),
		);
		expect(mocks.getEdgesForFacts).toHaveBeenCalledExactlyOnceWith(context.db, [
			"one",
			"two",
		]);
		expect(mocks.getEdgesForFact).not.toHaveBeenCalled();
		expect(mocks.decayConfidence).toHaveBeenCalledWith(
			context.db,
			context.organizationId,
			0.99,
			0.1,
			expect.objectContaining({ factIds: ["one", "two"] }),
		);
		expect(mocks.resetCollapsedConfidence).toHaveBeenCalledWith(
			context.db,
			context.organizationId,
			0.8,
			["one", "two"],
		);
		expect(mocks.recalculateExpertise).toHaveBeenCalledExactlyOnceWith(
			context.db,
			"tedi",
			"domain",
		);
		expect(result.factsReviewed).toBe(2);
	});
	it("rejects a missing domain before reads or writes", async () => {
		await expect(reflect({ scope: "domain" })).rejects.toThrow(
			"domain is required",
		);
		expect(mocks.searchFacts).not.toHaveBeenCalled();
		expect(mocks.resetCollapsedConfidence).not.toHaveBeenCalled();
	});
	it("passes the requested domain into fact selection", async () => {
		await reflect({ scope: "domain", domain: "code" });
		expect(mocks.searchFacts).toHaveBeenCalledWith(
			context.db,
			expect.objectContaining({ domainId: "domain", limit: 100 }),
		);
	});
	it("keeps the existing full-workflow selection ceiling", async () => {
		await reflect({ scope: "full" });
		expect(mocks.searchFacts).toHaveBeenCalledWith(
			context.db,
			expect.objectContaining({ limit: 500 }),
		);
	});
	it("does not link facts archived during this reflection", async () => {
		mocks.archiveLowConfidence.mockResolvedValue({
			count: 1,
			archivedIds: ["two"],
		});
		await reflect({ scope: "recent" });
		expect(mocks.createEdge).not.toHaveBeenCalled();
	});
});
