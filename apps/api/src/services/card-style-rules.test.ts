import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/context";

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	listRules: vi.fn(),
	getRule: vi.fn(),
	reviewRule: vi.fn(),
	getSavedProposal: vi.fn(),
	listRevisions: vi.fn(),
	getRevision: vi.fn(),
	latestChange: vi.fn(),
	changeHasRevision: vi.fn(),
	recordInteraction: vi.fn(),
	getProposal: vi.fn(),
	propose: vi.fn(),
	updateProposal: vi.fn(),
	insertLesson: vi.fn(),
	config: vi.fn(),
	distill: vi.fn(),
}));
vi.mock("./card-revisions", () => ({ cardRevisionAccess: mocks.access }));
vi.mock("@tedix/db/queries/work-items/card-style-rules", () => ({
	listPersonalCardStyleRules: mocks.listRules,
	getPersonalCardStyleRule: mocks.getRule,
	reviewPersonalCardStyleRule: mocks.reviewRule,
	getPersonalCardStyleProposal: mocks.getSavedProposal,
}));
vi.mock("@tedix/db/queries/work-items/card-revisions", () => ({
	listCardRevisions: mocks.listRevisions,
	getCardRevision: mocks.getRevision,
	latestCardChangeRequest: mocks.latestChange,
	cardChangeHasRevision: mocks.changeHasRevision,
}));
vi.mock("@tedix/db/queries/learning-feedback", () => ({
	recordLearningInteraction: mocks.recordInteraction,
	getLearningImprovementProposal: mocks.getProposal,
	proposeLearningImprovement: mocks.propose,
	updateLearningImprovementProposal: mocks.updateProposal,
}));
vi.mock("@tedix/db/queries/memory-graph/session-feedback", () => ({
	insertSessionFeedbackLesson: mocks.insertLesson,
}));
vi.mock("@tedix/db/queries/decision-learning", () => ({
	getDecisionLearningConfig: mocks.config,
}));
vi.mock("./lesson-distiller", () => ({ runDistillModel: mocks.distill }));

import {
	readCardStyleRules,
	rememberCardStyle,
	reviewCardStyleRule,
} from "./card-style-rules";

const ORG = "org-fictional";
const OWNER = "subject-ada";
const REQUEST = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
const PROPOSAL = "proposal-1";

function context(sub = OWNER) {
	return {
		db: {},
		env: {},
		authType: "user",
		user: { sub },
	} as unknown as BaseContext;
}
const recipientAccess = { orgId: ORG, recipient: true };

function ruleRow(overrides: Record<string, unknown> = {}) {
	return {
		id: EVENT,
		content: "For all email drafts: Prefer short sentences.",
		archivedAt: null,
		metadata: {
			cardStyle: {
				version: 1,
				contentKind: "email",
				requestId: REQUEST,
				revision: 2,
				proposalId: PROPOSAL,
			},
		},
		...overrides,
	};
}
const remember = {
	requestId: REQUEST,
	expectedRevision: 2,
	contentKind: "email" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.access.mockResolvedValue(recipientAccess);
	mocks.listRevisions.mockResolvedValue([
		{ revision: 1, body: "Hello, here is a long draft." },
		{ revision: 2, body: "Short draft.", instruction: "Make it shorter" },
	]);
	mocks.latestChange.mockResolvedValue(null);
	mocks.getRevision.mockResolvedValue({
		revision: 1,
		body: "Hello, here is a long draft.",
	});
	mocks.recordInteraction.mockResolvedValue({ event: { id: EVENT } });
	mocks.getRule.mockResolvedValue(null);
	mocks.getSavedProposal.mockResolvedValue(null);
	mocks.config.mockResolvedValue({
		preferenceModel: "fictional-model",
		classifierTimeoutMs: 1000,
	});
	mocks.distill.mockResolvedValue("Prefer short sentences.");
	mocks.propose.mockResolvedValue({
		proposal: { id: PROPOSAL, status: "proposed", updatedAt: "t0" },
	});
	mocks.updateProposal.mockResolvedValue({ id: PROPOSAL });
	mocks.insertLesson.mockImplementation(async (_db, row) => ({
		...ruleRow(),
		content: row.content,
		metadata: row.metadata,
	}));
});

