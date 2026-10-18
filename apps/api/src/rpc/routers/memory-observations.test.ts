import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
const mocks = vi.hoisted(() => ({ list: vi.fn(), consolidate: vi.fn() }));
vi.mock("@tedix/db/queries/memory-graph/observations", () => ({
	listMemoryObservations: mocks.list,
	consolidateMemory: mocks.consolidate,
}));
import {
	listObservations,
	consolidateObservations,
} from "./memory-graph/observations";
const context = {
	authType: "apikey",
	db: {},
	env: { ENVIRONMENT: "test" },
	headers: new Headers(),
	organizationId: "fictional-orchard",
	apiKey: {
		id: "fictional-key",
		scopes: ["mcp:memory.read", "mcp:memory.write"],
	},
	url: new URL("https://api.orchard.test/rpc"),
} as BaseContext;
const client = (overrides: Partial<BaseContext> = {}) =>
	createRouterClient(
		{ listObservations, consolidateObservations },
		{ context: { ...context, ...overrides } },
	);
beforeEach(() => {
	vi.clearAllMocks();
	mocks.list.mockResolvedValue([]);
	mocks.consolidate.mockResolvedValue({ observations: 1, overflow: 0 });
});
describe("memory observation authorization", () => {
	it("binds reads and writes to the authenticated organization", async () => {
		await expect(
			client().listObservations({ topicKey: "orchard:repo" }),
		).resolves.toEqual({ facts: [] });
		expect(mocks.list).toHaveBeenCalledWith(context.db, "fictional-orchard", {
			topicKey: "orchard:repo",
		});
		await client().consolidateObservations({ topicKey: "orchard:repo" });
		expect(mocks.consolidate).toHaveBeenCalledWith(
			context.db,
			"fictional-orchard",
			{ topicKey: "orchard:repo" },
		);
	});
	it("rejects a missing organization and a read-only key on mutation", async () => {
		await expect(
			client({ organizationId: undefined }).listObservations({}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			client({
				apiKey: { ...context.apiKey!, scopes: ["mcp:memory.read"] },
			}).consolidateObservations({}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.consolidate).not.toHaveBeenCalled();
	});
	it("rejects undeclared tenant or filter input instead of broadening the read", async () => {
		await expect(
			client().listObservations({ organizationId: "fictional-pine" } as never),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.list).not.toHaveBeenCalled();
	});
	it("binds both operations to the calling tedi and rejects another private scope", async () => {
		const own = client({
			authType: "tedi",
			tediId: "orchard-worker",
			tediScopes: ["mcp:memory.read", "mcp:memory.write"],
		});
		await own.listObservations({});
		await own.consolidateObservations({});
		expect(mocks.list).toHaveBeenCalledWith(context.db, "fictional-orchard", {
			tediId: "orchard-worker",
		});
		expect(mocks.consolidate).toHaveBeenCalledWith(
			context.db,
			"fictional-orchard",
			{ tediId: "orchard-worker" },
		);
		await expect(
			own.listObservations({ tediId: "other-worker" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			own.consolidateObservations({ tediId: "other-worker" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
