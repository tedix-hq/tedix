import { describe, expect, it } from "vite-plus/test";
import { workspaceOutputEditors } from "./workspace-output-editors";

describe("workspace file editor navigation", () => {
	const resource = {
		providerId: "tedix",
		resourceType: "output",
		providerResourceId: "file",
		metadata: { gadgetId: "editor", kind: "document" },
		status: "active",
	};
	it("uses metadata only for an app present in the current workspace", () => {
		expect(
			workspaceOutputEditors([resource], [{ id: "editor" }]).get("file"),
		).toBe("editor");
		expect(
			workspaceOutputEditors([resource], [{ id: "another-workspace-app" }])
				.size,
		).toBe(0);
	});
	it("leaves stale, removed, archived and external bindings on the native fallback", () => {
		for (const invalid of [
			{ ...resource, status: "removed" },
			{ ...resource, metadata: {} },
			{ ...resource, providerId: "outside" },
			{ ...resource, resourceType: "sheet" },
		])
			expect(workspaceOutputEditors([invalid], [{ id: "editor" }]).size).toBe(
				0,
			);
		expect(
			workspaceOutputEditors([resource], [{ id: "editor", status: "archived" }])
				.size,
		).toBe(0);
	});
});
