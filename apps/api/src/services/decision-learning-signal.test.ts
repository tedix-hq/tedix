import type { WorkInteractionReplyDraft } from "@tedix/db/schema/work-factory";
import { describe, expect, it } from "vite-plus/test";
import { DecisionLearningConfigSchema } from "@tedix/api-contract/schemas/decision-learning";
import { LearningInteractionEventSchema } from "@tedix/api-contract/schemas/learning-feedback";
import { learnDecisions } from "@tedix/api-contract/utils/decision-learning";
import {
	type DecisionCaptureRequestView,
	type DecisionCaptureResponseView,
	decisionCaptureLearningSignal,
	learningScopeSlug,
} from "./decision-learning-signal";

const request = (
	over: Partial<DecisionCaptureRequestView> = {},
): DecisionCaptureRequestView => ({
	id: "req-1",
	subject: "acme-app · claude-code waiting: Ship the migration?",
	prompt: "I finished the change. Ship the migration now or wait for review?",
	workItemId: null,
	projectId: "proj-1",
	metadata: {
		schema: "tedix.decision-capture.v1",
		source: "agent-turn-end",
		host: "claude-code",
		sessionId: "sess-1",
		repository: "Acme App",
		branch: "main",
		triage: { labels: { needs_decision: 0.8, blocked: 0.1 } },
	},
	...over,
});

const response = (
	over: Partial<DecisionCaptureResponseView> = {},
): DecisionCaptureResponseView => ({
	id: "resp-1",
	responseKind: "answer",
	body: "Wait for review; never ship migrations without a dry run.",
	responderType: "user",
	respondedAt: "2026-10-07T10:00:00.000Z",
	metadata: { schema: "tedix.decision-capture.v1", source: "user-reply" },
	...over,
});

const draft = (
	over: Partial<WorkInteractionReplyDraft> = {},
): WorkInteractionReplyDraft => ({
	id: "draft-1",
	orgId: "org-1",
	interactionId: "req-1",
	drafterType: "tedi",
	drafterId: "tedi-1",
	body: "Ship it.",
	rationale: "Tests pass",
	turnType: "Ship Decision",
	delivery: "review",
	gate: null,
	createdAt: "2026-10-07T09:59:00.000Z",
	...over,
});

