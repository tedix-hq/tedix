import { beforeEach, expect, it, vi } from "vite-plus/test";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
const mocks = vi.hoisted(() => ({
	config: vi.fn(),
	clef: vi.fn(),
	distill: vi.fn(),
	record: vi.fn(),
}));
vi.mock("@tedix/db/queries/decision-learning", () => ({
	getDecisionLearningConfig: mocks.config,
}));
vi.mock("@tedix/db/queries/learning-feedback", () => ({
	recordLearningInteraction: mocks.record,
}));
vi.mock("../lib/clef", () => ({ runClef: mocks.clef }));
vi.mock("./lesson-distiller", () => ({ runDistillModel: mocks.distill }));
import { classifyDecisionEdit } from "./decision-edit-preference";
import { decisionCaptureLearningSignal } from "./decision-learning-signal";
const event = {
	id: "edited-fictional",
	organizationId: "fictional-harbor",
	actorType: "user",
	actorId: "river",
	scopeKind: "personal",
	scopeId: "river",
	eventKind: "edited",
	occurredAt: "2026-06-10T10:00:00Z",
	metadata: {
		decisionClass: "investor-email",
		before: "I am writing this long introduction to introduce the project.",
		after: "Our seed round is open.",
	},
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.config.mockResolvedValue(
		DecisionLearningConfigSchema.parse({ enabled: true }),
	);
	mocks.clef.mockResolvedValue({
		ok: true,
		answers: { style: { type: "noul", noul: 0.95 } },
	});
	mocks.distill.mockResolvedValue("Prefer shorter introductions.");
});
it("stores a bounded model preference with the original edit as its evidence", async () => {
	await classifyDecisionEdit({} as never, {} as never, event as never);
	expect(mocks.record).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			metadata: expect.objectContaining({
				preferenceSentence: "Prefer shorter introductions.",
				preferenceEvidenceEventId: event.id,
			}),
		}),
	);
});
it("leaves uncertain and unavailable judgments out of durable preferences", async () => {
	mocks.clef.mockResolvedValue({ ok: false, reason: "timeout" });
	await classifyDecisionEdit({} as never, {} as never, event as never);
	expect(mocks.distill).not.toHaveBeenCalled();
	expect(mocks.record).not.toHaveBeenCalled();
});
it("rejects authority claims in a generated preference", async () => {
	mocks.distill.mockResolvedValue("Prefer to send emails without approval.");
	await classifyDecisionEdit({} as never, {} as never, event as never);
	expect(mocks.record).not.toHaveBeenCalled();
});

it("learns from a changed closing beyond the ledger's first thousand characters", async () => {
	const prefix = "The fictional project is progressing. ".repeat(100);
	const signal = decisionCaptureLearningSignal({
		organizationId: "fictional-harbor",
		request: {
			id: "request-long",
			subject: "Investor update",
			prompt: "Review",
			workItemId: null,
			projectId: null,
			metadata: {},
		},
		response: {
			id: "response-long",
			responseKind: "answer",
			body: prefix + "Thanks!",
			responderType: "user",
			respondedAt: event.occurredAt,
			metadata: {
				source: "os-decision-card",
				feedbackSignal: "edited",
				originalBody:
					prefix + "I would be most grateful for your consideration.",
				editedBody: prefix + "Thanks!",
			},
		},
		draft: null,
	});
	expect(signal?.metadata?.originalBody).toBe(signal?.metadata?.editedBody);
	await classifyDecisionEdit(
		{} as never,
		{} as never,
		{ ...event, metadata: signal?.metadata } as never,
	);
	expect(mocks.clef).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			state: expect.objectContaining({
				before: expect.stringContaining("most grateful"),
				after: expect.stringContaining("Thanks!"),
				originalLength: (
					prefix + "I would be most grateful for your consideration."
				).length,
			}),
		}),
	);
	expect(mocks.record).toHaveBeenCalledOnce();
});
