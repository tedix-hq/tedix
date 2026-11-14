import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	getSite: vi.fn(),
	listSites: vi.fn(),
	moveSite: vi.fn(),
	setAuthoringApp: vi.fn(),
	getAppBySlug: vi.fn(),
	getAppsByOrganization: vi.fn(),
	createApp: vi.fn(),
	deleteApp: vi.fn(),
	updateApp: vi.fn(),
	getOrganizationById: vi.fn(),
	getOrganizationFeatures: vi.fn(),
	getGateways: vi.fn(),
	audit: vi.fn(),
	purgeAggregate: vi.fn(),
}));

vi.mock("@tedix/db/queries/cms-sites", () => ({
	getCmsSiteByIdForOrganization: mocks.getSite,
	listCmsSitesByOrganization: mocks.listSites,
	moveCmsSiteToOrganization: mocks.moveSite,
	setCmsSiteAuthoringApp: mocks.setAuthoringApp,
}));
vi.mock("@tedix/db/queries/app-records", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/app-records")>()),
	createApp: mocks.createApp,
	deleteApp: mocks.deleteApp,
	updateApp: mocks.updateApp,
}));
const CMS_APP = { id: "77777777-7777-4777-8777-777777777777", slug: "cms" };
vi.mock("@tedix/db/queries/aggregate-app-links", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/aggregate-app-links")
	>()),
	getAggregateAppLinkTargets: vi.fn(async () => [CMS_APP]),
}));
vi.mock("@tedix/db/queries/apps", () => ({
	getAppBySlug: mocks.getAppBySlug,
	getAppsByOrganization: mocks.getAppsByOrganization,
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.getOrganizationById,
	getOrganizationFeatures: mocks.getOrganizationFeatures,
}));
vi.mock("@tedix/db/queries/organization-members", () => ({
	getOrganizationAggregatorGateways: mocks.getGateways,
}));
vi.mock("@tedix/db/queries/docs-sites/sites", () => ({
	getDocsSiteById: vi.fn(),
}));
vi.mock("../../lib/mcp-subscriptions", () => ({
	purgeMcpAggregateCache: mocks.purgeAggregate,
}));
vi.mock("../audit-helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("../audit-helpers")>()),
	emitAuditEvent: mocks.audit,
}));

import { moveCmsSiteProcedure } from "./sites-move";
import { sitesOs } from "./sites-shared";

const SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const site = {
	id: "11111111-1111-4111-8111-111111111111",
	organizationId: SOURCE,
	slug: "acme",
	name: "Acme",
	status: "active",
	authoringAppId: "22222222-2222-4222-8222-222222222222",
};
const authoringApp = (id: string, organizationId: string) => ({
	id,
	organizationId,
	slug: "cms-acme",
	visibility: "private",
	metadata: {
		mcpConfig: {
			authMode: "authenticated",
			codeMode: true,
			expectedAudience: "https://cms-acme.mcp.tedix.dev/mcp",
			connectionLabel: "acme",
			aggregateApps: [{ appId: CMS_APP.id, slug: "cms" }],
		},
	},
});
const oldApp = authoringApp(site.authoringAppId, SOURCE);
const newApp = authoringApp("33333333-3333-4333-8333-333333333333", TARGET);
const targetGateway = {
	id: "gateway-target",
	organizationId: TARGET,
	slug: "target-unified",
	metadata: {
		mcpConfig: {
			aggregateApps: [
				{ appId: "other", slug: "other-app" },
				// A link the target already held to the app about to be deleted.
				{ appId: oldApp.id, slug: oldApp.slug, prefix: "cms_blog" },
				{ appId: "duplicate", slug: oldApp.slug },
			],
		},
	},
};
const input = {
	siteId: site.id,
	targetOrganizationId: TARGET,
	confirmation: "acme",
};

function client(platform = true) {
	const context = {
		authType: "user",
		db: {} as BaseContext["db"],
		env: {} as CloudflareEnv,
		headers: new Headers(),
		organizationId: SOURCE,
		url: new URL("https://api.tedix.test/rpc/sites"),
		user: {
			aud: "test",
			dct: "tenant",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: ["settings:manage"],
			roles: [],
			scope: platform ? "platform:admin" : "",
			sub: "owner-1",
		},
	} as BaseContext;
	return createRouterClient(sitesOs.router({ moveCms: moveCmsSiteProcedure }), {
		context,
	});
}

