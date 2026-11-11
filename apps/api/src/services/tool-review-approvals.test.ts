import { beforeEach, expect, it, vi } from "vite-plus/test";

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
