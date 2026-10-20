import { ASSIGNABLE_ROLES, ROLE_METADATA } from "@tedix/auth/rbac";
import { CAPABILITY_SCOPES } from "@tedix/mcp-shared/auth/scopes";
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
