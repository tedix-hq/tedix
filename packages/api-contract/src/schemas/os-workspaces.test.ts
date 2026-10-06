import { describe, expect, it } from "vite-plus/test";
import { OsOutputLibraryPreviewSchema } from "./os-workspaces";

describe("OS output library preview", () => {
	it("represents a server-denied source without carrying content", () => {
		const preview = OsOutputLibraryPreviewSchema.parse({
			kind: "unavailable",
			reason: "source_access_unavailable",
		});
		expect(preview).toEqual({
			kind: "unavailable",
			reason: "source_access_unavailable",
		});
		expect(JSON.stringify(preview)).not.toContain("content");
	});
});
