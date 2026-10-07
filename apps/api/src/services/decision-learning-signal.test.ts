import type { WorkInteractionReplyDraft } from "@tedix/db/schema/work-factory";
import { describe, expect, it } from "vite-plus/test";
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
