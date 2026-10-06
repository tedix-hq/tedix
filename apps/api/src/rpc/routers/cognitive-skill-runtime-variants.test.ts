import { describe, expect, it } from "vite-plus/test";
import type { ResolvedSkillRunArtifact } from "../../services/skill-workflow-inspection";
import { parseSkillWorkflowRuntimeVariants } from "./cognitive-skill-run-provenance";

function observation(
	path: string,
	executionCompatibilityHash: string,
): ResolvedSkillRunArtifact {
	const content = JSON.stringify({
		provenance: {
			runtime: {
				workerVersionId: "worker-v2",
				workerVersionTag: "production",
				workerVersionTimestamp: "2026-07-24T00:00:00.000Z",
				executionCompatibilityHash,
				dispatchShimVersion: "v41",
				compatibilityDate: "2026-06-11",
				dynamicWorkflowsVersion: "0.1.1",
				loaderConfigHash: path.slice(path.lastIndexOf("/") + 1, -5),
				tenantCpuMs: 60_000,
				tenantSubRequests: 1_000,
			},
		},
	});
	return {
		artifact: {
			id: path,
			runId: "run-1",
			path,
			mimeType: "application/json",
			sizeBytes: content.length,
			contentInline: content,
			contentR2Key: null,
			sha256: null,
			attempt: 1,
			outcome: path.includes("runtime-drift") ? "failure" : "success",
			createdAt: "2026-07-24T00:00:00.000Z",
		},
		content,
	};
}

describe("skill workflow runtime variants", () => {
	it("distinguishes executed, compatible, and blocked Loader observations", () => {
		const executedHash = "a".repeat(64);
		const compatibleHash = "b".repeat(64);
		const blockedHash = "c".repeat(64);
		const variants = parseSkillWorkflowRuntimeVariants([
			observation(`epochs/0/manifests/${executedHash}.json`, "surface-1"),
			observation(
				`epochs/0/runtime-compatible/${compatibleHash}.json`,
				"surface-1",
			),
			observation(`epochs/0/runtime-drift/${blockedHash}.json`, "surface-2"),
		]).get("run-1");

		expect(variants?.map((variant) => variant.observation)).toEqual([
			"executed",
			"compatible",
			"blocked",
		]);
		expect(
			variants?.map((variant) => variant.executionCompatibilityHash),
		).toEqual(["surface-1", "surface-1", "surface-2"]);
	});
});