describe("decisionCaptureLearningSignal", () => {
	it("keeps the reviewed proposal, organization context and waiting cost under the server's class", () => {
		const signal = decisionCaptureLearningSignal({
			organizationId: "org-fictional-acme",
			request: request({
				projectId: "acme-project",
				workItemId: "acme-work",
				metadata: {
					decisionDeck: {
						version: 1,
						kind: "decision",
						classId: "supplier.reminder",
						proposal: "Remind the supplier tomorrow",
						whyNow: "The delivery is due tomorrow",
						recommendation: "Wait until tomorrow morning",
						reversibility: "two_way",
						tasteOrStrategy: true,
						protectedEffects: [],
						blastRadius: "One supplier",
						confidence: 0.9,
						costOfWaiting: "No cost before the delivery date",
						reasoning: "The agreed date is tomorrow",
						lessons: [],
						options: [
							{
								id: "keep",
								label: "Keep",
								intent: "approve",
								consequence: "Keep the timing",
								cost: "None",
							},
							{
								id: "reject",
								label: "Change",
								intent: "reject",
								consequence: "Reconsider timing",
								cost: "None",
							},
						],
					},
				},
			}),
			response: response({
				metadata: {
					source: "os-decision-card",
					decisionClass: "untrusted-class",
					decisionChoice: "approve",
					feedbackSignal: "approve-as-is",
				},
			}),
			draft: null,
		});
		expect(signal?.issueKey).toBe("decision:general:general:supplier.reminder");
		expect(signal?.metadata).toMatchObject({
			decisionClass: "supplier.reminder",
			decisionContext: {
				proposal: "Remind the supplier tomorrow",
				projectId: "acme-project",
				workItemId: "acme-work",
				whyNow: "The delivery is due tomorrow",
				costOfWaiting: "No cost before the delivery date",
			},
		});
	});
	it("records a plain answer as a scoped decision", () => {
		const signal = decisionCaptureLearningSignal({
			organizationId: "org-1",
			request: request(),
			response: response(),
			draft: null,
		});
		expect(signal).toMatchObject({
			organizationId: "org-1",
			clientEventId: "decision-capture:resp-1",
			eventKind: "answered",
			surface: "decision_capture",
			tediId: null,
			issueKey: "decision:acme-app:claude-code:needs_decision",
			targetType: "work_interaction",
			targetId: "req-1",
			threadId: "sess-1",
			metadata: {
				scope: {
					repo: "acme-app",
					harness: "claude-code",
					topic: "needs_decision",
				},
				answer: "Wait for review; never ship migrations without a dry run.",
				draft: null,
			},
		});
	});

	it("keeps draft vs final for a replaced draft and attributes the drafter", () => {
		const signal = decisionCaptureLearningSignal({
			organizationId: "org-1",
			request: request(),
			response: response({
				metadata: {
					draftId: "draft-1",
					draftOutcome: "replaced",
					editRatio: 0.9,
					source: "os-inbox",
				},
			}),
			draft: draft(),
		});
		expect(signal?.eventKind).toBe("manually_replaced");
		expect(signal?.tediId).toBe("tedi-1");
		expect(signal?.issueKey).toBe(
			"decision:acme-app:claude-code:ship-decision",
		);
		expect(signal?.metadata?.draft).toMatchObject({
			id: "draft-1",
			outcome: "replaced",
			body: "Ship it.",
			editRatio: 0.9,
		});
	});

	it("maps edited, accepted and auto-sent outcomes", () => {
		const kind = (meta: Record<string, unknown>) =>
			decisionCaptureLearningSignal({
				organizationId: "org-1",
				request: request(),
				response: response({ metadata: { draftId: "draft-1", ...meta } }),
				draft: draft({ delivery: "auto" }),
			})?.eventKind;
		expect(kind({ draftOutcome: "edited" })).toBe("edited");
		expect(kind({ draftOutcome: "accepted" })).toBe("accepted");
		expect(kind({ draftOutcome: "auto-sent", replyClass: "continue" })).toBe(
			"accepted",
		);
		expect(kind({ draftOutcome: "auto-sent", replyClass: "redirect" })).toBe(
			"manually_replaced",
		);
		expect(kind({ draftOutcome: "auto-sent", replyClass: "question" })).toBe(
			"answered",
		);
	});

	it("ignores a cited draft that is not the stored one", () => {
		const signal = decisionCaptureLearningSignal({
			organizationId: "org-1",
			request: request(),
			response: response({
				metadata: { draftId: "draft-other", draftOutcome: "replaced" },
			}),
			draft: draft(),
		});
		expect(signal?.eventKind).toBe("answered");
		expect(signal?.tediId).toBeNull();
	});

	it("skips non decision-capture interactions and non-human answers", () => {
		expect(
			decisionCaptureLearningSignal({
				organizationId: "org-1",
				request: request({ metadata: { schema: "other" } }),
				response: response(),
				draft: null,
			}),
		).toBeNull();
		expect(
			decisionCaptureLearningSignal({
				organizationId: "org-1",
				request: request(),
				response: response({ responderType: "tedi" }),
				draft: null,
			}),
		).toBeNull();
		expect(
			decisionCaptureLearningSignal({
				organizationId: "org-1",
				request: request(),
				response: response({ responseKind: "coordination_update" }),
				draft: null,
			}),
		).toBeNull();
	});

	it("slugs scope segments", () => {
		expect(learningScopeSlug("  My Repo/Name ")).toBe("my-repo-name");
		expect(learningScopeSlug(null)).toBe("general");
	});
});

