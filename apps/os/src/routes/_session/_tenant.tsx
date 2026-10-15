import { createFileRoute, redirect } from "@tanstack/react-router";
import { resolveOsTenant } from "@/shared/os-tenant";
import { OsShell } from "@/components/os-shell";
import { shouldRenderOrganizationLauncher } from "@/lib/os-layout-routing";
import { buildLauncherHrefForDeepLink } from "@/account/launcher-routing";

declare const __LOCAL_FIRST_RUN_ENABLED__: boolean;

export const Route = createFileRoute("/_session/_tenant")({
	// The apex launcher host (kind 'launcher') and an unscoped local first run
	// resolve NO tenant, so they must never mount the tenant `OsShell`. Send them
	// to the first-class account launcher instead of branching on the host inside
	// the shell component. `/account/organizations` lives under this same
	// `_session` `SessionBoundary`, so the redirect target keeps the broker
	// resume/renewal timer and `OsIdentityContext` — the tenant layout no longer
	// has to know the launcher exists.
	beforeLoad: ({ location }) => {
		const tenant = resolveOsTenant(window.location.hostname);
		if (shouldRenderOrganizationLauncher(tenant, __LOCAL_FIRST_RUN_ENABLED__)) {
			// Keep a deep link such as `/outputs/<id>` so the chosen workspace
			// opens on it rather than on its root.
			throw redirect({ href: buildLauncherHrefForDeepLink(location.href) });
		}
	},
	component: TenantLayout,
});

function TenantLayout() {
	return <OsShell />;
}
