import type { resolveOsTenant } from "@/shared/os-tenant";

export function shouldRenderOrganizationLauncher(
	tenant: ReturnType<typeof resolveOsTenant>,
	localFirstRunEnabled: boolean,
): boolean {
	return (
		tenant.kind === "launcher" ||
		(localFirstRunEnabled && tenant.kind === "local" && tenant.slug === null)
	);
}

/** A selected Workspace owns a full-width workbench instead of the library shell. */
export function shouldUseWorkspaceWorkbench(pathname: string): boolean {
	return pathname.startsWith("/workspace/");
}
