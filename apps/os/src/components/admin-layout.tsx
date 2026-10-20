import { RestrictedNotice } from "@/components/restricted-notice";
import type { Permission } from "@tedix/auth/rbac";
import { resolveOsTenant } from "@/shared/os-tenant";
import { Outlet } from "@tanstack/react-router";
import {
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
} from "@/components/kumo/page";
import { OsRoutePending } from "@/components/os-route-boundaries";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

/**
 * The /admin section gate. One gate in the LAYOUT, so a page added under
 * /admin later cannot ship ungated. This is a UI-truthfulness boundary —
 * apps/api re-checks authority on every mutation; hiding the surface here
 * only keeps the product honest about what the credential can do.
 */
const ADMIN_SECTION_PERMISSIONS: readonly Permission[] = [
	"settings:manage",
	"os:admin",
];
const ADMIN_SECTION_ROLES: readonly string[] = ["owner", "admin", "admin"];

export function canAccessAdminSection(authority: {
	role: string | null;
	permissions: readonly string[];
}): boolean {
	if (ADMIN_SECTION_PERMISSIONS.some((p) => authority.permissions.includes(p)))
		return true;
	return (
		authority.role !== null && ADMIN_SECTION_ROLES.includes(authority.role)
	);
}

function AdminRestricted() {
	return (
		<Page width="md">
			<PageHeader>
				<PageHeading>
					<PageTitle>Settings</PageTitle>
					<PageDescription>
						Manage your organization and its settings.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			<RestrictedNotice
				title="Only organization owners and admins can open these settings"
				description="Ask an owner or admin if you need access to these settings."
			/>
		</Page>
	);
}

export function AdminSectionLayout() {
	// The zero-account local lane has a synthetic identity with no Descope
	// authority; gating it would lock /admin out of local development.
	const localEvaluation =
		resolveOsTenant(window.location.hostname).kind === "local";
	const context = useOsOperationalContext();

	if (localEvaluation) return <Outlet />;
	if (context.isPending) return <OsRoutePending />;

	const authority = context.data?.authority;
	if (!authority || !canAccessAdminSection(authority)) {
		return <AdminRestricted />;
	}
	return <Outlet />;
}
