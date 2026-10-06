import { describe, expect, it } from "vite-plus/test";
import { workItemsContractRouter } from "./work-items";

describe("Work Item factory router", () => {
	it("mounts the artifact-neutral lifecycle", () => {
		const procedures = Object.keys(workItemsContractRouter);
		expect(procedures).toEqual(
			expect.arrayContaining([
				"accept",
				"getReadiness",
				"listReadinessProjection",
				"startAttempt",
				"heartbeatAttempt",
				"settleAttempt",
				"listAttempts",
				"submitEvidence",
				"listEvidence",
				"previewEvidence",
				"listEvents",
				"listAttemptProjection",
				"listRecoveryProjection",
				"complete",
			]),
		);
	});

	it("does not mount retired mixed-status lifecycle aliases", () => {
		const procedures = Object.keys(workItemsContractRouter);
		for (const removed of [
			"update",
			"bulkCancel",
			"reconcileCiFailureIncidents",
			"claim",
			"touchCheckout",
			"release",
			"completeFromGit",
			"submitGitEvidence",
			"repairGitCertification",
			"validateGitProvenance",
			"validateGitProvenanceBatch",
		]) {
			expect(procedures).not.toContain(removed);
		}
	});
});
