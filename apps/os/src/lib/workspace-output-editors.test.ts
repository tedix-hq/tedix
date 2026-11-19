import { describe, expect, it } from "vite-plus/test";
import {
	workspaceAppTitles,
	workspaceOutputEditors,
} from "./workspace-output-editors";

describe("workspace file editor navigation", () => {
	const resource = {
		providerId: "tedix",
		resourceType: "output",
		providerResourceId: "file",
		metadata: { gadgetId: "editor", kind: "document" },
		status: "active",
	};
	it("uses the current file title for the editor and preserves other app names", () => {
		const apps = [
			{ id: "editor", name: "Doc · Old title (00000040)" },
			{ id: "other", name: "Other app" },
		];
		const editors = workspaceOutputEditors([resource], apps);
		const titles = (title: string) =>
			workspaceAppTitles(apps, [{ id: "file", title }], editors).map(
				(app) => app.name,
			);

		expect(titles("Old title")).toEqual(["Old title", "Other app"]);
		expect(titles("New title")).toEqual(["New title", "Other app"]);
	});
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
