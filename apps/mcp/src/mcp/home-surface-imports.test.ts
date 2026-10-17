import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tedix/api-contract/contracts/work-items", () => {
	throw new Error("Home edge helpers must not load Work contracts");
});
vi.mock("@tedix/api-contract/schemas/kernel-runtime", () => {
	throw new Error("Home edge helpers must not build tool schemas");
});

describe("Home edge import boundary", () => {
	it("checks mounting and queued acknowledgments without loading tool schemas", async () => {
		const { shouldExposeHomeSurface, homeQueuedAckText } =
			await import("./home-surface");
		expect(shouldExposeHomeSurface({ appSlug: "fixture" })).toBe(false);
		expect(
			shouldExposeHomeSurface({
				appSlug: "fixture",
				metadata: { mcpConfig: { aggregateApps: ["fixture-app"] } },
			}),
		).toBe(true);
		expect(
			homeQueuedAckText({ status: "queued", run: { id: "fixture-run" } }),
		).toContain("fixture-run");
	});
});
