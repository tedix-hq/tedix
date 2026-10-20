import { beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	list: vi.fn(),
	claim: vi.fn(),
	notice: vi.fn(),
	wake: vi.fn(),
	purge: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/projects", () => ({
	getProjectById: mocks.project,
}));
vi.mock("@tedix/db/queries/work-items/agent-review-intake", () => ({
	purgeExpiredAgentReviews: mocks.purge,
}));
vi.mock("@tedix/db/queries/work-items/agent-review-triage", () => ({
	listAgentReviewsForTriage: mocks.list,
	claimAgentReviewRetry: mocks.claim,
	recordAgentReviewTriageNotice: mocks.notice,
}));
vi.mock("../services/agent-review", () => ({ wakeAgentReview: mocks.wake }));
import { sweepAgentReviewTriage } from "./agent-review-triage";
const now = Date.parse("2026-10-20T12:00:00Z");
const env = { AGENT_REVIEW_PROJECT_ID: "reviews" } as CloudflareEnv;
const project = {
	id: "reviews",
	orgId: "fictional-org",
	status: "active",
	leadTediId: "triager",
	objectiveId: "objective",
	metadata: {
		agentReviewEnabled: true,
		agentReviewTriage: { enabled: true, tediId: "triager" },
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.project.mockResolvedValue(project);
	mocks.list.mockResolvedValue([]);
	mocks.claim.mockResolvedValue(true);
	mocks.purge.mockResolvedValue(0);
});
it("disabled triage returns before querying reviews or waking the CTO while retention remains scheduled", async () => {
	mocks.project.mockResolvedValue({
		...project,
		leadTediId: "cto",
		metadata: { ...project.metadata, agentReviewTriage: { enabled: false } },
	});
	await sweepAgentReviewTriage(env, now);
	expect(mocks.list).not.toHaveBeenCalled();
	expect(mocks.wake).not.toHaveBeenCalled();
	expect(mocks.purge).toHaveBeenCalledOnce();
});
it("fails closed unless a dedicated triager is explicitly configured", async () => {
	mocks.project.mockResolvedValue({
		...project,
		metadata: { agentReviewEnabled: true },
	});
	await sweepAgentReviewTriage(env, now);
	expect(mocks.wake).not.toHaveBeenCalled();
	expect(mocks.list).not.toHaveBeenCalled();
});
it("bounds recovery to two per tick, one retry and seven days", async () => {
	mocks.list.mockResolvedValue(
		Array.from({ length: 50 }, (_, i) => ({ id: `review-${i}`, retries: 0 })),
	);
	await sweepAgentReviewTriage(env, now);
	expect(mocks.wake).toHaveBeenCalledTimes(2);
	expect(mocks.list).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			maxRetries: 1,
			limit: 2,
			recentAfter: "2026-10-13T12:00:00.000Z",
		}),
	);
	expect(mocks.notice).toHaveBeenCalledExactlyOnceWith(
		{},
		expect.objectContaining({ state: "digest", projectId: "reviews" }),
	);
	expect(mocks.purge).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ before: "2026-07-22T12:00:00.000Z" }),
	);
});
it("does not dispatch when another tick already claimed the attempt", async () => {
	mocks.list.mockResolvedValue([{ id: "review", retries: 1 }]);
	mocks.claim.mockResolvedValue(false);
	await sweepAgentReviewTriage(env, now);
	expect(mocks.wake).not.toHaveBeenCalled();
});
