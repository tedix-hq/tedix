import { describe, expect, it } from "vite-plus/test";
import { catalogSyncTerminalFailure } from "./catalog-sync-recovery";

describe("catalogSyncTerminalFailure", () => {
	it("recognizes application failure inside native completion", () => {
		expect(
			catalogSyncTerminalFailure({
				status: "complete",
				output: { success: false, error: "request budget exhausted" },
			}),
		).toBe("request budget exhausted");
	});
	it("does not fail active, successful, or unknown outcomes", () => {
		for (const state of [
			{ status: "running", output: { success: false } },
			{ status: "complete", output: { success: true } },
			{ status: "complete" },
			{ status: "paused" },
		])
			expect(catalogSyncTerminalFailure(state)).toBeNull();
	});
	it("recognizes native error and termination", () => {
		expect(catalogSyncTerminalFailure({ status: "errored" })).toContain(
			"errored",
		);
		expect(catalogSyncTerminalFailure({ status: "terminated" })).toContain(
			"terminated",
		);
	});
});
