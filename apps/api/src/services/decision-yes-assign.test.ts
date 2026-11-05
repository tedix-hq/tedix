import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";

const mocks = vi.hoisted(() => ({
	call: vi.fn(),
	comment: vi.fn(),
	existing: vi.fn(),
	work: vi.fn(),
	steward: vi.fn(),
	tedis: vi.fn(),
	home: vi.fn(),
	delegate: vi.fn(),
}));
vi.mock("@orpc/server", () => ({ call: mocks.call }));
vi.mock("@tedix/db/queries/work-items/comments", () => ({
	addWorkItemCommentIfAbsent: mocks.comment,
	getWorkItemCommentById: mocks.existing,
}));
vi.mock("@tedix/db/queries/work-items/crud", () => ({
	getWorkItemById: mocks.work,
}));
vi.mock("@tedix/db/queries/work-items/stewardship", () => ({
	resolveWorkItemSteward: mocks.steward,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTedisByOrganization: mocks.tedis,
}));
vi.mock("../rpc/routers/work-items", () => ({
	workItemsContractRouter: { updateSpecification: "updateSpecification" },
}));
vi.mock("../rpc/routers/work-items/proposal-start", () => ({
	proposalTedi: mocks.home,
	proposalStartActions: () => ({ delegate: mocks.delegate }),
}));

import { assignAgentOnYes, yesAssignCommentId } from "./decision-yes-assign";

const orgId = "11111111-1111-4111-8111-111111111111";
const workItemId = "44444444-4444-4444-8444-444444444444";
const context = { db: {} } as unknown as BaseContext;
const accepted = {
	id: workItemId,
	orgId,
	version: 3,
	title: "Keep rarely used recovery tools",
	description: "Document current callers before proposing retirement.",
	disposition: "accepted",
	workKind: "other",
	riskLevel: "low",
	projectId: "33333333-3333-4333-8333-333333333333",
	stewardType: null,
	stewardId: null,
	metadata: {},
	acceptanceContract: { version: 1, doneLooksLike: "A short recommendation." },
};
const assign = () =>
	assignAgentOnYes(context, { orgId, workItemId, personId: "user-1" });
const spec = () =>
	mocks.call.mock.calls.find(
		([procedure]) => procedure === "updateSpecification",
	)?.[1];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.existing.mockResolvedValue(null);
	mocks.work.mockResolvedValue(accepted);
	mocks.steward.mockResolvedValue({});
	mocks.tedis.mockResolvedValue([
		{ id: "lead-tedi", name: "lead", displayName: "Lead", status: "active" },
		{ id: "paused", name: "paused", displayName: null, status: "paused" },
	]);
	mocks.home.mockResolvedValue({ id: "home-tedi", name: "Home" });
	mocks.delegate.mockResolvedValue({ runId: "run-1", status: "queued" });
	mocks.call.mockResolvedValue({});
	mocks.comment.mockResolvedValue({ inserted: true });
});

describe("assignAgentOnYes", () => {
	it("sends coding Work to the default local coding lane, ready to dispatch", async () => {
		mocks.work.mockResolvedValue({ ...accepted, workKind: "coding" });
		expect(await assign()).toEqual({ executor: "codex" });
		expect(spec()).toEqual({
			id: workItemId,
			expectedWorkItemVersion: 3,
			executor: "codex",
			laneDispatch: { state: "ready" },
		});
		expect(mocks.delegate).not.toHaveBeenCalled();
		expect(mocks.comment.mock.calls[0]?.[1]).toMatchObject({
			id: yesAssignCommentId(workItemId),
			authorId: "user-1",
			metadata: { outcome: "assigned", executor: "codex" },
		});
	});

	it("hands non-coding Work to its steward tedi and asks it to start", async () => {
		mocks.work.mockResolvedValue({
			...accepted,
			stewardType: "tedi",
			stewardId: "lead-tedi",
		});
		expect(await assign()).toEqual({ executor: "tedi", tediId: "lead-tedi" });
		expect(spec()).toEqual({
			id: workItemId,
			expectedWorkItemVersion: 3,
			executor: "tedi",
			laneDispatch: { state: "ready" },
		});
		expect(mocks.delegate.mock.calls[0]?.[1]).toMatchObject({
			tediId: "lead-tedi",
			workItemId,
			idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
	});

	it("falls back to the stewardship policy, then Home, and records the steward", async () => {
		mocks.steward.mockResolvedValueOnce({
			stewardType: "tedi",
			stewardId: "paused",
		});
		expect(await assign()).toEqual({ executor: "tedi", tediId: "home-tedi" });
		expect(spec()).toMatchObject({
			stewardType: "tedi",
			stewardId: "home-tedi",
		});
	});

	it.each([
		[
			{ metadata: { executor: "claude-code" } },
			"already has an executor (claude-code)",
		],
		[{ riskLevel: "high" }, "high-risk"],
		[{ description: "Send the payment to the vendor." }, "may need a person"],
	])("leaves Work alone and says why: %j", async (change, reason) => {
		mocks.work.mockResolvedValue({ ...accepted, ...change });
		const result = await assign();
		expect(result).toEqual({ skipped: expect.stringContaining(reason) });
		expect(mocks.call).not.toHaveBeenCalled();
		expect(mocks.comment.mock.calls[0]?.[1]).toMatchObject({
			body: expect.stringContaining(reason),
			metadata: { outcome: "skipped" },
		});
	});

	it("assigns once per Work and never throws", async () => {
		mocks.existing.mockResolvedValueOnce({
			id: yesAssignCommentId(workItemId),
		});
		expect(await assign()).toBeNull();
		expect(mocks.call).not.toHaveBeenCalled();
		mocks.call.mockRejectedValueOnce(new Error("Work changed"));
		expect(await assign()).toBeNull();
		expect(mocks.comment).not.toHaveBeenCalled();
	});
});
