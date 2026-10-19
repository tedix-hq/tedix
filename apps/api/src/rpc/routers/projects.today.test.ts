import { createRouterClient } from "@orpc/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { projectsContractRouter } from "./projects";

const mocks = vi.hoisted(() => ({
	getProjectById: vi.fn(),
	verifiedActiveWorkActor: vi.fn(),
	loadDeckProjection: vi.fn(),
	getTodayProjectTotals: vi.fn(),
}));
vi.mock("@tedix/db/queries/projects", async (original) => ({
	...(await original<Record<string, unknown>>()),
	getProjectById: mocks.getProjectById,
}));
vi.mock("./work-items-principal", async (original) => ({
	...(await original<Record<string, unknown>>()),
	verifiedActiveWorkActor: mocks.verifiedActiveWorkActor,
}));
vi.mock("../../services/attention-projection", () => ({
	loadDeckProjection: mocks.loadDeckProjection,
}));
vi.mock("@tedix/db/queries/today-project", () => ({
	getTodayProjectTotals: mocks.getTodayProjectTotals,
}));

const id = "11111111-1111-4111-8111-111111111111";
const input = {
	id,
	personId: "river",
	excludeOutputId: "22222222-2222-4222-8222-222222222222",
	timeZone: "Europe/Berlin",
	since: "2026-10-18T22:00:00.000Z",
	until: "2026-10-19T22:00:00.000Z",
};
function client(overrides: Partial<BaseContext> = {}) {
	return createRouterClient(projectsContractRouter, {
		context: {
			authType: "user",
			db: {},
			env: { ENVIRONMENT: "test" },
			headers: new Headers(),
			organizationId: "fictional-orchard",
			url: new URL("https://api.tedix.test/rpc/projects"),
			user: {
				aud: "test",
				dct: "tenant",
				exp: 2,
				iat: 1,
				iss: "https://auth.tedix.test",
				permissions: ["tedis:read"],
				roles: [],
				sub: "river",
			},
			...overrides,
		} as BaseContext,
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.getProjectById.mockResolvedValue({
		id,
		orgId: "fictional-orchard",
		objectiveId: null,
	});
	mocks.verifiedActiveWorkActor.mockResolvedValue({
		type: "user",
		id: "river",
	});
	mocks.loadDeckProjection.mockResolvedValue({
		count: 7,
		cards: [],
		complete: true,
	});
	mocks.getTodayProjectTotals.mockResolvedValue({
		decisions: 3,
		documents: 1,
		lastTouched: null,
		receiptsJson: "[]",
	});
});
it("uses the same complete Deck projection and timezone for saved Today totals", async () => {
	expect(await client().getTodayTotals(input)).toMatchObject({
		needsYou: 7,
		decisions: 3,
		documents: 1,
	});
	expect(mocks.loadDeckProjection).toHaveBeenCalledWith(expect.anything(), {
		projectId: id,
		gadgetId: undefined,
		timeZone: "Europe/Berlin",
		limit: 100,
	});
});
it("rejects an incomplete projection without falling back to ledger counts", async () => {
	mocks.loadDeckProjection.mockResolvedValue({
		count: 200,
		cards: [],
		complete: false,
	});
	await expect(client().getTodayTotals(input)).rejects.toMatchObject({
		code: "SERVICE_UNAVAILABLE",
	});
	expect(mocks.getTodayProjectTotals).not.toHaveBeenCalled();
});
it("lets scheduled summaries read receipts without reading or impersonating a person's Deck", async () => {
	expect(
		await client({
			authType: "service-binding",
			tediId: "scheduler",
			tediScopes: ["mcp:memory.read"],
			headers: new Headers({
				"X-Service-Binding": "true",
				"X-Tedix-Mcp-Tool-Id": "get_today_totals",
				"X-Tedix-Tedi-Scopes": "mcp:memory.read",
			}),
			user: undefined,
		}).getTodayTotals({ ...input, includeDeckCount: false }),
	).toMatchObject({
		needsYou: null,
		decisions: 3,
		documents: 1,
	});
	expect(mocks.verifiedActiveWorkActor).not.toHaveBeenCalled();
	expect(mocks.loadDeckProjection).not.toHaveBeenCalled();
	expect(mocks.getTodayProjectTotals).toHaveBeenCalled();
});
it.each([
	{ type: "user", id: "someone-else" },
	{ type: "tedi", id: "river" },
])("does not read another recipient's Deck for $type", async (actor) => {
	mocks.verifiedActiveWorkActor.mockResolvedValue(actor);
	await expect(client().getTodayTotals(input)).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	expect(mocks.loadDeckProjection).not.toHaveBeenCalled();
});
