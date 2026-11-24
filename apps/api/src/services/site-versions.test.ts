import { readFileSync } from "node:fs";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	checkSiteVersions,
	isVersionBehind,
	productPackageVersions,
	siteVersionAlerts,
} from "./site-versions";

const mocks = vi.hoisted(() => ({
	projects: vi.fn(),
	save: vi.fn(),
	cms: vi.fn(),
	docs: vi.fn(),
	org: vi.fn(),
	matching: vi.fn(),
	getItem: vi.fn(),
	byIntent: vi.fn(),
	create: vi.fn(),
	purpose: vi.fn(),
	comment: vi.fn(),
	lastComment: vi.fn(),
}));
vi.mock("@tedix/db/queries/site-versions", () => ({
	listSiteVersionProjects: mocks.projects,
	saveSiteVersionReport: mocks.save,
	findSiteUpgradeWork: mocks.matching,
}));
vi.mock("@tedix/db/queries/cms-sites", () => ({
	listCmsSitesByOrganization: mocks.cms,
}));
vi.mock("@tedix/db/queries/docs-sites/sites", () => ({
	listDocsSites: mocks.docs,
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.org,
}));
vi.mock("@tedix/db/queries/work-items/crud", () => ({
	getWorkItemById: mocks.getItem,
	getWorkItemBySourceIntentId: mocks.byIntent,
	createWorkItem: mocks.create,
}));
vi.mock("@tedix/db/queries/work-items/comments", () => ({
	addWorkItemComment: mocks.comment,
	getLatestWorkItemCommentByAuthor: mocks.lastComment,
}));
vi.mock("@tedix/db/queries/work-items/purpose", () => ({
	resolveWorkItemPurpose: mocks.purpose,
	WORK_ITEM_PURPOSE_EXCEPTION_MAX_MS: 86400000,
}));

const manifest = readFileSync(
	new URL("../../../../package.json", import.meta.url),
	"utf8",
);
afterEach(() => vi.unstubAllGlobals());
const dockerfile = readFileSync(
	new URL("../../../docs/Dockerfile", import.meta.url),
	"utf8",
);
/** npm's latest defaults to the runtime pin, so only the older theme is behind. */
const runtimeEmdash = productPackageVersions(manifest, dockerfile).runtime
	.emdash!;
/** A release newer than every pin, so runtime and theme are both behind. */
const newerEmdash = "99.0.0";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projects.mockResolvedValue([
		{
			id: "project",
			orgId: "org",
			key: "SITES",
			objectiveId: "objective",
			metadata: { siteVersionCheck: { enabled: true } },
		},
	]);
	mocks.org.mockResolvedValue({ slug: "example" });
	mocks.cms.mockResolvedValue([
		{ id: "cms", slug: "example", organizationId: "org" },
	]);
	mocks.docs.mockResolvedValue([{ id: "docs", slug: "guide" }]);
	mocks.purpose.mockResolvedValue({
		objectiveId: "objective",
		workClass: "objective",
	});
	mocks.getItem.mockResolvedValue(null);
	mocks.matching.mockResolvedValue(null);
	const commentBodies = new Map<string, string>();
	mocks.comment.mockImplementation(async (_db, params) => {
		commentBodies.set(params.workItemId, params.body);
		return { id: params.id };
	});
	mocks.lastComment.mockImplementation(async (_db, { workItemId }) => {
		const body = commentBodies.get(workItemId);
		return body ? { body } : null;
	});
	const items = new Map<string, { id: string }>();
	mocks.byIntent.mockImplementation(
		async (_db, { sourceIntentId }) => items.get(sourceIntentId) ?? null,
	);
	mocks.create.mockImplementation(async (_db, item) =>
		items.set(item.sourceIntentId, { id: item.id }),
	);
});

