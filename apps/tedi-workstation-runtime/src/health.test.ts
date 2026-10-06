import { describe, expect, it } from "vite-plus/test";
import { workstationHealth } from "./health";

describe("tedi workstation runtime health", () => {
	it("reports the deployed SHA", () => {
		expect(
			workstationHealth(
				{ BACKUP_BUCKET: {}, GIT_SHA: "0123456789abcdef" },
				"test-version",
			),
		).toMatchObject({
			deployedSha: "0123456789abcdef",
			eventShapeVersion: "test-version",
			service: "tedi-workstation-runtime",
			status: "ok",
		});
	});
});
