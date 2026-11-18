import { describe, expect, it } from "vite-plus/test";
import { safeDeployDetails, safeDeployMessage } from "./deploy-status-safety";

describe("CMS deploy status safety", () => {
	it("retains bounded progress counts while dropping provider and build text", () => {
		expect(
			safeDeployDetails({
				fileCount: 31,
				privacyBannerEnabled: true,
				sourceRevision: { kind: "artifacts_commit", value: "private" },
				reason: "provider error with credential",
				stdout: "build output with credential",
				probeUrl: "https://example.test/?token=private",
			}),
		).toEqual({ fileCount: 31, privacyBannerEnabled: true });
		expect(safeDeployDetails({ reason: "private" })).toBeUndefined();
	});

	it("uses a fixed failure message instead of an exception", () => {
		expect(safeDeployMessage("failed", "token leaked by build")).toBe(
			"Deploy failed; inspect server logs",
		);
		expect(safeDeployMessage("running", "Building Astro bundle")).toBe(
			"Building Astro bundle",
		);
	});
	it("persists only structured failure enums and bounded log correlation", () => {
		const failure = {
			phase: "health-check",
			code: "PROBE_IMAGE_INVALID",
			retryable: false,
			rollback: "succeeded",
			correlationId: "cms-test-job",
			rollbackError: "private provider detail",
		};
		expect(safeDeployDetails(failure)).toEqual({
			phase: failure.phase,
			code: failure.code,
			retryable: false,
			rollback: "succeeded",
			correlationId: failure.correlationId,
		});
		expect(
			safeDeployDetails({
				phase: "secret",
				code: "secret",
				rollback: "secret",
				correlationId: "token=secret",
			}),
		).toBeUndefined();
	});
});
