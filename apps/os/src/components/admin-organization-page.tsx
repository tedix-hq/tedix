import { LoadingArea } from "@/components/loading-area";
import { WorkspaceAppRenderer } from "@/components/workspace-app-renderer";
/**
 * Admin › Organization
 *
 * Organization profile and settings on the `organizations` and `billing`
 * contracts: profile CRUD, subscription, plan features, SSO administration,
 * and the owner-only danger zone.
 *
 * The organization id comes from the credential-resolved operational context —
 * never from the hostname or a path segment. Section access is gated once by
 * the /admin layout; the API re-checks authority on every read and write. The
 * one page-level authority fork is the danger zone: `organizations.delete`
 * refuses any non-owner membership server-side, so the section renders only
 * for `authority.role === "owner"` — mirroring the guard, not replacing it.
 *
 * The settings sections load lazily so the route chunk
 * stays a composition shell.
 */

import { useQuery } from "@tanstack/react-query";
import type { OrganizationFeatures } from "@tedix/api-contract/schemas/organization";
import { lazy, Suspense } from "react";
import { Link } from "@/components/kumo/link";
import { LoadError } from "@/components/kumo/alert";
import {
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
} from "@/components/kumo/page";
import { SettingsSectionNavigation } from "@/components/settings-section-navigation";
import {
	organizationDetailQueryOptions,
	organizationFeaturesQueryOptions,
} from "@/lib/os-query-options";

import { useOsOperationalContext } from "@/lib/use-os-preferences";

const OrganizationProfileForm = lazy(() =>
	import("@/components/organization-profile-form").then((mod) => ({
		default: mod.OrganizationProfileForm,
	})),
);

const OrganizationInboundClientsSection = lazy(() =>
	import("@/components/organization-inbound-clients-section").then((mod) => ({
		default: mod.OrganizationInboundClientsSection,
	})),
);

const OrganizationAppearanceForm = lazy(() =>
	import("@/components/organization-appearance-form").then((mod) => ({
		default: mod.OrganizationAppearanceForm,
	})),
);

const OrganizationModelFallbackForm = lazy(() =>
	import("@/components/organization-model-fallback-form").then((mod) => ({
		default: mod.OrganizationModelFallbackForm,
	})),
);

const FeaturesSection = lazy(() =>
	import("@/components/organization-features-section").then((mod) => ({
		default: mod.FeaturesSection,
	})),
);

const AdminPortalSection = lazy(() =>
	import("@/components/organization-admin-portal-section").then((mod) => ({
		default: mod.AdminPortalSection,
	})),
);

const SsoSection = lazy(() =>
	import("@/components/organization-sso-section").then((mod) => ({
		default: mod.SsoSection,
	})),
);

const ORGANIZATION_SECTION_ITEMS = [
	["Profile", "organization-profile"],
	["Appearance", "organization-appearance"],
	["Billing", "organization-billing"],
	["Authentication", "organization-authentication"],
] as const;

const ORGANIZATION_OWNER_SECTION_ITEMS = [
	...ORGANIZATION_SECTION_ITEMS,
	["Project sections", "organization-portfolio"],
	["Delegated approvals", "organization-delegated-approvals"],
	["Danger", "organization-danger"],
] as const;

const DangerZone = lazy(() =>
	import("@/components/organization-danger-zone").then((mod) => ({
		default: mod.DangerZone,
	})),
);

function OrganizationPagePending() {
	return <LoadingArea label="Loading organization settings" />;
}

export function AdminOrganizationPage() {
	const context = useOsOperationalContext();

	return (
		<Page width="md">
			<PageHeader>
				<PageHeading>
					<PageTitle>Organization settings</PageTitle>
					<PageDescription>
						Manage your organization’s details, appearance, billing, and sign-in
						settings.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			{context.isPending ? (
				<OrganizationPagePending />
			) : context.isError || !context.data ? (
				<LoadError
					title="Organization settings are unavailable"
					error={context.error}
					onRetry={() => {
						void context.refetch();
					}}
					retrying={context.isFetching}
				/>
			) : (
				<AdminOrganizationBody
					organizationId={context.data.organization.id}
					isOwner={context.data.authority.role === "owner"}
					canManageBilling={context.data.authority.permissions.includes(
						"billing:manage",
					)}
				/>
			)}
		</Page>
	);
}

