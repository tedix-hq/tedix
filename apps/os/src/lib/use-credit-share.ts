import { useQuery } from "@tanstack/react-query";
import { type AllowanceUsage, allowanceShare } from "@/lib/billing-credits";
import { isLocalSession } from "@/lib/local-inference";
import { billingOverviewQueryOptions } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";

/**
 * A part of this month's usage (one run, one conversation) as a share of the
 * organization's monthly credits. Outside Billing › Usage, usage shows as a
 * percentage, never a credit count. Null while the monthly total is unknown
 * or the viewer cannot read billing, so callers omit the figure.
 */
export function useCreditShare(
	credits: number | null | undefined,
): AllowanceUsage | null {
	const context = useOsOperationalContext();
	// Authority can be missing while the context is still partial.
	const permissions = context.data?.authority?.permissions;
	const canReadBilling =
		!isLocalSession() &&
		(permissions?.includes("billing:read") ||
			permissions?.includes("billing:manage") ||
			false);
	const overview = useQuery({
		...billingOverviewQueryOptions(),
		enabled: canReadBilling && credits != null,
		staleTime: 30_000,
	});
	const monthly = overview.data?.credits;
	if (credits == null || !monthly) return null;
	return allowanceShare(monthly, credits);
}
