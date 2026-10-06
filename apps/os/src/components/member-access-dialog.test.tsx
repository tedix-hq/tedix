/**
 * Member access view.
 *
 * The value of this surface is that it shows the permissions the API
 * actually evaluates, so these assertions tie the rendered dialog to
 * `ROLE_PERMISSION_GRANTS` rather than to any list restated in the component,
 * and pin the two things it must NOT claim: overrides that nothing enforces,
 * and exhaustiveness it cannot know.
 */
import {
	ASSIGNABLE_ROLES,
	describeRolePermissions,
	type Permission,
	ROLE_PERMISSION_GRANTS,
	TENANT_GRANTABLE_PERMISSIONS,
} from "@tedix/auth/rbac";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	MemberAccessDialog,
	type MemberAccessSubject,
} from "./member-access-dialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

async function mount(
	member: MemberAccessSubject,
	options: { canManage: boolean; isSaving?: boolean },
) {
	const onSave = vi.fn();
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	await act(async () => {
		root.render(
			<MemberAccessDialog
				member={member}
				canManage={options.canManage}
				isSaving={options.isSaving ?? false}
				onClose={() => {}}
				onSave={onSave}
			/>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		host.remove();
	});
	const dialog = document.body.querySelector<HTMLElement>(
		'[role="dialog"], [role="alertdialog"]',
	)!;
	const codes = (selector: string) =>
		[...dialog.querySelectorAll(selector)].map(
			(element) => element.textContent,
		);
	return { dialog, onSave, codes };
}

const subject = (
	role: MemberAccessSubject["role"],
	customPermissions: Permission[] | null = null,
): MemberAccessSubject => ({
	id: "member-1",
	email: "peer@example.com",
	name: "Peer",
	role,
	customPermissions,
});

describe("member access view", () => {
	it("renders the canonical grants, not a restated list", async () => {
		const { dialog } = await mount(subject("member"), { canManage: false });
		const listed = [...dialog.querySelectorAll("li code")].map(
			(code) => code.textContent,
		);
		expect(listed.sort()).toEqual([...ROLE_PERMISSION_GRANTS.member].sort());
	});

	it("describes every assignable role without a gap", () => {
		for (const role of ASSIGNABLE_ROLES) {
			const described = describeRolePermissions(role);
			expect(described.map((entry) => entry.permission).sort()).toEqual(
				[...ROLE_PERMISSION_GRANTS[role]].sort(),
			);
			for (const entry of described) {
				expect(
					entry.label.length,
					`${role}/${entry.permission}`,
				).toBeGreaterThan(0);
			}
		}
	});

	it("labels each permission by the source the API evaluates", async () => {
		const extra = TENANT_GRANTABLE_PERMISSIONS.find(
			(permission) => !ROLE_PERMISSION_GRANTS.member.includes(permission),
		)!;
		const { dialog } = await mount(subject("member", [extra]), {
			canManage: false,
		});
		expect(dialog.textContent?.match(/From role/g)).toHaveLength(
			ROLE_PERMISSION_GRANTS.member.length,
		);
		expect(dialog.textContent).toContain("Additional permissions");
		expect(dialog.textContent).toContain("1 additional");
		expect(dialog.textContent).toContain(extra);
	});

	it("uses Kumo detailed-view geometry for permission-heavy content", async () => {
		const { dialog } = await mount(subject("admin"), { canManage: true });
		expect(dialog.getAttribute("data-size") ?? dialog.className).toMatch(/xl/);
		const grids = [...dialog.querySelectorAll(".max-h-80")];
		expect(grids.length).toBeGreaterThan(0);
		for (const grid of grids)
			expect(grid.className).toContain("sm:grid-cols-2");
	});

	it("only offers overrides the API will accept, never what the role grants", async () => {
		const { dialog } = await mount(subject("member"), { canManage: true });
		const offered = [
			...dialog.querySelectorAll('label code, [role="checkbox"] ~ * code'),
		]
			.map((code) => code.textContent as Permission)
			.filter(Boolean);
		expect(offered.length).toBeGreaterThan(0);
		for (const permission of offered) {
			expect(TENANT_GRANTABLE_PERMISSIONS).toContain(permission);
			expect(ROLE_PERMISSION_GRANTS.member).not.toContain(permission);
		}
		expect(offered).not.toContain("platform:admin");
		expect(offered).not.toContain("catalog:manage");
		expect(TENANT_GRANTABLE_PERMISSIONS).toEqual(ROLE_PERMISSION_GRANTS.owner);
	});

	it("only lets team managers edit, and saves the chosen overrides", async () => {
		const viewer = await mount(subject("member"), { canManage: false });
		expect(viewer.dialog.querySelector('[role="checkbox"]')).toBeNull();
		expect(viewer.dialog.textContent).toContain("No additional permissions.");
		cleanups.splice(0).forEach((cleanup) => cleanup());

		const manager = await mount(subject("member"), { canManage: true });
		const box = manager.dialog.querySelector<HTMLElement>('[role="checkbox"]')!;
		expect(box.getAttribute("aria-disabled")).not.toBe("true");
		// Base UI toggles through its hidden native input.
		const input = box.parentElement!.querySelector("input")!;
		await act(async () => input.click());
		expect(box.getAttribute("aria-checked")).toBe("true");
		const save = [...manager.dialog.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Save permissions",
		)!;
		await act(async () => save.click());
		expect(manager.onSave).toHaveBeenCalledTimes(1);
		const [memberId, permissions] = manager.onSave.mock.calls[0]!;
		expect(memberId).toBe("member-1");
		expect(permissions).toHaveLength(1);
	});

	it("admits that identity-provider grants are not listed", async () => {
		const { dialog } = await mount(subject("member"), { canManage: false });
		expect(dialog.textContent).toContain("identity provider");
	});
});
