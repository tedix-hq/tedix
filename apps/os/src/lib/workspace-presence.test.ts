import { describe, expect, it } from "vite-plus/test";
import { workspacePresenceDocKey } from "./workspace-presence";

describe("workspacePresenceDocKey", () => {
	it("uses one room for the whole workspace", () => {
		expect(workspacePresenceDocKey("workspace-1")).toBe(
			"workspace:workspace-1",
		);
	});
});
