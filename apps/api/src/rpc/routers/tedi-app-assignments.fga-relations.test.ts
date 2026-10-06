/**
 * The FGA relation reads must publish what the authorization plane actually
 * says — including the parts no candidate list would have found — and must
 * never answer an outage with an empty relation set.
 *
 * `listByApp` can only report principals it already knew about: it batch-checks
 * the org's tedis and drops everything else. These two procedures read the
 * relations directly, so the cases worth proving are the ones the derived view
 * structurally cannot express: a grant held by an unknown principal, a grant
 * still held by a retired tedi, a relation name Tedix does not model, and a
 * failed query.
 *
 * They also carry a tenancy asymmetry that is easy to regress: the app read
 * echoes every target on a resource the org owns, while the tedi read counts —
 * and never names — resources the org does not own.
 */

import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	getManagementClient: vi.fn(() => ({}) as never),
	queryAppRelations: vi.fn(),
	queryTediRelations: vi.fn(),
	getAppById: vi.fn(),
	getTediById: vi.fn(),
	getAppsByOrganization: vi.fn(),
	getTedisByOrganization: vi.fn(),
}));

vi.mock("@tedix/auth/client", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, getManagementClient: mocks.getManagementClient };
});

vi.mock("@tedix/auth/fga", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		queryAppRelations: mocks.queryAppRelations,
		queryTediRelations: mocks.queryTediRelations,
	};
});

vi.mock("@tedix/db/queries/app-records", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, getAppById: mocks.getAppById };
});

vi.mock("@tedix/db/queries/apps", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, getAppsByOrganization: mocks.getAppsByOrganization };
});

vi.mock("@tedix/db/queries/tedis", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		getTediById: mocks.getTediById,
		getTedisByOrganization: mocks.getTedisByOrganization,
	};
});

import { tediAppAssignmentsContractRouter } from "./tedi-app-assignments";

const ORG_ID = "3f4d1c7a-8b2e-4f61-9a0d-5c6e7f8a9b01";
const FOREIGN_ORG_ID = "8a7b6c5d-4e3f-4a2b-9c8d-7e6f5a4b3c2d";
const OTHER_ORG_APP_ID = "5d2c9f10-7e3a-4b88-9c11-2e4f6a8b0c33";
const APP_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
const TEDI_ID = "9c1de3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const RETIRED_TEDI_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

function context(): BaseContext {
	return {
		apiKey: {
			id: "key-1",
			name: "test",
			organizationId: ORG_ID,
			scopes: ["tedis:read"],
		},
		authType: "apikey",
		db: {} as BaseContext["db"],
		env: {
			ENVIRONMENT: "test",
			DESCOPE_PROJECT_ID: "P-test",
			DESCOPE_MANAGEMENT_KEY: "K-test",
		} as unknown as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		url: new URL("https://api.tedix.test/rpc/tedi-app-assignments"),
	} as BaseContext;
}

function client() {
	return createRouterClient(tediAppAssignmentsContractRouter, {
		context: context(),
	});
}

const ACTIVE_TEDI = {
	id: TEDI_ID,
	name: "Active Tedi",
	slug: "active-tedi",
	organizationId: ORG_ID,
	descopeUserId: "descope-active",
	retiredAt: null,
};

const RETIRED_TEDI = {
	id: RETIRED_TEDI_ID,
	name: "Retired Tedi",
	slug: "retired-tedi",
	organizationId: ORG_ID,
	descopeUserId: "descope-retired",
	retiredAt: "2026-01-01T00:00:00.000Z",
};

const ORG_APP = {
	id: APP_ID,
	name: "Test App",
	slug: "test-app",
	organizationId: ORG_ID,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getManagementClient.mockReturnValue({} as never);
	mocks.getAppById.mockResolvedValue(ORG_APP);
	mocks.getAppsByOrganization.mockResolvedValue([ORG_APP]);
	mocks.getTediById.mockResolvedValue(ACTIVE_TEDI);
	mocks.getTedisByOrganization.mockResolvedValue([ACTIVE_TEDI, RETIRED_TEDI]);
	mocks.queryAppRelations.mockResolvedValue([]);
	mocks.queryTediRelations.mockResolvedValue([]);
});

