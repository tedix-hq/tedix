import { createRouterClient } from "@orpc/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { attentionContractRouter } from "./attention";
const mocks = vi.hoisted(() => ({
	loadDeckProjection: vi.fn(),
	call: vi.fn(),
}));
vi.mock("../../services/attention-projection", () => ({
	loadDeckProjection: mocks.loadDeckProjection,
}));
vi.mock("@orpc/server", async (original) => ({
	...(await original<Record<string, unknown>>()),
	call: mocks.call,
}));
function client(
	scopes: string[] = ["mcp:messaging.read", "mcp:messaging.write"],
) {
	return createRouterClient(attentionContractRouter, {
		context: {
			authType: "apikey",
			apiKey: { id: "key", scopes },
			organizationId: "fictional-orchard",
			headers: new Headers(),
			env: { ENVIRONMENT: "test" },
			db: {},
			url: new URL("https://api.tedix.test/rpc/attention"),
		} as BaseContext,
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [],
		count: 0,
		complete: true,
		observedAt: "2026-10-19T12:00:00.000Z",
	});
});
it("refuses machine reads without messaging read scope before querying", async () => {
	await expect(client([]).listDeckCards({})).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	expect(mocks.loadDeckProjection).not.toHaveBeenCalled();
});
it("returns count and incompleteness independently from the bounded card list", async () => {
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [],
		count: 12,
		complete: false,
		observedAt: "2026-10-19T12:00:00.000Z",
	});
	expect(await client().listDeckCards({ limit: 1 })).toMatchObject({
		count: 12,
		complete: false,
	});
});
it("does not call a missing card absent when its inventory is incomplete", async () => {
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [],
		count: 0,
		complete: false,
	});
	await expect(
		client().getDeckCard({ cardId: "missing" }),
	).rejects.toMatchObject({ code: "CONFLICT" });
});
it("rejects a decision before its effect when inventory is incomplete", async () => {
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [],
		count: 0,
		complete: false,
	});
	await expect(
		client().decideDeckCard({
			kind: "interaction",
			decision: {
				requestId: "11111111-1111-4111-8111-111111111111",
				expectedRequestVersion: 2,
				responseKind: "answer",
				body: "Approved",
				resolvesRequest: true,
				metadata: {},
			},
		}),
	).rejects.toMatchObject({ code: "CONFLICT" });
});
it("requires an expected revision for factory feedback", async () => {
	await expect(
		client().decideDeckCard({
			kind: "factory",
			cardId: "factory:row",
			verdict: "useful",
			reason: "Good opportunity",
		} as never),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

it("forwards the exact expected interaction version through its canonical effect owner", async () => {
	const requestId = "11111111-1111-4111-8111-111111111111";
	mocks.loadDeckProjection.mockResolvedValue({
		cards: [{ id: requestId }],
		complete: true,
	});
	mocks.call.mockResolvedValue({});
	expect(
		await client().decideDeckCard({
			kind: "interaction",
			decision: {
				requestId,
				expectedRequestVersion: 7,
				responseKind: "answer",
				body: "Proceed",
				resolvesRequest: true,
				metadata: {},
			},
		}),
	).toEqual({ saved: true, cardId: requestId });
	expect(mocks.call).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ requestId, expectedRequestVersion: 7 }),
		expect.anything(),
	);
});
it("rejects an invalid timezone before reading source data", async () => {
	await expect(
		client().listDeckCards({ timeZone: "Not/AZone" }),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
	expect(mocks.loadDeckProjection).not.toHaveBeenCalled();
});
