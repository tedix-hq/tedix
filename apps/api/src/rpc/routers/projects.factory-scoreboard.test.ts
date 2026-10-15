import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { projectsContractRouter } from "./projects";

const mocks = vi.hoisted(() => ({
	listFactoryScoreboard: vi.fn(),
	listFactoryHealth: vi.fn(),
}));

vi.mock("@tedix/db/queries/factory-scoreboard", async (original) => ({
	...(await original<Record<string, unknown>>()),
	listFactoryScoreboard: mocks.listFactoryScoreboard,
}));
vi.mock("@tedix/db/queries/factories", async (original) => ({
	...(await original<Record<string, unknown>>()),
	listFactoryHealth: mocks.listFactoryHealth,
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";

function entry(overrides: Record<string, unknown>) {
	return {
		kind: "skill_loop",
		id: "skill-a",
		name: "Loop A",
		tediId: null,
		tediName: null,
		cron: "0 7 * * *",
		runs: 3,
		succeeded: 3,
		lastRunAt: null,
		outputs: 0,
		workClosed: 0,
		lastResult: null,
		paused: false,
		idle: true,
		...overrides,
	};
}

describe("factory scoreboard verdicts", () => {
	it("gives each loop its inspect_factory_health verdict and no Blueprint one", async () => {
		mocks.listFactoryScoreboard.mockResolvedValueOnce({
			since: "2026-10-09T00:00:00.000Z",
			data: [
				entry({}),
				entry({ id: "skill-b", name: "Loop B" }),
				entry({ kind: "blueprint", id: "bp-1", cron: null }),
			],
		});
		mocks.listFactoryHealth.mockResolvedValueOnce([
			{ skillId: "skill-a", verdict: "healthy", reason: "Delivered 1." },
			{ skillId: "skill-b", verdict: "failing", reason: "Run r2 failed." },
		]);
		const context = {
			authType: "user",
			db: {} as BaseContext["db"],
			env: { ENVIRONMENT: "test" } as CloudflareEnv,
			headers: new Headers(),
			organizationId: ORG_ID,
			url: new URL("https://api.tedix.test/rpc/projects"),
			user: {
				aud: "test",
				dct: "tenant-1",
				exp: 2,
				iat: 1,
				iss: "https://auth.tedix.test",
				permissions: ["tedis:read"],
				roles: [],
				sub: "user-1",
			},
		} as BaseContext;
		const client = createRouterClient(projectsContractRouter, { context });

		const result = await client.getFactoryScoreboard();

		expect(mocks.listFactoryHealth).toHaveBeenCalledWith(
			context.db,
			expect.objectContaining({ orgId: ORG_ID, runLimit: 7 }),
		);
		expect(
			result.data.map((row) => [row.id, row.verdict, row.verdictReason]),
		).toEqual([
			["skill-a", "healthy", "Delivered 1."],
			["skill-b", "failing", "Run r2 failed."],
			["bp-1", null, null],
		]);
	});
});
