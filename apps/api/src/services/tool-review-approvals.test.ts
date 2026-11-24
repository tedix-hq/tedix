import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { verifyFirstPartyToolRelease } from "./first-party-tool-release";

const mocks = vi.hoisted(() => ({
	anchor: vi.fn(),
	reconcile: vi.fn(),
	supersede: vi.fn(),
	pending: vi.fn(),
}));
vi.mock("@tedix/db/queries/approvals", () => ({
	getApprovalAnchor: mocks.anchor,
	reconcileToolReviewApproval: mocks.reconcile,
	supersedeToolReviewApprovals: mocks.supersede,
}));
vi.mock("@tedix/db/queries/tools", () => ({
	listPendingToolReviewsForApp: mocks.pending,
}));
import { ensurePendingToolReviewApprovals } from "./tool-review-approvals";

beforeEach(() => {
	vi.resetAllMocks();
	mocks.anchor.mockResolvedValue({ id: "home-tedi" });
	mocks.reconcile.mockResolvedValue([{ id: "current-review" }]);
});
const input = { organizationId: "org", appId: "app", appName: "Upstream" };
it("reconciles all pending batches into one current review with a 30-day expiry", async () => {
	mocks.pending.mockResolvedValue([
		{ reviewBatchId: "old" },
		{ reviewBatchId: "new" },
	]);
	expect(await ensurePendingToolReviewApprovals({} as never, input)).toEqual([
		{ id: "current-review" },
	]);
	expect(mocks.reconcile).toHaveBeenCalledTimes(1);
	const args = mocks.reconcile.mock.calls[0]![1];
	expect(args).toMatchObject({ ...input, tediId: "home-tedi" });
	expect(Date.parse(args.expiresAt) - Date.parse(args.createdAt)).toBe(
		30 * 24 * 60 * 60 * 1000,
	);
});
it("supersedes obsolete cards when no tools remain pending", async () => {
	mocks.pending.mockResolvedValue([]);
	expect(await ensurePendingToolReviewApprovals({} as never, input)).toEqual(
		[],
	);
	expect(mocks.supersede).toHaveBeenCalledWith({}, input);
	expect(mocks.reconcile).not.toHaveBeenCalled();
});

afterEach(() => vi.unstubAllGlobals());
it("requires a fixed host, platform token and a deployed main ancestor before bypassing review", async () => {
	const sha = "a".repeat(40);
	const health = vi.fn(async (_request: Request) =>
		Response.json({ deployedSha: sha }),
	);
	const github = vi.fn(async () =>
		Response.json({ status: "ahead", merge_base_commit: { sha } }),
	);
	vi.stubGlobal("fetch", github);
	const env = {
		CMS: { fetch: health },
		PLATFORM_SERVICE_TOKEN: "platform-token",
	};
	const endpoint = "https://builder.tedix.dev/mcp";
	expect(await verifyFirstPartyToolRelease(endpoint, env)).toEqual({
		mcpServerUrl: endpoint,
		deployedSha: sha,
	});
	const request = health.mock.calls[0]?.[0] as Request | undefined;
	expect(request?.headers.get("Authorization")).toBe("Bearer platform-token");
	github.mockResolvedValueOnce(
		Response.json({
			status: "diverged",
			merge_base_commit: { sha: "b".repeat(40) },
		}),
	);
	expect(await verifyFirstPartyToolRelease(endpoint, env)).toBeUndefined();
	health.mockClear();
	github.mockClear();
	expect(
		await verifyFirstPartyToolRelease("https://upstream.example/mcp", env),
	).toBeUndefined();
	expect(
		await verifyFirstPartyToolRelease(endpoint, {
			...env,
			PLATFORM_SERVICE_TOKEN: undefined,
		}),
	).toBeUndefined();
	expect(health).not.toHaveBeenCalled();
	expect(github).not.toHaveBeenCalled();
});