function input(failTheme = false, latest: Record<string, string> = {}) {
	const fetcher = vi.fn(async (url: string) => {
		if (url.endsWith("/package.json")) return new Response(manifest);
		if (url.endsWith("/apps/docs/Dockerfile")) return new Response(dockerfile);
		const name = decodeURIComponent(
			url.split("registry.npmjs.org/")[1]!.replace(/\/latest$/, ""),
		);
		if (latest[name]) return Response.json({ version: latest[name] });
		if (name === "@emdash-cms/plugin-forms")
			return new Response("offline", { status: 503 });
		const pins = productPackageVersions(manifest, dockerfile);
		return Response.json({
			version: ({ ...pins.runtime, ...pins.docs } as Record<string, string>)[
				name
			],
		});
	});
	vi.stubGlobal("fetch", fetcher);
	return {
		db: {} as Parameters<typeof checkSiteVersions>[0]["db"],
		env: {
			GIT_SHA: "a".repeat(40),
			RELEASE_REPOSITORY: "example/product",
			PLATFORM_SERVICE_TOKEN: "test-token",
			CMS: {
				fetch: vi.fn(async (request: Request) => {
					expect(request.url).toMatch(
						/\/deployments\/(example|second)\/theme-version$/,
					);
					expect(request.headers.get("Authorization")).toBe(
						"Bearer test-token",
					);
					if (failTheme) return Response.json({ active: { release: {} } });
					return Response.json({
						active: {
							sourceRevision: {
								kind: "artifacts_commit",
								value: "b".repeat(40),
							},
							release: {
								packages: {
									emdash: ["1.4.0", "1.5.0"],
									"@emdash-cms/plugin-forms": ["0.2.12"],
								},
							},
						},
					});
				}),
			},
		} as unknown as CloudflareEnv,
	};
}

