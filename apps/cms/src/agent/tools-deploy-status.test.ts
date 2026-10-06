import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	handlers: new Map<
		string,
		(args: { jobId: string }) => Promise<{
			structuredContent: Record<string, unknown>;
			isError?: true;
		}>
	>(),
	authority: vi.fn(),
	getDeployStatus: vi.fn(),
}));
vi.mock("@tedix/mcp-shared/server", () => ({
	createMcpServer: () => ({
		registerTool: (name: string, _config: unknown, handler: never) =>
			mocks.handlers.set(name, handler),
	}),
}));
vi.mock("./storage", async (original) => ({
	...(await original<object>()),
	getCmsHumanSiteAuthority: mocks.authority,
}));
import {
	buildSiteBuilderMcpServer,
	type SiteBuilderToolContext,
} from "./tools";

const db = { prepare: vi.fn() } as unknown as D1Database;
const ACTIVE = "a".repeat(64);
const PREVIOUS = "b".repeat(64);

function setup() {
	buildSiteBuilderMcpServer({
		orgSlug: "acme",
		templateSlug: "tedix",
		db,
		storage: {},
		sandbox: {},
		getDeployStatus: mocks.getDeployStatus,
	} as unknown as SiteBuilderToolContext);
	return (jobId = "job-1") =>
		mocks.handlers.get("theme_deploy_status")!({ jobId });
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.handlers.clear();
	mocks.getDeployStatus.mockResolvedValue({
		jobId: "job-1",
		status: "complete",
		output: { version: 73, url: "https://acme.cms.tedix.dev" },
	});
});

describe("theme_deploy_status humanAuthority", () => {
	it("reports active when the marker matches the active bundle etag", async () => {
		mocks.authority.mockResolvedValue({
			siteId: "site",
			tenantId: "tenant",
			activeBundleEtag: ACTIVE,
			humanAssertionBundleEtag: ACTIVE,
		});
		const result = await setup()();
		expect(mocks.authority).toHaveBeenCalledWith(db, "acme");
		expect(result.structuredContent).toMatchObject({
			status: "complete",
			output: { version: 73 },
			humanAuthority: {
				state: "active",
				markerEtag: ACTIVE,
				activeEtag: ACTIVE,
			},
		});
		expect(
			(result.structuredContent.humanAuthority as { hint?: string }).hint,
		).toBeUndefined();
	});

	it("reports stale with a re-activation hint after a deploy moved the active bundle", async () => {
		mocks.authority.mockResolvedValue({
			siteId: "site",
			tenantId: "tenant",
			activeBundleEtag: ACTIVE,
			humanAssertionBundleEtag: PREVIOUS,
		});
		const result = await setup()();
		expect(result.structuredContent.humanAuthority).toEqual({
			state: "stale",
			markerEtag: PREVIOUS,
			activeEtag: ACTIVE,
			hint: expect.stringMatching(
				/get_human_auth_activation, then set_human_auth_activation/,
			),
		});
	});

	it("reports none when no marker is set", async () => {
		mocks.authority.mockResolvedValue({
			siteId: "site",
			tenantId: "tenant",
			activeBundleEtag: ACTIVE,
			humanAssertionBundleEtag: null,
		});
		const result = await setup()();
		expect(result.structuredContent.humanAuthority).toEqual({
			state: "none",
			markerEtag: null,
			activeEtag: ACTIVE,
			hint: expect.stringMatching(/set_human_auth_activation/),
		});
	});

	it("reports none without etags when the site has no single active bundle", async () => {
		mocks.authority.mockResolvedValue(null);
		const result = await setup()();
		expect(result.structuredContent.humanAuthority).toMatchObject({
			state: "none",
			markerEtag: null,
			activeEtag: null,
		});
	});

	it("still reports the currently active bundle while the job is running", async () => {
		mocks.getDeployStatus.mockResolvedValue({
			jobId: "job-1",
			status: "running",
			phase: "build-and-snapshot",
		});
		mocks.authority.mockResolvedValue({
			siteId: "site",
			tenantId: "tenant",
			activeBundleEtag: ACTIVE,
			humanAssertionBundleEtag: ACTIVE,
		});
		const result = await setup()();
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			status: "running",
			humanAuthority: { state: "active", activeEtag: ACTIVE },
		});
	});
});
