import { useQuery } from "@tanstack/react-query";
import {
	allMyOrganizationsQueryOptions,
	myOrganizationBootstrapQueryOptions,
	osOrganizationsQueryOptions,
} from "@/account/query-options";

export interface OsOnboardingMembership {
	member: { role?: string | null };
	organizationId: string;
	organizationName: string;
	organizationSlug: string;
	organizationType: string;
}

export function selectOsOnboardingOwner(
	memberships: readonly OsOnboardingMembership[],
): OsOnboardingMembership | undefined {
	return (
		memberships.find(
			(membership) =>
				membership.member.role === "owner" &&
				membership.organizationType === "personal",
		) ?? memberships.find((membership) => membership.member.role === "owner")
	);
}

/**
 * Resolve the one first-run state shared by the apex launcher and focused
 * browser handshakes such as `tedix login`.
 *
 * A provisioned OS membership means onboarding is already complete.
 * Otherwise the canonical bootstrap creates/repairs the caller's personal
 * organization and D1 membership before the owner is offered the naming form.
 */
export function useOsOnboardingState({ enabled = true } = {}) {
	const organizations = useQuery({
		...osOrganizationsQueryOptions(),
		enabled,
	});
	const items = organizations.data?.data ?? [];
	const bootstrap = useQuery({
		...myOrganizationBootstrapQueryOptions(),
		enabled: enabled && organizations.isSuccess && items.length === 0,
		retry: false,
	});
	const memberships = useQuery({
		...allMyOrganizationsQueryOptions(),
		enabled: enabled && items.length === 0 && bootstrap.isSuccess,
		retry: false,
	});
	const onboardingOwner = selectOsOnboardingOwner(memberships.data?.data ?? []);
	const isLoading =
		enabled &&
		(organizations.isLoading ||
			(organizations.isSuccess && items.length === 0 && bootstrap.isLoading) ||
			(items.length === 0 && bootstrap.isSuccess && memberships.isLoading));
	const error =
		organizations.error ?? bootstrap.error ?? memberships.error ?? null;
	const isReady =
		enabled &&
		organizations.isSuccess &&
		!isLoading &&
		!error &&
		(items.length > 0 ||
			(bootstrap.isSuccess && memberships.isSuccess && !onboardingOwner));

	return {
		organizations,
		items,
		onboardingOwner,
		isLoading,
		error,
		isReady,
		/** Re-run every launcher read after a failed load (disabled reads no-op). */
		refetch: () => {
			void organizations.refetch();
			void bootstrap.refetch();
			void memberships.refetch();
		},
	};
}
