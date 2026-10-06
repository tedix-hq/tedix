/**
 * `memoryGraph.expertise` tenant scoping.
 *
 * The underlying `getExpertise` query filters on `tediId` ALONE — it takes no
 * organization — so the router is the only place the caller's org is checked.
 * Without that check a `tedis:read` principal reads any organization's tedi
 * expertise by passing its id, which became reachable from a URL path segment
 * once the Tedix OS grew a per-tedi detail route.
 */

import { createRouterClient } from "@orpc/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const CALLER_ORG = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
const OTHER_ORG = "7c1d5f30-2b44-4e51-9a12-8d3f6b7c9e01";
const FOREIGN_TEDI = "3d1a6a2e-8a4f-4b6e-9c1d-0f2e3a4b5c6d";
const OWN_TEDI = "5b2c7e18-9f30-4a6d-8c14-2e7f9a1b3c5d";

const mocks = vi.hoisted(() => ({
	getTediById: vi.fn(),
	getExpertise: vi.fn(),
}));

vi.mock("@tedix/db/queries/tedis", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/tedis")>()),
	getTediById: mocks.getTediById,
}));
vi.mock("@tedix/db/queries/memory-graph/expertise", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/memory-graph/expertise")
	>()),
	getExpertise: mocks.getExpertise,
}));

function userContext(): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: CALLER_ORG,
		url: new URL("https://api.tedix.test/rpc/memory-graph"),
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
}

async function callExpertise(tediId: string) {
	const { memoryGraphContractRouter } = await import("./memory-graph");
	const client = createRouterClient(memoryGraphContractRouter, {
		context: userContext(),
	});
	return client.expertise({ tediId });
}

describe("memoryGraph.expertise tenant scope", () => {
	// Warm the expensive fixture ONCE, outside any assertion body. `callExpertise` dynamically imports the memory-graph router module.
	// Paying that inside whichever `it()` runs first puts it under vitest's 5s
	// default, so under CPU contention — a shared CI runner, or a busy laptop —
	// the test times out and reports as a failure of the assertion rather than
	// of the fixture.
	beforeAll(async () => {
		await import("./memory-graph");
	}, 120_000);

	it("refuses a tedi that belongs to another organization", async () => {
		mocks.getTediById.mockResolvedValue({
			id: FOREIGN_TEDI,
			organizationId: OTHER_ORG,
		});
		mocks.getExpertise.mockResolvedValue([]);

		await expect(callExpertise(FOREIGN_TEDI)).rejects.toThrow();
		// The refusal must happen BEFORE the unscoped read, not after.
		expect(mocks.getExpertise).not.toHaveBeenCalled();
	});

	it("reads a tedi in the caller's own organization", async () => {
		mocks.getTediById.mockResolvedValue({
			id: OWN_TEDI,
			organizationId: CALLER_ORG,
		});
		mocks.getExpertise.mockResolvedValue([]);

		await expect(callExpertise(OWN_TEDI)).resolves.toEqual({ expertise: [] });
		expect(mocks.getExpertise).toHaveBeenCalled();
	});
});