describe("rememberCardStyle", () => {
	it("creates one proposal, activates it and stores the owner's private rule", async () => {
		const rule = await rememberCardStyle(context(), remember);
		expect(rule).toMatchObject({
			id: EVENT,
			contentKind: "email",
			proposalId: PROPOSAL,
			status: "active",
		});
		expect(mocks.propose).toHaveBeenCalledTimes(1);
		expect(mocks.propose.mock.calls[0]![1]).toMatchObject({
			organizationId: ORG,
			scopeKind: "personal",
			scopeId: OWNER,
			subjectKind: "directive",
			subjectId: EVENT,
		});
		expect(mocks.updateProposal.mock.calls[0]![1]).toMatchObject({
			id: PROPOSAL,
			status: "approved_for_handoff",
			fromStatuses: ["proposed"],
		});
		expect(mocks.insertLesson.mock.calls[0]![1]).toMatchObject({
			id: EVENT,
			visibility: "private",
			reviewStatus: "confirmed",
			metadata: { learningFeed: { ownerUserId: OWNER } },
		});
	});

	it("returns an already stored rule without proposing or writing again", async () => {
		mocks.getRule.mockResolvedValue(ruleRow());
		const rule = await rememberCardStyle(context(), remember);
		expect(rule.id).toBe(EVENT);
		expect(mocks.propose).not.toHaveBeenCalled();
		expect(mocks.distill).not.toHaveBeenCalled();
		expect(mocks.insertLesson).not.toHaveBeenCalled();
	});

	it("reuses a saved proposal instead of duplicating it", async () => {
		mocks.getSavedProposal.mockResolvedValue({
			id: PROPOSAL,
			status: "approved_for_handoff",
			recommendation: "For all email drafts: Prefer saved wording.",
			updatedAt: "t1",
		});
		const rule = await rememberCardStyle(context(), remember);
		expect(rule.text).toBe("For all email drafts: Prefer saved wording.");
		expect(mocks.propose).not.toHaveBeenCalled();
		expect(mocks.distill).not.toHaveBeenCalled();
		expect(mocks.updateProposal).not.toHaveBeenCalled();
	});

	it("refuses a person who is not the card's recipient", async () => {
		mocks.access.mockResolvedValue({ orgId: ORG, recipient: false });
		await expect(rememberCardStyle(context(), remember)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(mocks.recordInteraction).not.toHaveBeenCalled();
	});
});

describe("readCardStyleRules", () => {
	it("reads the requesting owner's accepted rules", async () => {
		mocks.listRules.mockResolvedValue([ruleRow()]);
		const rules = await readCardStyleRules(context(), recipientAccess as never);
		expect(rules).toEqual([
			expect.objectContaining({ id: EVENT, status: "active" }),
		]);
		expect(mocks.listRules).toHaveBeenCalledWith({}, ORG, OWNER);
	});

	it("returns nothing to someone who is not the recipient", async () => {
		const rules = await readCardStyleRules(context(), {
			orgId: ORG,
			recipient: false,
		} as never);
		expect(rules).toEqual([]);
		expect(mocks.listRules).not.toHaveBeenCalled();
	});
});

describe("reviewCardStyleRule", () => {
	it("refuses a rule owned by someone else", async () => {
		mocks.reviewRule.mockResolvedValue(null);
		await expect(
			reviewCardStyleRule(context("subject-grace"), {
				requestId: REQUEST,
				ruleId: EVENT,
				decision: "keep",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.reviewRule).toHaveBeenCalledWith(
			{},
			ORG,
			"subject-grace",
			EVENT,
			true,
		);
		expect(mocks.recordInteraction).not.toHaveBeenCalled();
	});

	it("rejects the owner's rule and its personal proposal", async () => {
		mocks.reviewRule.mockResolvedValue(
			ruleRow({ archivedAt: "2026-10-02T00:00:00.000Z" }),
		);
		mocks.getProposal.mockResolvedValue({
			id: PROPOSAL,
			scopeKind: "personal",
			scopeId: OWNER,
			subjectKind: "directive",
			subjectId: EVENT,
			status: "approved_for_handoff",
			updatedAt: "t2",
		});
		const rule = await reviewCardStyleRule(context(), {
			requestId: REQUEST,
			ruleId: EVENT,
			decision: "not_true",
		});
		expect(rule.status).toBe("rejected");
		expect(mocks.updateProposal.mock.calls[0]![1]).toMatchObject({
			id: PROPOSAL,
			status: "rejected",
			reviewedById: OWNER,
		});
		expect(mocks.recordInteraction.mock.calls[0]![1]).toMatchObject({
			eventKind: "rejected",
			actorId: OWNER,
		});
	});
});
