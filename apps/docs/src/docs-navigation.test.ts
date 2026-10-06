import { describe, expect, it } from "vite-plus/test";
import {
	configuredSidebarItems,
	taskLedSidebar,
	tedixDocsSidebarItems,
} from "../template/docs-navigation";

function links(paths: string[]) {
	return paths.map((path, order) => ({
		type: "link" as const,
		label: path,
		href: `/${path}/`,
		isCurrent: false,
		order,
	}));
}

describe("tenant-aware docs navigation", () => {
	it("uses Nimbus collection autogeneration for non-Tedix tenants", () => {
		expect(configuredSidebarItems("customer-handbook")).toEqual([
			{ autogenerate: { collection: "docs" } },
		]);
	});

	it("keeps all current Tedix pages in six task-led groups", () => {
		const currentPages = [
			"index",
			...tedixDocsSidebarItems.flatMap((group) => group.items),
		];
		const sidebar = taskLedSidebar(links(currentPages), "tedix");
		expect(
			sidebar.map((item) => (item.type === "group" ? item.label : "link")),
		).toEqual([
			"Start",
			"Troubleshoot",
			"Work with digital workers",
			"Publish with Tedix",
			"Install and operate",
			"For agents and maintainers",
		]);
		expect(
			sidebar.some((item) => item.type === "group" && item.label === "More"),
		).toBe(false);
		expect(
			sidebar[0]?.type === "group"
				? sidebar[0].children.flatMap((item) =>
						item.type === "link" ? [item.href] : [],
					)
				: [],
		).toEqual([
			"/getting-started/",
			"/learning-paths/first-connection/",
			"/learning-paths/first-worker/",
			"/concepts/",
			"/release-status/",
		]);
	});

	it("does not rewrite another tenant even when page names resemble Tedix", () => {
		const original = links(["getting-started", "workers-and-governance"]);
		expect(taskLedSidebar(original, "another-site")).toBe(original);
	});
});