describe("site version check", () => {
	it("compares versions numerically without downgrading", () => {
		expect(isVersionBehind("1.9.0", "1.10.0")).toBe(true);
		expect(isVersionBehind("1.10.0", "1.9.0")).toBe(false);
		expect(isVersionBehind("1.5.0", "1.5.0")).toBe(false);
		expect(isVersionBehind("1.5.0-rc.1", "1.5.0")).toBe(true);
		expect(isVersionBehind("unknown", "1.5.0")).toBeNull();
	});

	it("reports every site, reuses one Work per target across runs, and keeps npm failures unknown", async () => {
		const params = input();
		const [first] = await checkSiteVersions(params);
		const [second] = await checkSiteVersions(params);
		expect(first!.sites).toHaveLength(2);
		expect(first!.alerts).toEqual([
			{
				message: `Upgrade example: theme to EmDash ${runtimeEmdash}`,
				workItemId: expect.any(String),
			},
		]);
		expect(second!.alerts).toEqual(first!.alerts);
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(
			first!.sites[0]!.packages.find((pkg) =>
				pkg.package.endsWith("plugin-forms"),
			),
		).toMatchObject({ latest: null, behind: null });
		expect(first!.sites[0]!.errors).toContain(
			"Latest npm release unavailable for @emdash-cms/plugin-forms",
		);
		expect(first!.sites[1]!.packages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					package: "@cloudflare/nimbus-docs",
					source: "docs image",
					behind: false,
				}),
			]),
		);
	});

	it("groups packages by site and source with one alert per site across repeated checks", async () => {
		mocks.cms.mockResolvedValue([
			{ id: "cms", slug: "example", organizationId: "org" },
			{ id: "cms-two", slug: "second", organizationId: "org" },
		]);
		const params = input(false, {
			emdash: newerEmdash,
			"@emdash-cms/plugin-forms": "0.3.0",
		});
		const [first] = await checkSiteVersions(params);
		const [second] = await checkSiteVersions(params);
		expect(mocks.create).toHaveBeenCalledTimes(4);
		expect(first!.alerts).toHaveLength(2);
		expect(first!.alerts.map((alert) => alert.message)).toEqual([
			`Upgrade example: runtime to EmDash ${newerEmdash}; theme to EmDash ${newerEmdash}`,
			`Upgrade second: runtime to EmDash ${newerEmdash}; theme to EmDash ${newerEmdash}`,
		]);
		expect(second!.alerts).toEqual(first!.alerts);
		const items = mocks.create.mock.calls.map((call) => call[1]);
		expect(new Set(items.map((item) => item.sourceIntentId)).size).toBe(4);
		const theme = items.find(
			(item) =>
				item.title === `Upgrade the example theme to EmDash ${newerEmdash}`,
		);
		const details = JSON.parse(theme.description.split("\n\n")[1]);
		expect(details).toMatchObject({
			siteId: "cms",
			source: "theme",
			themeRevision: "b".repeat(40),
		});
		expect(details.packages).toHaveLength(3);
		expect(details.packages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					package: "emdash",
					installed: "1.4.0",
					latest: newerEmdash,
				}),
				expect.objectContaining({
					package: "@emdash-cms/plugin-forms",
					installed: "0.2.12",
					latest: "0.3.0",
				}),
			]),
		);
	});

	it("files one shared item for docs sites on the same release and skips unchanged comments", async () => {
		mocks.cms.mockResolvedValue([]);
		mocks.docs.mockResolvedValue([
			{ id: "docs", slug: "guide" },
			{ id: "docs-two", slug: "internal" },
		]);
		const params = input(false, {
			"@cloudflare/nimbus-docs": "99.0.0",
			"@cloudflare/create-nimbus-docs": "99.0.0",
		});
		const [first] = await checkSiteVersions(params);
		const [second] = await checkSiteVersions(params);
		expect(mocks.create).toHaveBeenCalledTimes(1);
		const item = mocks.create.mock.calls[0]![1];
		expect(item.title).toBe("Upgrade the docs image to Nimbus 99.0.0");
		const details = JSON.parse(item.description.split("\n\n")[1]);
		expect(details.sites.map((site: { slug: string }) => site.slug)).toEqual([
			"guide",
			"internal",
		]);
		expect(first!.alerts).toHaveLength(2);
		expect(first!.alerts.map((alert) => alert.workItemId)).toEqual([
			item.id,
			item.id,
		]);
		expect(second!.alerts).toEqual(first!.alerts);
		expect(mocks.comment).toHaveBeenCalledTimes(1);
		await checkSiteVersions(
			input(false, {
				"@cloudflare/nimbus-docs": "99.1.0",
				"@cloudflare/create-nimbus-docs": "99.1.0",
			}),
		);
		expect(mocks.comment).toHaveBeenCalledTimes(2);
	});

	it("updates configured upgrade Work instead of creating a duplicate", async () => {
		const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		mocks.projects.mockResolvedValue([
			{
				id: "project",
				orgId: "org",
				metadata: {
					siteVersionCheck: {
						enabled: true,
						upgradeWorkItems: { "cms:theme": id },
					},
				},
			},
		]);
		mocks.getItem.mockResolvedValue({ id, projectId: "project" });
		const [report] = await checkSiteVersions(input());
		expect(report!.alerts[0]!.workItemId).toBe(id);
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.comment).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				workItemId: id,
				body: expect.stringContaining(
					`Upgrade the example theme to EmDash ${runtimeEmdash}`,
				),
			}),
		);
	});

	it("does not substitute repository versions when an older active build has no package evidence", async () => {
		const [report] = await checkSiteVersions(input(true));
		expect(report!.alerts).toEqual([]);
		expect(report!.sites[0]!.errors).toEqual([
			"Active theme build versions are unavailable",
		]);
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("never reads alerts for an ordinary user and scopes admin reads to their organization", async () => {
		const params = input();
		expect(await siteVersionAlerts(params.db, "other-org", false)).toEqual([]);
		expect(mocks.projects).not.toHaveBeenCalled();
		await siteVersionAlerts(params.db, "other-org", true);
		expect(mocks.projects).toHaveBeenCalledWith(params.db, "other-org");
	});
});