describe("listFgaRelationsByApp", () => {
	it("names a grant held by a principal no candidate list contains", async () => {
		mocks.queryAppRelations.mockResolvedValue([
			{
				resource: APP_ID,
				namespace: "app",
				relationDefinition: "operator",
				target: "descope-active",
			},
			{
				resource: APP_ID,
				namespace: "app",
				relationDefinition: "operator",
				target: "descope-stranger",
			},
		]);

		const result = await client().listFgaRelationsByApp({ appId: APP_ID });

		expect(result.relations).toHaveLength(2);
		// The unknown principal is reported with its raw target — the app is
		// org-owned, so this is the org reading its own resource's ACL.
		const stranger = result.relations.find(
			(relation) => relation.target === "descope-stranger",
		);
		expect(stranger?.tediId).toBeNull();
		expect(stranger?.tediSlug).toBeNull();
		expect(stranger?.tediRetired).toBeNull();
		expect(result.unresolvedTargetCount).toBe(1);
	});

	it("resolves a retired tedi and flags it instead of hiding it in the unresolved count", async () => {
		mocks.queryAppRelations.mockResolvedValue([
			{
				resource: APP_ID,
				namespace: "app",
				relationDefinition: "operator",
				target: "descope-retired",
			},
		]);

		const result = await client().listFgaRelationsByApp({ appId: APP_ID });

		expect(mocks.getTedisByOrganization).toHaveBeenCalledWith(
			expect.anything(),
			ORG_ID,
			{ includeRetired: true },
		);
		expect(result.relations[0]?.tediId).toBe(RETIRED_TEDI_ID);
		expect(result.relations[0]?.tediRetired).toBe(true);
		expect(result.unresolvedTargetCount).toBe(0);
	});

	it("passes through a relation name Tedix does not model", async () => {
		mocks.queryAppRelations.mockResolvedValue([
			{
				resource: APP_ID,
				namespace: "app",
				// Not `operator`/`observer`: a closed enum on the wire would turn
				// this finding into a 500 and hide it.
				relationDefinition: "auditor",
				target: "descope-active",
			},
		]);

		const result = await client().listFgaRelationsByApp({ appId: APP_ID });

		expect(result.relations[0]?.relation).toBe("auditor");
	});

	it("propagates a failed query instead of reporting no relations", async () => {
		mocks.queryAppRelations.mockRejectedValue(
			new Error("FGA resourceRelations query failed: rate limited"),
		);

		await expect(
			client().listFgaRelationsByApp({ appId: APP_ID }),
		).rejects.toThrow(/rate limited/);
	});

	it("refuses an app outside the caller's organization before querying Descope", async () => {
		mocks.getAppById.mockResolvedValue({
			...ORG_APP,
			organizationId: FOREIGN_ORG_ID,
		});

		await expect(
			client().listFgaRelationsByApp({ appId: APP_ID }),
		).rejects.toThrow();
		expect(mocks.queryAppRelations).not.toHaveBeenCalled();
	});
});

describe("listFgaRelationsByTedi", () => {
	it("counts a relation on a resource the organization does not own without naming it", async () => {
		mocks.queryTediRelations.mockResolvedValue([
			{
				resource: APP_ID,
				namespace: "app",
				relationDefinition: "observer",
				target: "descope-active",
			},
			{
				resource: OTHER_ORG_APP_ID,
				namespace: "app",
				relationDefinition: "operator",
				target: "descope-active",
			},
		]);

		const result = await client().listFgaRelationsByTedi({ tediId: TEDI_ID });

		expect(result.relations).toEqual([
			{
				namespace: "app",
				relation: "observer",
				appId: APP_ID,
				appSlug: "test-app",
			},
		]);
		expect(result.unresolvedRelationCount).toBe(1);
		// The foreign resource ID belongs to another tenant and must not appear
		// anywhere in an org-scoped response.
		expect(JSON.stringify(result)).not.toContain(OTHER_ORG_APP_ID);
	});

	it("fails loudly for a tedi with no Descope identity rather than reporting no relations", async () => {
		mocks.getTediById.mockResolvedValue({
			...ACTIVE_TEDI,
			descopeUserId: null,
		});

		await expect(
			client().listFgaRelationsByTedi({ tediId: TEDI_ID }),
		).rejects.toThrow(/Descope identity/);
		// An empty target list makes `queryTediRelations` short-circuit to `[]`,
		// which would have looked exactly like a clean, empty answer.
		expect(mocks.queryTediRelations).not.toHaveBeenCalled();
	});

	it("propagates a failed query instead of reporting no relations", async () => {
		mocks.queryTediRelations.mockRejectedValue(
			new Error("FGA targetsRelations query failed: rate limited"),
		);

		await expect(
			client().listFgaRelationsByTedi({ tediId: TEDI_ID }),
		).rejects.toThrow(/rate limited/);
	});

	it("refuses a tedi outside the caller's organization before querying Descope", async () => {
		mocks.getTediById.mockResolvedValue({
			...ACTIVE_TEDI,
			organizationId: FOREIGN_ORG_ID,
		});

		await expect(
			client().listFgaRelationsByTedi({ tediId: TEDI_ID }),
		).rejects.toThrow();
		expect(mocks.queryTediRelations).not.toHaveBeenCalled();
	});
});
