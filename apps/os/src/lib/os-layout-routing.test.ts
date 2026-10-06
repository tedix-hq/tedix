import { resolveOsTenant } from "@/shared/os-tenant";
import { describe, expect, it } from "vite-plus/test";
import {
	shouldRenderOrganizationLauncher,
	shouldUseWorkspaceWorkbench,
} from "@/lib/os-layout-routing";

describe("OS layout routing", () => {
	it("renders the organization launcher on the root OS host", () => {
		expect(
			shouldRenderOrganizationLauncher(resolveOsTenant("os.tedix.dev"), false),
		).toBe(true);
	});

	it("uses the launcher only for an unscoped local first run", () => {
		expect(
			shouldRenderOrganizationLauncher(resolveOsTenant("localhost"), true),
		).toBe(true);
		expect(
			shouldRenderOrganizationLauncher(resolveOsTenant("localhost"), false),
		).toBe(false);
		expect(
			shouldRenderOrganizationLauncher(resolveOsTenant("acme.localhost"), true),
		).toBe(false);
	});

	it("uses the tenant shell on a canonical tenant host", () => {
		expect(
			shouldRenderOrganizationLauncher(
				resolveOsTenant("acme.os.tedix.dev"),
				true,
			),
		).toBe(false);
	});

	it("reserves full-width workbench chrome for Canvas only", () => {
		expect(shouldUseWorkspaceWorkbench("/workspace/workspace-1")).toBe(true);
		expect(shouldUseWorkspaceWorkbench("/workspaces")).toBe(false);
		expect(shouldUseWorkspaceWorkbench("/outputs")).toBe(false);
	});
});
