import {
	ASSIGNABLE_ROLES,
	ROLE_METADATA,
	describeRolePermissions,
} from "@tedix/auth/rbac";
import {
	CAPABILITY_SCOPES,
	CAPABILITY_SCOPE_METADATA,
} from "@tedix/mcp-shared/auth/scopes";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { CapabilityScopeReference, RolePermissionsMatrix } from "./team-roles";

it("renders each assignable role and capability scope exactly once", () => {
	const doc = new DOMParser().parseFromString(
		renderToStaticMarkup(
			<>
				<RolePermissionsMatrix />
				<CapabilityScopeReference />
			</>,
		),
		"text/html",
	);
	const tables = doc.querySelectorAll("table");
	expect(tables).toHaveLength(2);
	const roles = [...tables[0]!.querySelectorAll("tbody tr")];
	expect(roles).toHaveLength(ASSIGNABLE_ROLES.length);
	for (const role of ASSIGNABLE_ROLES) {
		expect(
			roles.filter(
				(row) =>
					row.querySelector('[data-slot="badge"]')?.textContent ===
					ROLE_METADATA[role].label,
			),
		).toHaveLength(1);
	}
	const scopes = [...tables[1]!.querySelectorAll("code")].map(
		(node) => node.textContent,
	);
	expect(scopes).toEqual([...CAPABILITY_SCOPES]);
	expect(new Set(scopes).size).toBe(CAPABILITY_SCOPES.length);
});

it("expands each mobile role group to exactly its canonical permissions", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	try {
		await act(async () => root.render(<RolePermissionsMatrix />));
		const summaries = container.querySelector(
			'[aria-label="Organization role summaries"]',
		)!;
		expect(summaries.querySelectorAll("section")).toHaveLength(
			ASSIGNABLE_ROLES.length,
		);
		for (const role of ASSIGNABLE_ROLES) {
			const section = summaries.querySelector(
				`[aria-label="${ROLE_METADATA[role].label} role"]`,
			)!;
			const triggers = [...section.querySelectorAll("button")];
			expect(triggers.length).toBeGreaterThan(0);
			for (const trigger of triggers) {
				expect(trigger.getAttribute("aria-expanded")).toBe("false");
				expect(trigger.getAttribute("aria-label")).toContain(
					`${ROLE_METADATA[role].label}:`,
				);
				await act(async () => trigger.click());
				expect(trigger.getAttribute("aria-expanded")).toBe("true");
				expect(
					document.getElementById(trigger.getAttribute("aria-controls")!),
				).not.toBeNull();
			}
			const labels = [...section.querySelectorAll('[data-slot="badge"][title]')]
				.map((badge) => badge.textContent)
				.sort();
			expect(labels).toEqual(
				describeRolePermissions(role)
					.map((entry) => entry.label)
					.sort(),
			);
			await act(async () => triggers[0]!.click());
			expect(triggers[0]!.getAttribute("aria-expanded")).toBe("false");
		}
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});

it("preserves every scope description and human-only boundary in mobile summaries", () => {
	const doc = new DOMParser().parseFromString(
		renderToStaticMarkup(<CapabilityScopeReference />),
		"text/html",
	);
	const sections = [
		...doc.querySelectorAll(
			'[aria-label="MCP capability scope summaries"] section',
		),
	];
	expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual(
		[...CAPABILITY_SCOPES],
	);
	for (const scope of CAPABILITY_SCOPES) {
		const section = sections.find(
			(section) => section.getAttribute("aria-label") === scope,
		)!;
		const meta = CAPABILITY_SCOPE_METADATA[scope];
		expect(section.textContent).toContain(meta.description);
		expect(
			[...section.querySelectorAll('[data-slot="text"]')]
				.find((node) => node.textContent === meta.description)
				?.classList.contains("break-words"),
		).toBe(true);
		expect(section.querySelector('[data-slot="badge"]')?.textContent).toBe(
			meta.humanOnly ? "People only" : "People and tedis",
		);
	}
});
