import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";

const mocks = vi.hoisted(() => ({
	call: vi.fn(),
	comment: vi.fn(),
	work: vi.fn(),
	bySource: vi.fn(),
	assign: vi.fn(),
}));
vi.mock("./decision-yes-assign", () => ({ assignAgentOnYes: mocks.assign }));
vi.mock("@orpc/server", () => ({ call: mocks.call }));
vi.mock("@tedix/db/queries/work-items/comments", () => ({
	addWorkItemCommentIfAbsent: mocks.comment,
}));
vi.mock("@tedix/db/queries/work-items/crud", () => ({
	getWorkItemById: mocks.work,
	getWorkItemBySourceIntentId: mocks.bySource,
}));
vi.mock("../rpc/routers/work-items/creation-reads", () => ({
	createProcedure: "create",
}));
vi.mock("../rpc/routers/work-items", () => ({
	workItemsContractRouter: { accept: "accept", cancel: "cancel" },
}));

import {
	answerDisposition,
	recordDecisionAnswerOnBoard,
	type BoardAnswer,
} from "./decision-answer-board";

const orgId = "11111111-1111-4111-8111-111111111111";
const projectId = "33333333-3333-4333-8333-333333333333";
const workId = "44444444-4444-4444-8444-444444444444";
const context = { db: {}, organizationId: orgId } as unknown as BaseContext;
const card = {
	id: "22222222-2222-4222-8222-222222222222",
	orgId,
	kind: "question",
	status: "resolved",
	subject: "11 · Keep rarely used recovery tools",
	prompt: "Keep recovery tools available.",
	workItemId: null,
	projectId,
	targetType: "user",
	targetId: "user-1",
	metadata: {},
} as unknown as Parameters<typeof recordDecisionAnswerOnBoard>[1]["request"];
const yes: BoardAnswer = {
	kind: "answer",
	responseId: "resp-1",
	responseKind: "answer",
	body: "Yes, prioritise this",
	choice: "approve",
	at: "2026-11-05T08:45:00.000Z",
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.work.mockResolvedValue({ id: workId });
	mocks.bySource.mockResolvedValue(null);
	mocks.comment.mockResolvedValue({ inserted: true });
	mocks.call.mockImplementation(async (procedure: string) =>
		procedure === "create" ? { id: workId, disposition: "proposed" } : {},
	);
});

