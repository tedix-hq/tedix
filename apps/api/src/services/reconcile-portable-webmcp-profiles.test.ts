import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { reconcilePublishedWebMcpProfiles } from "./reconcile-portable-webmcp-profiles";

const state: {
	configurations: unknown[];
	catalogTools: { toolId: string }[];
	published: Array<{
		installationId: string;
		expectedRevision: number;
		profile: { routes: Array<{ id: string; tools: { callable: string }[] }> };
		changeSummary: string;
		publishedBy: string;
	}>;
	publishResult: "ok" | "conflict" | "null" | "throw";
} = {
	configurations: [],
	catalogTools: [],
	published: [],
	publishResult: "ok",
};

beforeEach(() => {
	state.configurations = [];
	state.catalogTools = [];
	state.published = [];
	state.publishResult = "ok";
	mocks.catalog.mockReset();
	mocks.list.mockReset();
	mocks.publish.mockReset();
	mocks.catalog.mockImplementation(async () => state.catalogTools);
	mocks.list.mockImplementation(async () => state.configurations);
	mocks.publish.mockImplementation(
		async (_db: unknown, input: (typeof state.published)[number]) => {
			if (state.publishResult === "throw") throw new Error("write failed");
			if (state.publishResult === "conflict") return "conflict";
			if (state.publishResult === "null") return null;
			state.published.push(input);
			return { revision: input.expectedRevision + 1 };
		},
	);
});

const mocks = vi.hoisted(() => ({
	catalog: vi.fn(),
	list: vi.fn(),
	publish: vi.fn(),
}));
vi.mock("@tedix/db/queries/app-gating", () => ({
	getPortableWebMcpToolAdmissions: mocks.catalog,
}));
vi.mock("@tedix/db/queries/provider-installations", () => ({
	listProviderPortableWebMcpConfigurations: mocks.list,
	publishProviderPortableWebMcpProfile: mocks.publish,
}));

const APP = "app-1";
const ORG = "org-1";

const configuration = (
	installationId: string,
	revision: number,
	routes: Array<{ id: string; tools: Array<Record<string, unknown>> }>,
	overrides: Record<string, unknown> = {},
) => ({
	installationId,
	providerAppId: APP,
	hostTenantNamespace: "acme_staging",
	revision,
	profile: { version: 1, routes },
	...overrides,
});

const run = () =>
	reconcilePublishedWebMcpProfiles({} as never, {
		providerOrganizationId: ORG,
		providerAppId: APP,
		reason: "test import",
		publishedBy: "system:test",
	});

describe("reconciling a published profile against the live tool set", () => {
	test("prunes a callable the provider no longer ships", async () => {
		state.catalogTools = [{ toolId: "orders_search" }];
		state.configurations = [
			configuration("i1", 4, [
				{
					id: "orders",
					tools: [
						{ callable: "acme_staging.orders_list" },
						{ callable: "acme_staging.orders_search" },
					],
				},
			]),
		];

		const [result] = await run();

		expect(result).toMatchObject({
			installationId: "i1",
			fromRevision: 4,
			toRevision: 5,
			status: "reconciled",
			removedCallables: ["acme_staging.orders_list"],
		});
		expect(state.published).toHaveLength(1);
		expect(state.published[0]?.expectedRevision).toBe(4);
		expect(state.published[0]?.profile.routes[0]?.tools).toEqual([
			{ callable: "acme_staging.orders_search" },
		]);
		expect(state.published[0]?.changeSummary).toContain("orders_list");
		expect(state.published[0]?.changeSummary).toContain("test import");
	});

	test("leaves a profile with nothing stale untouched", async () => {
		state.catalogTools = [{ toolId: "orders_search" }];
		state.configurations = [
			configuration("i1", 7, [
				{
					id: "orders",
					tools: [{ callable: "acme_staging.orders_search" }],
				},
			]),
		];

		const [result] = await run();

		expect(result).toMatchObject({
			status: "unchanged",
			fromRevision: 7,
			toRevision: 7,
			removedCallables: [],
		});
		expect(state.published).toHaveLength(0);
	});

	test("reports rather than publishes a route that pruning would empty", async () => {
		state.catalogTools = [{ toolId: "orders_search" }];
		state.configurations = [
			configuration("i1", 2, [
				{
					id: "orders",
					tools: [{ callable: "acme_staging.orders_search" }],
				},
				{ id: "legacy", tools: [{ callable: "acme_staging.orders_list" }] },
			]),
		];

		const [result] = await run();

		expect(result).toMatchObject({
			status: "route_would_empty",
			toRevision: null,
		});
		expect(result?.message).toContain("legacy");
		// A broken profile is better than an empty route nobody chose.
		expect(state.published).toHaveLength(0);
	});

	test("never prunes a platform tool or another namespace", async () => {
		state.catalogTools = [{ toolId: "orders_search" }];
		state.configurations = [
			configuration("i1", 1, [
				{
					id: "orders",
					tools: [
						{ callable: "work.list_work_items", authority: "tedix_tenant" },
						{ callable: "other_ns.something" },
						{ callable: "acme_staging.orders_search" },
					],
				},
			]),
		];

		expect((await run())[0]).toMatchObject({
			status: "unchanged",
			removedCallables: [],
		});
	});

	test("reconciles every installation of the provider independently", async () => {
		state.catalogTools = [{ toolId: "orders_search" }];
		state.configurations = [
			configuration("i1", 4, [
				{
					id: "orders",
					tools: [
						{ callable: "acme_staging.orders_list" },
						{ callable: "acme_staging.orders_search" },
					],
				},
			]),
			configuration("i2", 9, [
				{
					id: "orders",
					tools: [{ callable: "acme_staging.orders_search" }],
				},
			]),
			// A different provider app must not be touched by this import.
			configuration(
				"i3",
				1,
				[
					{
						id: "orders",
						tools: [{ callable: "acme_staging.orders_list" }],
					},
					{ id: "x", tools: [{ callable: "acme_staging.orders_search" }] },
				],
				{ providerAppId: "app-2" },
			),
		];

		const results = await run();

		expect(
			results.map((entry) => [entry.installationId, entry.status]),
		).toEqual([
			["i1", "reconciled"],
			["i2", "unchanged"],
		]);
		expect(state.published.map((entry) => entry.installationId)).toEqual([
			"i1",
		]);
	});

	test("an installation with no published profile is skipped", async () => {
		state.catalogTools = [{ toolId: "orders_search" }];
		state.configurations = [configuration("i1", 0, [], { profile: null })];

		expect(await run()).toEqual([]);
	});
});

describe("when a profile cannot be written", () => {
	test("a concurrent change is reported, not retried blindly", async () => {
		state.publishResult = "conflict";
		state.catalogTools = [{ toolId: "orders_search" }];
		state.configurations = [
			configuration("i1", 4, [
				{
					id: "orders",
					tools: [
						{ callable: "acme_staging.orders_list" },
						{ callable: "acme_staging.orders_search" },
					],
				},
			]),
		];

		expect((await run())[0]).toMatchObject({
			status: "conflict",
			toRevision: null,
		});
	});

	test("a write failure is captured per installation", async () => {
		state.publishResult = "throw";
		state.catalogTools = [{ toolId: "orders_search" }];
		state.configurations = [
			configuration("i1", 4, [
				{
					id: "orders",
					tools: [
						{ callable: "acme_staging.orders_list" },
						{ callable: "acme_staging.orders_search" },
					],
				},
			]),
		];

		const [result] = await run();
		expect(result).toMatchObject({ status: "failed", toRevision: null });
		expect(result?.message).toBe("write failed");
	});
});
