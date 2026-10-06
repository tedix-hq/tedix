import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ConsentPermission } from "@/shared/consent-permissions";
import { ConsentPermissionGroups } from "./consent-permission-groups";

describe("ConsentPermissionGroups", () => {
	const permissions: ConsentPermission[] = [
		{
			name: "tedix.read",
			description: "Read your workspace",
			group: "Workspace",
			authority: "Member",
			admin: false,
			required: false,
		},
		{
			name: "tedix.admin",
			description: "Administer your workspace",
			group: "Administration",
			authority: "Admin",
			admin: true,
			required: false,
		},
	];

	it("renders each group on the Kumo surface adapter, not hand-written CSS", () => {
		const html = renderToStaticMarkup(
			<ConsentPermissionGroups permissions={permissions} />,
		);
		// The bounded disclosure box is a `Surface` rendered as a native
		// `<details>`, which keeps the consent screen working with no JS.
		expect(html).toContain('data-slot="surface"');
		expect(html).toContain("<details");
		expect(html).toContain("<summary");
		// The scope literal uses the shared inline-code adapter.
		expect(html).toContain('data-slot="code-inline"');
		expect(html).toContain("tedix.read");
		// Every retired `.consent-*` class is gone from the markup.
		for (const retired of [
			"consent-groups",
			"consent-group",
			"consent-group-meta",
		]) {
			expect(html).not.toContain(retired);
		}
	});

	it("opens a high-risk group by default and keeps others collapsed", () => {
		const html = renderToStaticMarkup(
			<ConsentPermissionGroups permissions={permissions} />,
		);
		// The admin group is expanded on first paint so elevated authority is
		// never hidden behind a disclosure the operator has to find.
		expect(html).toContain('<details open=""');
		expect(html).toContain(">Manage</");
	});

	it("shows selected reads without implying that offered management access is granted", () => {
		const container = document.createElement("div");
		container.innerHTML = renderToStaticMarkup(
			<ConsentPermissionGroups
				permissions={permissions.map((permission) => ({
					...permission,
					group: "Workspace",
				}))}
				selectedScopes={["tedix.read"]}
				onSelectionChange={() => {}}
			/>,
		);
		const summary = container.querySelector("summary");
		expect(summary?.textContent).toContain("1 selected");
		expect(summary?.textContent).not.toContain("Admin");
		expect(summary?.textContent).not.toContain("Manage");
		const rows = container.querySelectorAll("li");
		expect(rows[0]?.textContent).toContain("Read your workspace");
		expect(rows[1]?.textContent).toContain("Administer your workspace");
		expect(rows[1]?.textContent).toContain("Manage");
		expect(
			rows[0]?.querySelector('[role="checkbox"]')?.getAttribute("aria-checked"),
		).toBe("true");
		expect(
			rows[1]?.querySelector('[role="checkbox"]')?.getAttribute("aria-checked"),
		).toBe("false");
	});
});
