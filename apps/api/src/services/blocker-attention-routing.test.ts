import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import { blockerAttentionRouting } from "./blocker-attention-routing";
const mocks = vi.hoisted(() => ({
	work: vi.fn(),
	blockers: vi.fn(),
	attempts: vi.fn(),
	delegate: vi.fn(),
}));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	listWorkItemAttempts: mocks.attempts,
}));
vi.mock("@tedix/db/queries/work-items/delegated-approvals", () => ({
	preferredVerificationDelegate: mocks.delegate,
}));
vi.mock("@tedix/db/queries/work-items/crud", () => ({
	getWorkItemById: mocks.work,
}));
vi.mock("@tedix/db/queries/work-items/relations", () => ({
	queryWorkItemBlockers: mocks.blockers,
}));
const context = { db: {} } as BaseContext;
const actor = { type: "tedi" as const, id: "worker" };
const input = {
	kind: "question",
	subject: "Inspect the lane?",
	prompt: "Check the last Attempt before retrying.",
	workItemId: "work",
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.work.mockResolvedValue({
		id: "work",
		stewardType: "tedi",
		stewardId: "steward",
	});
	mocks.blockers.mockResolvedValue([]);
});
it.each([
	"Clean up the tests?",
	"Retry failed checks?",
	"Inspect the lane?",
	"File the backlog?",
	"Triage Unfiled?",
	"Triage dropped-risk?",
	"Tool discovery?",
])(
	"returns routine repair to a recorded machine owner: %s",
	async (subject) => {
		expect(
			await blockerAttentionRouting(context, "org", actor, {
				...input,
				subject,
			}),
		).toMatchObject({
			target: { type: "tedi", id: "steward" },
			evidenceRef: "/work/items/work",
		});
		expect(mocks.work).toHaveBeenCalledWith(context.db, "work", "org");
	},
);
it("uses the actual nonterminal dependency owner, never a suggested unrelated owner", async () => {
	mocks.blockers.mockResolvedValue([
		{ id: "dependency", disposition: "accepted" },
	]);
	mocks.work.mockResolvedValueOnce({ id: "work" }).mockResolvedValueOnce({
		id: "dependency",
		accountableOwnerType: "tedi",
		accountableOwnerId: "repair-owner",
	});
	expect(
		await blockerAttentionRouting(context, "org", actor, {
			...input,
			metadata: { blockerWorkItemId: "dependency", suggestedOwnerId: "person" },
		}),
	).toMatchObject({
		target: { type: "tedi", id: "repair-owner" },
		evidenceRef: "/work/items/dependency",
	});
});
it.each([
	{ blockers: [] },
	{ blockers: [{ id: "dependency", disposition: "completed" }] },
])("rejects an invented or resolved dependency: %j", async ({ blockers }) => {
	mocks.blockers.mockResolvedValue(blockers);
	expect(
		await blockerAttentionRouting(context, "org", actor, {
			...input,
			metadata: { blockerWorkItemId: "dependency" },
		}),
	).toBeNull();
});
it("returns ownerless repair to the authenticated machine without granting authority", async () => {
	mocks.work.mockResolvedValue({
		id: "work",
		stewardType: "user",
		stewardId: "person",
	});
	expect(
		await blockerAttentionRouting(context, "org", actor, input),
	).toMatchObject({ target: actor });
});
it("does not route a foreign Work or a human-authored ask", async () => {
	mocks.work.mockResolvedValue(null);
	expect(
		await blockerAttentionRouting(context, "foreign", actor, input),
	).toBeNull();
	expect(
		await blockerAttentionRouting(
			context,
			"org",
			{ type: "user", id: "person" },
			input,
		),
	).toBeNull();
});
it.each([
	"Provide credentials",
	"Complete sign-in and consent",
	"Pay the invoice",
	"Send the customer an email",
	"Choose the business strategy",
])(
	"keeps a reserved blocker human even when the subject is routine: %s",
	async (prompt) => {
		expect(
			await blockerAttentionRouting(context, "org", actor, {
				...input,
				prompt,
			}),
		).toBeNull();
		expect(mocks.work).not.toHaveBeenCalled();
	},
);
it.each([
	{ protectedEffects: ["consent"] },
	{ protectedEffects: "malformed" },
	{ approvalOperation: "pay" },
	{ decisionDeck: {} },
	{ riskLevel: "critical" },
	{ internalAction: { classId: "approval.consent", agentOwned: true } },
])(
	"a model declaration cannot waive reserved approval: %j",
	async (metadata) => {
		expect(
			await blockerAttentionRouting(context, "org", actor, {
				...input,
				metadata,
			}),
		).toBeNull();
	},
);

it.each([
	{ name: "no recorded verification", missing: true },
	{ name: "an ordinary runner", metadata: { verificationRound: undefined } },
	{ name: "a non-dispatcher Attempt", metadata: { lane: false } },
	{ name: "an older Work revision", metadata: { dispatchVersion: 1 } },
	{ name: "a cancelled verification", outcome: "cancelled" },
	{ name: "a running verification", runtimeState: "running" },
	{
		name: "a foreign result",
		metadata: { laneResult: { workItemId: "foreign" } },
	},
])(
	"keeps the user recipient with $name despite a verification label",
	async (invalid) => {
		mocks.work.mockResolvedValue({
			id: "work",
			title: "Check result",
			version: 3,
			disposition: "accepted",
			dispatchState: "held",
			executorId: "codex",
			accountableOwnerType: "user",
			accountableOwnerId: "owner",
		});
		mocks.attempts.mockResolvedValue({
			data: invalid.missing
				? []
				: [
						{
							runtimeState: invalid.runtimeState ?? "finished",
							outcome: invalid.outcome ?? "landed_unverified",
							metadata: {
								lane: true,
								dispatchVersion: 2,
								verificationRound: 1,
								laneResult: {
									outcome: "landed_unverified",
									workItemId: "work",
									workVersion: 2,
									outcomeText: "Check result",
								},
								...invalid.metadata,
							},
						},
					],
		});
		expect(
			await blockerAttentionRouting(
				context,
				"org",
				{ type: "user", id: "owner" },
				{
					...input,
					kind: "input",
					metadata: {
						source: "lane-dispatch-blocker",
						laneBlocker: {
							kind: "verification_check",
							executor: "codex",
							workVersion: 3,
						},
					},
				},
			),
		).toBeNull();
		expect(mocks.delegate).not.toHaveBeenCalled();
	},
);
