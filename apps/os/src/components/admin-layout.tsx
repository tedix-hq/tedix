import type { Permission } from "@tedix/auth/rbac";
import { resolveOsTenant } from "@/shared/os-tenant";
import { Outlet } from "@tanstack/react-router";
import { ShieldCheck } from "@phosphor-icons/react";
import { Card, CardContent } from "@/components/kumo/card";
import {
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
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
					<PageTitle>Administration</PageTitle>
					<PageDescription>
						Organization configuration for operators with administrative
						authority.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			<Card size="sm">
				<CardContent className="flex items-center gap-3">
					<ShieldCheck size={20} aria-hidden />
					<div>
						<Text role="body" weight="medium">
							This area needs administrative authority
						</Text>
						<Text tone="secondary">
							Your credential resolves no administrative role or permission in
							this organization. Ask an owner or admin if you need access.
						</Text>
					</div>
				</CardContent>
			</Card>
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