/** The site is in the source until the move query runs, then in the target. */
function siteStartsIn(organizationId: string) {
	let current = { ...site, organizationId };
	mocks.getSite.mockImplementation(
		async (_db: unknown, key: { organizationId: string }) =>
			key.organizationId === current.organizationId ? current : null,
	);
	mocks.moveSite.mockImplementation(async () => {
		current = { ...current, organizationId: TARGET };
		return true;
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getOrganizationById.mockResolvedValue({ id: TARGET, slug: "target" });
	mocks.getOrganizationFeatures.mockResolvedValue({ maxCmsSites: 5 });
	mocks.listSites.mockResolvedValue([]);
	mocks.setAuthoringApp.mockResolvedValue(true);
	mocks.createApp.mockResolvedValue(newApp);
	mocks.getGateways.mockResolvedValue(
		new Map([[TARGET, { slug: targetGateway.slug, customMcpDomain: null }]]),
	);
	mocks.getAppBySlug.mockImplementation(async (_db: unknown, slug: string) =>
		slug === targetGateway.slug ? targetGateway : oldApp,
	);
});

describe("moveCms", () => {
	it("requires a platform administrator", async () => {
		siteStartsIn(SOURCE);
		await expect(client(false).moveCms(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.moveSite).not.toHaveBeenCalled();
	});

	it("moves the site, replaces its authoring app and keeps gateway availability", async () => {
		siteStartsIn(SOURCE);
		await expect(client().moveCms(input)).resolves.toEqual({
			siteId: site.id,
			slug: "acme",
			organizationId: TARGET,
			authoringAppId: newApp.id,
			gatewayLinked: true,
		});
		expect(mocks.moveSite).toHaveBeenCalledWith(
			{},
			{ id: site.id, fromOrganizationId: SOURCE, toOrganizationId: TARGET },
		);
		expect(mocks.deleteApp).toHaveBeenCalledWith({}, oldApp.id);
		expect(mocks.createApp).toHaveBeenCalledWith(
			{},
			expect.objectContaining({ organizationId: TARGET, slug: "cms-acme" }),
		);
		expect(mocks.setAuthoringApp).toHaveBeenCalledWith(
			{},
			{ id: site.id, organizationId: TARGET, authoringAppId: newApp.id },
		);
		expect(mocks.updateApp).toHaveBeenCalledOnce();
		expect(
			mocks.updateApp.mock.calls[0]?.[2].metadata.mcpConfig.aggregateApps,
		).toEqual([
			{ appId: "other", slug: "other-app" },
			{ appId: newApp.id, slug: newApp.slug, prefix: "cms_blog" },
		]);
		expect(mocks.purgeAggregate).toHaveBeenCalledOnce();
		expect(mocks.audit).toHaveBeenCalledTimes(2);
	});

	it("finishes a move that stopped after the site row changed owner", async () => {
		siteStartsIn(TARGET);
		mocks.getAppBySlug.mockResolvedValue(null);
		mocks.getGateways.mockResolvedValue(new Map());
		await expect(client().moveCms(input)).resolves.toMatchObject({
			organizationId: TARGET,
			authoringAppId: newApp.id,
			gatewayLinked: false,
		});
		expect(mocks.updateApp).not.toHaveBeenCalled();
		expect(mocks.moveSite).not.toHaveBeenCalled();
		expect(mocks.deleteApp).not.toHaveBeenCalled();
		expect(mocks.createApp).toHaveBeenCalledOnce();
		expect(mocks.purgeAggregate).toHaveBeenCalledOnce();
	});

	it("leaves everything in place when the site cannot move", async () => {
		siteStartsIn(SOURCE);
		mocks.moveSite.mockResolvedValue(false);
		await expect(client().moveCms(input)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(mocks.deleteApp).not.toHaveBeenCalled();
		expect(mocks.createApp).not.toHaveBeenCalled();
	});

	it("refuses the wrong confirmation and a full target", async () => {
		siteStartsIn(SOURCE);
		await expect(
			client().moveCms({ ...input, confirmation: "other" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		mocks.getOrganizationFeatures.mockResolvedValue({ maxCmsSites: 1 });
		mocks.listSites.mockResolvedValue([{ id: "existing" }]);
		await expect(client().moveCms(input)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.moveSite).not.toHaveBeenCalled();
	});

	it("adds a prefixed gateway entry when the target had none", async () => {
		siteStartsIn(SOURCE);
		mocks.getAppBySlug.mockImplementation(async (_db: unknown, slug: string) =>
			slug === targetGateway.slug ? { ...targetGateway, metadata: {} } : oldApp,
		);
		await client().moveCms(input);
		expect(
			mocks.updateApp.mock.calls[0]?.[2].metadata.mcpConfig.aggregateApps,
		).toEqual([
			{
				appId: newApp.id,
				slug: newApp.slug,
				prefix: "cms_acme",
				connectionLabel: "acme",
			},
		]);
	});
});
