import type {
	LearningImprovementProposalRow,
	LearningInteractionEventRow,
} from "@tedix/db/schema/learning-feedback";
import { describe, expect, it } from "vite-plus/test";
import {
	learningInteractionRowToContract,
	learningProposalRowToContract,
} from "./learning-feedback-persistence";

describe("learning feedback persistence normalization", () => {
	it("normalizes nullable event metadata at the API boundary", () => {
		const row: LearningInteractionEventRow = {
			id: "event-1",
			organizationId: "org-1",
			actorType: "user",
			actorId: "user-1",
			tediId: null,
			clientEventId: "client-event-1",
			signalClass: "quality",
			eventKind: "accepted",
			scopeKind: "organization",
			scopeId: "org-1",
			issueKey: null,
			surface: "os",
			targetType: null,
			targetId: null,
			threadId: null,
			runId: null,
			metadata: null,
			occurredAt: "2026-08-01T00:00:00.000Z",
			createdAt: "2026-08-01T00:00:00.000Z",
		};

		expect(learningInteractionRowToContract(row).metadata).toBeNull();
	});

	it("does not expose persistence-only certification refs", () => {
		const row: LearningImprovementProposalRow = {
			id: "proposal-1",
			organizationId: "org-1",
			clientProposalId: "client-proposal-1",
			tediId: null,
			scopeKind: "organization",
			scopeId: "org-1",
			issueKey: "quality:retry",
			subjectKind: "workflow",
			subjectId: "workflow-1",
			status: "proposed",
			promotionRoute: "workflow_improvement",
			recommendation: "Tighten the retry gate",
			evidenceEventIds: ["event-1"],
			attributionId: null,
			baselineMeasurementId: null,
			followupMeasurementId: null,
			certificationEvidenceRefs: ["internal-only"],
			evaluationNote: null,
			reviewReason: null,
			proposedByType: "user",
			proposedById: "user-1",
			reviewedById: null,
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:00:00.000Z",
			reviewedAt: null,
		};

		const contract = learningProposalRowToContract(row);
		expect(contract).not.toHaveProperty("certificationEvidenceRefs");
		expect(contract.id).toBe("proposal-1");
	});
});