describe("recordDecisionAnswerOnBoard", () => {
	it("records a not-useful answer on the card's Work, attributed to the person", async () => {
		const result = await recordDecisionAnswerOnBoard(context, {
			orgId,
			request: { ...card, workItemId: workId, status: "cancelled" },
			answer: {
				kind: "not_useful",
				reason: "already_decided",
				at: "2026-11-05T08:44:00.000Z",
			},
		});
		expect(result).toEqual({ workItemId: workId, created: false });
		expect(mocks.call).not.toHaveBeenCalled();
		expect(mocks.comment.mock.calls[0]?.[1]).toMatchObject({
			id: `decision-answer:${card.id}:not-useful`,
			workItemId: workId,
			authorType: "user",
			authorId: "user-1",
			recordActivity: true,
			body: expect.stringContaining("not needed (already decided)"),
			metadata: {
				schema: "tedix.decision-answer.v1",
				decision: "not_useful",
				reason: "already_decided",
			},
		});
	});

	it("creates accepted Work in the card's project for an explicit yes", async () => {
		const result = await recordDecisionAnswerOnBoard(context, {
			orgId,
			request: card,
			answer: yes,
		});
		expect(result).toEqual({ workItemId: workId, created: true });
		const [, input] = mocks.call.mock.calls[0]!;
		expect(input).toMatchObject({
			title: card.subject,
			projectId,
			sourceIntentId: `decision-card:${card.id}`,
			description: expect.stringContaining("Yes, prioritise this"),
		});
		expect(input).not.toHaveProperty("workClass");
		expect(mocks.call.mock.calls[1]?.[0]).toBe("accept");
		expect(mocks.assign).toHaveBeenCalledWith(context, {
			orgId,
			workItemId: workId,
			personId: "user-1",
		});
		expect(mocks.comment.mock.calls[0]?.[1]).toMatchObject({
			id: `decision-answer:${card.id}:resp-1`,
			workItemId: workId,
		});
	});

	it("accepts a still-proposed linked Work on a yes, carrying the person's typed words", async () => {
		mocks.work.mockResolvedValue({ id: workId, disposition: "proposed" });
		const instruction =
			"Draft an email in my Gmail to the right contacts so I can approve.";
		await recordDecisionAnswerOnBoard(context, {
			orgId,
			request: { ...card, workItemId: workId },
			answer: { ...yes, instruction },
		});
		expect(mocks.call).not.toHaveBeenCalled();
		const deckCard = {
			...card,
			workItemId: workId,
			metadata: { decisionDeck: { kind: "decision" } },
		} as typeof card;
		await recordDecisionAnswerOnBoard(context, {
			orgId,
			request: deckCard,
			answer: { ...yes, responseId: "resp-2", instruction },
		});
		expect(mocks.comment.mock.calls[0]?.[1].body).toContain(
			`What to do next, in their words: ${instruction}`,
		);
		expect(mocks.call).toHaveBeenCalledTimes(1);
		expect(mocks.call.mock.calls[0]).toEqual([
			"accept",
			{
				id: workId,
				acceptanceContract: {
					version: 1,
					doneLooksLike: expect.stringContaining(instruction),
				},
			},
			{ context },
		]);
	});

	it("leaves accepted or declined linked Work alone", async () => {
		mocks.work.mockResolvedValue({ id: workId, disposition: "accepted" });
		await recordDecisionAnswerOnBoard(context, {
			orgId,
			request: { ...card, workItemId: workId },
			answer: yes,
		});
		mocks.work.mockResolvedValue({ id: workId, disposition: "proposed" });
		await recordDecisionAnswerOnBoard(context, {
			orgId,
			request: {
				...card,
				workItemId: workId,
				metadata: { decisionDeck: { kind: "decision" } },
			} as typeof card,
			answer: { ...yes, choice: "reject" },
		});
		expect(mocks.call).not.toHaveBeenCalled();
	});

	it("links the Work already created from this card instead of duplicating it", async () => {
		mocks.bySource.mockResolvedValue({ id: workId, disposition: "accepted" });
		const result = await recordDecisionAnswerOnBoard(context, {
			orgId,
			request: card,
			answer: yes,
		});
		expect(result).toEqual({ workItemId: workId, created: false });
		expect(mocks.call).not.toHaveBeenCalled();
		expect(mocks.comment).toHaveBeenCalledTimes(1);
	});

	it("recovers the winner when a concurrent create loses the source-intent race", async () => {
		mocks.bySource
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ id: workId });
		mocks.call.mockRejectedValueOnce(new Error("UNIQUE constraint failed"));
		const result = await recordDecisionAnswerOnBoard(context, {
			orgId,
			request: card,
			answer: yes,
		});
		expect(result).toEqual({ workItemId: workId, created: false });
		expect(mocks.call).toHaveBeenCalledTimes(1);
	});

	it("cancels Work created for a not-needed answer and leaves other answers proposed", async () => {
		await recordDecisionAnswerOnBoard(context, {
			orgId,
			request: card,
			answer: { ...yes, choice: "reject", body: "Not needed" },
		});
		expect(mocks.call.mock.calls[1]?.[0]).toBe("cancel");
		expect(mocks.assign).not.toHaveBeenCalled();
		expect(answerDisposition({ ...yes, choice: "later" })).toBe("propose");
	});

	it("skips cards with nowhere to land, and never throws", async () => {
		expect(
			await recordDecisionAnswerOnBoard(context, {
				orgId,
				request: { ...card, projectId: null },
				answer: yes,
			}),
		).toBeNull();
		mocks.comment.mockRejectedValue(new Error("down"));
		expect(
			await recordDecisionAnswerOnBoard(context, {
				orgId,
				request: { ...card, workItemId: workId },
				answer: yes,
			}),
		).toBeNull();
	});
});
