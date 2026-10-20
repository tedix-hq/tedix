import { beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	list: vi.fn(),
	claim: vi.fn(),
	notice: vi.fn(),
	wake: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/projects", () => ({
	getProjectById: mocks.project,
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
		agentReviewTriage: { retryMinutes: 15, maxRetries: 2 },
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.project.mockResolvedValue(project);
	mocks.claim.mockResolvedValue(true);
	mocks.list.mockResolvedValue([]);
});
it("uses project recovery policy and skips missing or disabled intake", async () => {
	await sweepAgentReviewTriage(env, now);
	expect(mocks.list).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			maxRetries: 2,
			retryBefore: "2026-10-20T11:45:00.000Z",
		}),
	);
	mocks.project.mockResolvedValue({
		...project,
		metadata: { agentReviewEnabled: false },
	});
	await sweepAgentReviewTriage(env, now);
	expect(mocks.list).toHaveBeenCalledTimes(1);
});
it("records completion only for a saved result; late pending reviews get a notice and a fresh bounded wake", async () => {
	mocks.list.mockResolvedValue([
		{ id: "done", complete: true },
		{
			id: "stuck",
			complete: false,
			createdAt: "2026-10-20T09:00:00Z",
			retries: 0,
			lastRetry: null,
		},
		{
			id: "exhausted",
			complete: false,
			createdAt: "2026-10-20T08:00:00Z",
			retries: 2,
			lastRetry: "2026-10-20T10:00:00Z",
		},
		{
			id: "recent",
			complete: false,
			createdAt: "2026-10-20T09:00:00Z",
			retries: 1,
			lastRetry: "2026-10-20T11:50:00Z",
		},
	]);
	await sweepAgentReviewTriage(env, now);
	expect(mocks.notice).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ workItemId: "done", state: "completed" }),
	);
	expect(mocks.notice).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ workItemId: "stuck", state: "late" }),
	);
	expect(mocks.wake).toHaveBeenCalledExactlyOnceWith(
		{},
		env,
		project,
		expect.objectContaining({ id: "stuck" }),
		1,
	);
});
it("does not dispatch when another tick has claimed the same retry", async () => {
	mocks.list.mockResolvedValue([
		{
			id: "stuck",
			complete: false,
			createdAt: "2026-10-20T09:00:00Z",
			retries: 0,
			lastRetry: null,
		},
	]);
	mocks.claim.mockResolvedValue(false);
	await sweepAgentReviewTriage(env, now);
	expect(mocks.wake).not.toHaveBeenCalled();
});
