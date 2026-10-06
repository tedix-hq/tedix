import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { resolveOsTenant } from "@/shared/os-tenant";
import { useEffect, useMemo } from "react";
import {
	buildLauncherWorkspacesFromDirectory,
	buildLocalLauncherWorkspaces,
	buildTenantOsHandoffUrl,
	collectAuthorizedReturnOrigins,
	getLauncherReturnTarget,
	isReturnTargetAuthorized,
	resolveOsPlatformDomain,
} from "@/account/launcher-routing";
import { OrganizationLauncherContent } from "@/account/organization-launcher-page";
import { useOsOnboardingState } from "@/account/use-os-onboarding-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Button } from "@/components/kumo/button";
import { ListSkeleton } from "@/components/list-skeleton";
import { myWorkspacesDirectoryQueryOptions } from "@/lib/os-query-options";
import { TedixBrandLogo, TedixBrandMark } from "@/shared/tedix-brand";
import { useDocumentTitle } from "@/lib/use-document-title";
import { useOsIdentity } from "@/lib/use-os-identity";

// Canonical full-page ORGANIZATION destination. Reachable from the apex (which
// redirects `/` here) and, later, from a tenant OsShell "switch organization"
// affordance. First-run naming is no longer muxed into this component — when the
// caller still needs onboarding it hands off to `/account/onboarding`.
export const Route = createFileRoute("/_session/account/organizations")({
	component: AccountOrganizationsRoute,
});

function AccountOrganizationsRoute() {
	useDocumentTitle("Choose a workspace · Tedix OS");
	const tenant = resolveOsTenant(window.location.hostname);
	const osPlatformDomain = resolveOsPlatformDomain(window.location.hostname);
	const localEvaluation = tenant.kind === "local";
	const identity = useOsIdentity();
	const returnTarget = useMemo(
		() => getLauncherReturnTarget(window.location.search),
		[],
	);
	// First-run detection stays on the OS-membership projection (listOsMine +
	// bootstrap): it decides whether the caller still needs onboarding.
	const {
		organizations,
		items,
		onboardingOwner,
		isLoading,
		error,
		refetch: refetchOnboardingState,
	} = useOsOnboardingState();
	// The cross-surface picker and the returnTo trust root come from the
	// directory. It is the authority for which member surfaces are provisioned
	// and where each one lives. The local lane has no directory.
	const directory = useQuery({
		...myWorkspacesDirectoryQueryOptions(),
		enabled: !localEvaluation,
	});
	const records = directory.data?.data ?? [];
	const authorizedOrigins = useMemo(
		() => collectAuthorizedReturnOrigins(records, osPlatformDomain),
		[osPlatformDomain, records],
	);
	const directoryReady = localEvaluation || directory.isSuccess;
	const returnAuthorized = returnTarget
		? isReturnTargetAuthorized(returnTarget, authorizedOrigins)
		: false;

	useEffect(() => {
		if (directoryReady && returnTarget && returnAuthorized) {
			window.location.replace(buildTenantOsHandoffUrl(returnTarget));
		}
	}, [directoryReady, returnAuthorized, returnTarget]);

	const workspaces = useMemo(
		() =>
			localEvaluation
				? buildLocalLauncherWorkspaces(items, window.location.port)
				: buildLauncherWorkspacesFromDirectory(records, osPlatformDomain),
		[localEvaluation, items, osPlatformDomain, records],
	);

	if (
		isLoading ||
		(!localEvaluation && directory.isLoading) ||
		(directoryReady && returnTarget && returnAuthorized)
	) {
		return (
			// Match the centered `.centered-state` sign-in loader: the interstitial
			// is a full-viewport centered brand + status, not the top-anchored
			// launcher card, so the two onboarding loaders read as one screen.
			<main className="centered-state" aria-busy="true">
				<TedixBrandLogo />
				<p>Opening your Tedix OS workspace…</p>
				<div className="centered-state-skeleton">
					<ListSkeleton />
				</div>
			</main>
		);
	}
	if (organizations.isError || directory.isError) {
		return (
			<main className="org-launcher">
				<section className="org-launcher-card">
					<TedixBrandMark />
					<Alert variant="destructive">
						<AlertTitle>Could not load your workspaces</AlertTitle>
						<AlertDescription>
							<p>This is usually temporary.</p>
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={() => {
									refetchOnboardingState();
									void directory.refetch();
								}}
							>
								Try again
							</Button>
						</AlertDescription>
					</Alert>
				</section>
			</main>
		);
	}
	if (items.length === 0 && error) {
		return (
			<main className="org-launcher">
				<section className="org-launcher-card">
					<TedixBrandMark />
					<Alert variant="destructive">
						<AlertTitle>Could not prepare your workspace</AlertTitle>
						<AlertDescription>
							<p>
								{error instanceof Error
									? error.message
									: "This is usually temporary."}
							</p>
							<Button
								type="button"
								variant="secondary"
								size="sm"
								onClick={() => {
									refetchOnboardingState();
								}}
							>
								Try again
							</Button>
						</AlertDescription>
					</Alert>
				</section>
			</main>
		);
	}
	if (items.length === 0 && onboardingOwner) {
		return (
			<Navigate to="/account/onboarding" search={{ new: undefined }} replace />
		);
	}
	return (
		<OrganizationLauncherContent
			workspaces={workspaces}
			email={identity.email}
			blockedReturnTarget={Boolean(returnTarget && !returnAuthorized)}
			localEvaluation={localEvaluation}
		/>
	);
}