function AdminOrganizationBody({
	organizationId,
	isOwner,
	canManageBilling,
}: {
	organizationId: string;
	isOwner: boolean;
	canManageBilling: boolean;
}) {
	const detailQuery = useQuery(organizationDetailQueryOptions(organizationId));
	const featuresQuery = useQuery(
		organizationFeaturesQueryOptions(organizationId),
	);

	if (detailQuery.isPending) return <OrganizationPagePending />;
	if (detailQuery.isError || !detailQuery.data) {
		return (
			<LoadError
				title="The organization could not be read"
				error={detailQuery.error}
				onRetry={() => {
					void detailQuery.refetch();
				}}
				retrying={detailQuery.isFetching}
			/>
		);
	}

	const organization = detailQuery.data;
	// Features degrade quietly: the page still renders profile, subscription,
	// and danger zone when the features read fails.
	const features: OrganizationFeatures = featuresQuery.data ?? {};
	const ssoEnabled = features.sso || false;

	return (
		<div className="space-y-8">
			<SettingsSectionNavigation
				ariaLabel="Organization settings sections"
				items={
					isOwner
						? ORGANIZATION_OWNER_SECTION_ITEMS
						: ORGANIZATION_SECTION_ITEMS
				}
			/>

			<div id="organization-profile" className="scroll-mt-24">
				<Suspense fallback={<LoadingArea className="h-24" />}>
					<OrganizationProfileForm
						organizationId={organization.id}
						defaultValues={{
							name: organization.name,
							slug: organization.slug,
							logoUrl: organization.logoUrl,
							description: organization.description,
							website: organization.metadata?.website || null,
							contactEmail: organization.metadata?.contactEmail || null,
							dispatcherHealth: organization.metadata?.dispatcherHealth,
						}}
					/>
				</Suspense>
			</div>

			<Suspense fallback={<LoadingArea className="h-24" />}>
				<OrganizationModelFallbackForm
					organizationId={organization.id}
					initialPolicy={organization.metadata?.modelFallback}
				/>
			</Suspense>

			<div id="organization-appearance" className="scroll-mt-24">
				<Suspense fallback={<LoadingArea className="h-24" />}>
					<OrganizationAppearanceForm
						organizationId={organization.id}
						initialTheme={organization.metadata?.osTheme}
					/>
				</Suspense>
			</div>

			<div id="organization-billing" className="scroll-mt-24 space-y-8">
				{canManageBilling && (
					<Link href="/admin/billing?tab=plan">
						Manage your plan in Billing
					</Link>
				)}

				{featuresQuery.isError ? (
					<LoadError
						title="Plan features could not be read"
						error={featuresQuery.error}
						onRetry={() => {
							void featuresQuery.refetch();
						}}
						retrying={featuresQuery.isFetching}
					/>
				) : featuresQuery.data ? (
					<Suspense fallback={<LoadingArea className="h-24" />}>
						<FeaturesSection features={features} />
					</Suspense>
				) : (
					<LoadingArea className="h-24" label="Loading plan features" />
				)}
			</div>

			<div id="organization-authentication" className="scroll-mt-24 space-y-8">
				<Suspense fallback={<LoadingArea className="h-24" />}>
					<AdminPortalSection
						descopeTenantId={organization.descopeTenantId}
						ssoEnabled={ssoEnabled}
					/>
				</Suspense>

				{ssoEnabled && (
					<Suspense fallback={<LoadingArea className="h-24" />}>
						<SsoSection
							organizationId={organization.id}
							descopeTenantId={organization.descopeTenantId}
						/>
					</Suspense>
				)}

				<Suspense fallback={<LoadingArea className="h-24" />}>
					<OrganizationInboundClientsSection organizationId={organization.id} />
				</Suspense>
			</div>

			{isOwner && (
				<div id="organization-delegated-approvals" className="scroll-mt-24">
					<WorkspaceAppRenderer
						manifest={{
							entry: "tedix:app/delegated-approval-settings",
							capabilities: [],
							config: { organizationId },
						}}
					/>
				</div>
			)}

			{isOwner && (
				<div id="organization-portfolio" className="scroll-mt-24">
					<WorkspaceAppRenderer
						manifest={{
							entry: "tedix:app/portfolio-settings",
							capabilities: [],
						}}
					/>
				</div>
			)}

			{isOwner && (
				<Suspense fallback={<LoadingArea className="h-24" />}>
					<div id="organization-danger" className="scroll-mt-24">
						<DangerZone
							organizationId={organization.id}
							organizationName={organization.name}
						/>
					</div>
				</Suspense>
			)}
		</div>
	);
}
