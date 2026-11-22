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
	themePackageVersions,
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
const lock = `{
  "workspaces": { "": { "dependencies": { "emdash": "^1.0.0" } } },
  "packages": {
    // "fake": ["emdash@0.0.1"],
    "emdash": ["emdash@1.4.0", "", {}, "sha512-test"],
    "nested/emdash": ["emdash@1.5.0", "", {}, "sha512-test"],
    "forms": ["@emdash-cms/plugin-forms@0.2.12", "", {}, "sha512-test"],
  },
}`;

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
	const items = new Map<string, { id: string }>();
	mocks.byIntent.mockImplementation(
		async (_db, { sourceIntentId }) => items.get(sourceIntentId) ?? null,
	);
	mocks.create.mockImplementation(async (_db, item) =>
		items.set(item.sourceIntentId, { id: item.id }),
	);
});

function input(failTheme = false) {
	const readFile = vi.fn(async () => {
		if (failTheme) throw new Error("unavailable");
		return new Blob([lock]);
	});
	const fetcher = vi.fn(async (url: string) => {
		if (url.endsWith("/package.json")) return new Response(manifest);
		if (url.endsWith("/apps/docs/Dockerfile")) return new Response(dockerfile);
		const name = decodeURIComponent(
			url.split("registry.npmjs.org/")[1]!.replace(/\/latest$/, ""),
		);
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
			ARTIFACTS: {
				get: async () => ({
					log: async ({ ref }: { ref: string }) =>
						ref === "main" ? [{ hash: "b".repeat(40) }] : [],
					readFile,
					[Symbol.dispose]() {},
				}),
			},
		} as unknown as CloudflareEnv,
	};
}

describe("site version check", () => {
	it("uses resolved JSONC lock tuples and compares versions numerically without downgrading", () => {
		expect(themePackageVersions(lock)).toEqual({
			emdash: ["1.4.0", "1.5.0"],
			"@emdash-cms/plugin-forms": ["0.2.12"],
		});
		expect(() => themePackageVersions('{"packages":')).toThrow();
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
				message: "1 site is behind EmDash 1.5.0",
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

	it("updates configured upgrade Work instead of creating a duplicate", async () => {
		const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		mocks.projects.mockResolvedValue([
			{
				id: "project",
				orgId: "org",
				metadata: {
					siteVersionCheck: { enabled: true, upgradeWorkItems: { emdash: id } },
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
				body: expect.stringContaining("Upgrade emdash to 1.5.0"),
			}),
		);
	});

	it("does not report a failed theme read as current or invent an upgrade", async () => {
		const [report] = await checkSiteVersions(input(true));
		expect(report!.alerts).toEqual([]);
		expect(report!.sites[0]!.errors).toEqual([
			"Theme bun.lock could not be checked",
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
