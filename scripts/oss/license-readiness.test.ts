import { describe, expect, test } from "bun:test";
import { evaluateLicenseApproval } from "./license-readiness";
import policy from "./license-readiness-policy.json";

const requirements = {
	rootLicenseSpdx: "AGPL-3.0-only",
	workspaceManifestSpdxMustMatch: true,
	requiresCounselApproval: true,
	requiresOwnerLaunchApproval: true,
} as const;

describe("license approval state", () => {
	test("owner-approved launch policy does not require counsel but still requires publication approval", () => {
		const result = evaluateLicenseApproval({
			errors: [],
			surfaceWarnings: [],
			reviewArtifacts: policy.requiredReviewArtifacts.map((artifact) => ({
				...artifact,
				present: true,
			})),
			requirements: { ...requirements, ...policy.ratificationRequirements },
		});
		expect(policy.ratificationRequirements.requiresCounselApproval).toBe(false);
		expect(result.status).toBe("ratified");
		expect(result.pendingExternalDecisions).toEqual([
			"The owner must separately authorize public repository visibility and launch.",
		]);
	});

	test("keeps a counsel-required policy pending counsel and launch", () => {
		const result = evaluateLicenseApproval({
			errors: [],
			surfaceWarnings: [],
			reviewArtifacts: [
				{ path: "docs/public/licensing.md", status: "approved", present: true },
				{ path: "TRADEMARKS.md", status: "approved", present: true },
			],
			requirements,
		});
		expect(result.status).toBe("engineering-ready-pending-counsel");
		expect(result.approvalStatus).toBe("owner-approved-pending-counsel");
		expect(result.pendingExternalDecisions).toHaveLength(2);
		expect(result.pendingExternalDecisions[0]).toContain("Counsel");
		expect(result.pendingExternalDecisions[1]).toContain("owner");
	});

	test("ratifies the license only after recorded counsel approval", () => {
		const result = evaluateLicenseApproval({
			errors: [],
			surfaceWarnings: [],
			reviewArtifacts: [
				{ path: "docs/public/licensing.md", status: "approved", present: true },
			],
			requirements: {
				...requirements,
				counselApprovalEvidence: "work-item:approved-counsel-record",
			},
		});
		expect(result.status).toBe("ratified");
		expect(result.approvalStatus).toBe("ratified");
		expect(result.pendingExternalDecisions).toEqual([
			"The owner must separately authorize public repository visibility and launch.",
		]);
	});

	test("a required draft review remains pending even with counsel evidence", () => {
		const result = evaluateLicenseApproval({
			errors: [],
			surfaceWarnings: [],
			reviewArtifacts: [
				{
					path: "legal-review/draft.md",
					status: "counsel-input-draft",
					present: true,
				},
			],
			requirements: {
				...requirements,
				counselApprovalEvidence: "work-item:approved-counsel-record",
				ownerLaunchApprovalEvidence: "work-item:approved-launch-record",
			},
		});
		expect(result.status).toBe("engineering-ready-pending-counsel");
		expect(result.pendingExternalDecisions).toEqual([
			"Review artifact awaits approval: legal-review/draft.md (counsel-input-draft).",
		]);
	});

	test("engineering errors still block independently of legal approval", () => {
		const result = evaluateLicenseApproval({
			errors: ["canonical artifact drift"],
			surfaceWarnings: [],
			reviewArtifacts: [],
			requirements: {
				...requirements,
				counselApprovalEvidence: "work-item:approved-counsel-record",
				ownerLaunchApprovalEvidence: "work-item:approved-launch-record",
			},
		});
		expect(result.status).toBe("blocked");
		expect(result.pendingExternalDecisions).toEqual([]);
	});
});