describe("decision card feedback", () => {
	it.each([
		["approve-as-is", "accepted"],
		["edited", "edited"],
		["reason", "rejected"],
		["free-text", "answered"],
	])(
		"records %s on non-capture requests in the same learning ledger",
		(feedbackSignal, eventKind) => {
			const signal = decisionCaptureLearningSignal({
				organizationId: "org-fictional",
				request: request({ metadata: {} }),
				response: response({
					responseKind: "handoff_declined",
					metadata: {
						source: "os-decision-card",
						cardAction: "never",
						feedbackSignal,
						feedbackReason: "wrong facts",
						feedbackText: "Morgan prefers a short reply.",
					},
				}),
				draft: null,
			});
			expect(signal).toMatchObject({
				eventKind,
				targetId: "req-1",
				metadata: {
					cardAction: "never",
					feedbackSignal,
					feedbackReason: "wrong facts",
					feedbackText: "Morgan prefers a short reply.",
				},
			});
		},
	);
	it("feeds opportunity handoff feedback into the person's decision model", () => {
		const signal = decisionCaptureLearningSignal({
			organizationId: "org-fictional",
			request: request({ metadata: { decisionClass: "inbox-opportunity" } }),
			response: response({
				responseKind: "handoff_declined",
				metadata: {
					source: "os-decision-card",
					decisionClass: "inbox-opportunity",
					decisionChoice: "reject",
					cardAction: "never",
					feedbackSignal: "rejected",
					feedbackText: "This customer already replied.",
				},
			}),
			draft: null,
		});
		expect(signal).not.toBeNull();
		const event = LearningInteractionEventSchema.parse({
			...signal,
			id: "opportunity-feedback",
			actorType: "user",
			actorId: "person-river",
			scopeKind: "personal",
			scopeId: "person-river",
			threadId: null,
			runId: null,
			createdAt: response().respondedAt,
			metadata: { ...signal!.metadata, serverObserved: true },
		});
		const model = learnDecisions({
			organizationId: "org-fictional",
			personId: "person-river",
			config: DecisionLearningConfigSchema.parse({ enabled: true }),
			events: [event],
			now: new Date(response().respondedAt),
		});
		expect(model.eventCount).toBe(1);
		expect(model.receipts[0]).toMatchObject({
			classId: "inbox-opportunity",
			eventKind: "rejected",
			choice: "reject",
		});
	});
	it("does not promote an agent's card feedback into human learning", () => {
		expect(
			decisionCaptureLearningSignal({
				organizationId: "org-fictional",
				request: request({ metadata: {} }),
				response: response({
					responderType: "external_agent",
					metadata: {
						source: "os-decision-card",
						feedbackSignal: "approve-as-is",
					},
				}),
				draft: null,
			}),
		).toBeNull();
	});
	it("keeps class, edits and elapsed time in the existing learning feed for a fictional organization", () => {
		const signal = decisionCaptureLearningSignal({
			organizationId: "org-fictional-acme",
			request: request({ metadata: {} }),
			response: response({
				metadata: {
					source: "os-decision-card",
					decisionClass: "schema-migrations",
					decisionChoice: "change",
					feedbackSignal: "edited",
					originalBody: "Drop now",
					editedBody: "Backfill first",
					editRatio: 0.8,
					elapsedMs: 1800,
				},
			}),
			draft: null,
		});
		expect(signal).toMatchObject({
			organizationId: "org-fictional-acme",
			eventKind: "edited",
			issueKey: "decision:general:general:schema-migrations",
			metadata: {
				decisionClass: "schema-migrations",
				decisionChoice: "change",
				originalBody: "Drop now",
				editedBody: "Backfill first",
				editRatio: 0.8,
				elapsedMs: 1800,
			},
		});
	});

	it("retains full edit lengths and canonical draft text when ledger text is clipped", () => {
		for (const draftOutcome of ["edited", "replaced"]) {
			const signal = decisionCaptureLearningSignal({
				organizationId: "fictional-harbor",
				request: request(),
				response: response({
					body: "b".repeat(1500),
					metadata: { draftId: "draft-1", draftOutcome },
				}),
				draft: draft({ orgId: "fictional-harbor", body: "a".repeat(3600) }),
			});
			expect(signal?.metadata).toMatchObject({
				originalLength: 3600,
				editedLength: 1500,
				originalBody: "a".repeat(1000),
				editedBody: "b".repeat(1000),
			});
		}
	});
});
