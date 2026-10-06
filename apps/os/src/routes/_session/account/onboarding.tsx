import { createFileRoute, Navigate } from "@tanstack/react-router";
import { resolveOsTenant } from "@/shared/os-tenant";
import { OrganizationOnboardingForm } from "@/account/organization-launcher-page";
import { useOsOnboardingState } from "@/account/use-os-onboarding-state";
import { useDocumentTitle } from "@/lib/use-document-title";
import { useOsIdentity } from "@/lib/use-os-identity";
import { TedixBrandMark } from "@/shared/tedix-brand";

// First-class first-run naming. Reached only when the caller has no provisioned
// OS membership yet but owns a bootstrapped organization; anyone already
// onboarded is bounced back to the picker so this URL never strands a member.
export const Route = createFileRoute("/_session/account/onboarding")({
	validateSearch: (search: Record<string, unknown>) => ({
		new:
			search.new === true || search.new === "1" || search.new === 1
				? (true as const)
				: undefined,
	}),
	component: AccountOnboardingRoute,
});

function AccountOnboardingRoute() {
	const { new: createNew } = Route.useSearch();
	useDocumentTitle(
		createNew
			? "Create a workspace · Tedix OS"
			: "Set up your workspace · Tedix OS",
	);
	const tenant = resolveOsTenant(window.location.hostname);
	const localEvaluation = tenant.kind === "local";
	const identity = useOsIdentity();
	const { items, onboardingOwner, isLoading } = useOsOnboardingState();

	// An already-onboarded member creating an additional workspace: the form
	// creates the organization itself, so no bootstrap state is needed and the
	// member bounce below must not apply.
	if (createNew && !localEvaluation) {
		return (
			<OrganizationOnboardingForm
				organization={null}
				email={identity.email}
				localEvaluation={false}
			/>
		);
	}

	if (isLoading) {
		return (
			<main className="org-launcher">
				<section className="org-launcher-card" aria-busy="true">
					<TedixBrandMark />
					<p>Preparing your workspace…</p>
				</section>
			</main>
		);
	}
	if (items.length > 0 || !onboardingOwner) {
		return <Navigate to="/account/organizations" replace />;
	}
	return (
		<OrganizationOnboardingForm
			organization={{
				id: onboardingOwner.organizationId,
				name: onboardingOwner.organizationName,
				slug: onboardingOwner.organizationSlug,
			}}
			email={identity.email}
			localEvaluation={localEvaluation}
		/>
	);
}
