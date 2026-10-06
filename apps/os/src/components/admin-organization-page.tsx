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
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import {
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
} from "@/components/kumo/page";
import { Skeleton } from "@/components/kumo/skeleton";
import { SettingsSectionNavigation } from "@/components/settings-section-navigation";
import {
	organizationDetailQueryOptions,
	organizationFeaturesQueryOptions,
} from "@/lib/os-query-options";
import { errorMessage } from "@/lib/orpc-error";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

const OrganizationProfileForm = lazy(() =>
	import("@/components/organization-profile-form").then((mod) => ({
		default: mod.OrganizationProfileForm,
	})),
);

const OrganizationAppearanceForm = lazy(() =>
	import("@/components/organization-appearance-form").then((mod) => ({
		default: mod.OrganizationAppearanceForm,
	})),
);

const SubscriptionSection = lazy(() =>
	import("@/components/billing-subscription-section").then((mod) => ({
		default: mod.SubscriptionSection,
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
	["Danger", "organization-danger"],
] as const;

const DangerZone = lazy(() =>
	import("@/components/organization-danger-zone").then((mod) => ({
		default: mod.DangerZone,
	})),
);

function SectionSkeleton() {
	return <Skeleton className="h-24 w-full" />;
}

function OrganizationPagePending() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading organization settings"
			className="space-y-3"
		>
			{Array.from({ length: 3 }).map((_, index) => (
				<Skeleton className="h-24 w-full" key={index} />
			))}
		</div>
	);
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
				<Alert variant="destructive">
					<AlertTitle>Organization settings are unavailable</AlertTitle>
					<AlertDescription>
						{errorMessage(
							context.error,
							"The operational context read failed.",
						)}
					</AlertDescription>
				</Alert>
			) : (
				<AdminOrganizationBody
					organizationId={context.data.organization.id}
					isOwner={context.data.authority.role === "owner"}
				/>
			)}
		</Page>
	);
}

function AdminOrganizationBody({
	organizationId,
	isOwner,
}: {
	organizationId: string;
	isOwner: boolean;
}) {
	const detailQuery = useQuery(organizationDetailQueryOptions(organizationId));
	const featuresQuery = useQuery(
		organizationFeaturesQueryOptions(organizationId),
	);

	if (detailQuery.isPending) return <OrganizationPagePending />;
	if (detailQuery.isError || !detailQuery.data) {
		return (
			<Alert variant="destructive">
				<AlertTitle>The organization could not be read</AlertTitle>
				<AlertDescription>
					{errorMessage(detailQuery.error, "The organization read failed.")}
				</AlertDescription>
			</Alert>
		);
	}

	const organization = detailQuery.data;
	// Features degrade quietly: the page still renders profile, subscription,
	// and danger zone when the features read fails.
	const features: OrganizationFeatures = featuresQuery.data ?? {};
	const ssoEnabled = features.sso || false;

	return (
		<div className="space-y-6 pb-1">
			<SettingsSectionNavigation
				ariaLabel="Organization settings sections"
				items={
					isOwner
						? ORGANIZATION_OWNER_SECTION_ITEMS
						: ORGANIZATION_SECTION_ITEMS
				}
			/>

			<div id="organization-profile" className="scroll-mt-24">
				<Suspense fallback={<SectionSkeleton />}>
					<OrganizationProfileForm
						organizationId={organization.id}
						defaultValues={{
							name: organization.name,
							slug: organization.slug,
							logoUrl: organization.logoUrl,
							description: organization.description,
							website: organization.metadata?.website || null,
							contactEmail: organization.metadata?.contactEmail || null,
						}}
					/>
				</Suspense>
			</div>

			<div id="organization-appearance" className="scroll-mt-24">
				<Suspense fallback={<SectionSkeleton />}>
					<OrganizationAppearanceForm
						organizationId={organization.id}
						initialTheme={organization.metadata?.osTheme}
					/>
				</Suspense>
			</div>

			<div id="organization-billing" className="scroll-mt-24 space-y-6">
				<Suspense fallback={<SectionSkeleton />}>
					<SubscriptionSection />
				</Suspense>

				{featuresQuery.isError ? (
					<Alert variant="destructive">
						<AlertTitle>Plan features could not be read</AlertTitle>
						<AlertDescription>
							{errorMessage(featuresQuery.error, "The features read failed.")}
						</AlertDescription>
					</Alert>
				) : featuresQuery.data ? (
					<Suspense fallback={<SectionSkeleton />}>
						<FeaturesSection features={features} />
					</Suspense>
				) : (
					<SectionSkeleton />
				)}
			</div>

			<div id="organization-authentication" className="scroll-mt-24 space-y-6">
				<Suspense fallback={<SectionSkeleton />}>
					<AdminPortalSection
						descopeTenantId={organization.descopeTenantId}
						ssoEnabled={ssoEnabled}
					/>
				</Suspense>

				{ssoEnabled && (
					<Suspense fallback={<SectionSkeleton />}>
						<SsoSection
							organizationId={organization.id}
							descopeTenantId={organization.descopeTenantId}
						/>
					</Suspense>
				)}
			</div>

			{isOwner && (
				<Suspense fallback={<SectionSkeleton />}>
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
