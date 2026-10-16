import { useQuery } from "@tanstack/react-query";
import { Coins } from "@phosphor-icons/react";
import {
	formatUsageCredits,
	formatCreditWorth,
} from "@/lib/billing-credit-display";
import {
	billingNeedsAttention,
	hasUnlimitedTokenUsage,
} from "@/lib/billing-display";
import { isLocalSession } from "@/lib/local-inference";
import { billingOverviewQueryOptions } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import {
	SidebarMenu,
	SidebarMenuButton,
	useSidebar,
} from "@/components/kumo/sidebar";

/**
 * Billing amounts are owner-only; other members never request this endpoint.
 * Local sessions (`bun run-local`) have no billing, so nothing is shown.
 */
export function OsSidebarBillingStatus() {
	const { state } = useSidebar();
	const context = useOsOperationalContext();
	const canManageBilling =
		!isLocalSession() &&
		(context.data?.authority.permissions.includes("billing:manage") ?? false);
	const overview = useQuery({
		...billingOverviewQueryOptions(),
		enabled: canManageBilling,
		staleTime: 30_000,
		refetchInterval: canManageBilling ? 60_000 : false,
	});

	if (!canManageBilling) return null;
	// A healthy balance lives in Organization settings → Billing; the sidebar
	// only carries it while it needs the owner's attention.
	if (!overview.data || !billingNeedsAttention(overview.data)) return null;
	if (state === "collapsed") {
		return (
			<SidebarMenu aria-label="Billing" className="w-full">
				<SidebarMenuButton
					aria-label="Billing and usage"
					href="/admin/billing"
					icon={Coins}
					tooltip="Billing and usage"
				>
					Billing and usage
				</SidebarMenuButton>
			</SidebarMenu>
		);
	}

	const { snapshot, plan, credits } = overview.data;
	const unlimited = hasUnlimitedTokenUsage(snapshot, plan);
	const monetary = credits?.billingMode === "monetary";
	const remaining =
		monetary && credits
			? `${formatUsageCredits(credits.availableMicros, credits.creditValueMicros)} available`
			: unlimited
				? "Unlimited tokens"
				: `${snapshot.remainingIncludedTokens.toLocaleString()} included tokens left`;

	return (
		<div className="w-full rounded-lg border border-kumo-hairline bg-kumo-base px-3 py-2.5">
			<div className="flex items-center justify-between gap-2">
				<span className="text-kumo-subtle type-tedix-caption">
					Plan balance
				</span>
				<a
					className="text-kumo-brand type-tedix-caption font-medium underline underline-offset-2"
					href={
						snapshot?.planKey === "enterprise"
							? "/admin/billing"
							: "/admin/billing?section=subscription"
					}
				>
					{monetary || snapshot?.planKey === "enterprise"
						? "Manage"
						: "Upgrade"}
				</a>
			</div>
			<p className="mt-1 font-semibold type-tedix-label" aria-live="polite">
				{remaining}
			</p>
			<p className="mt-0.5 text-kumo-subtle type-tedix-caption">
				{monetary && credits
					? `${formatCreditWorth(credits.availableMicros, credits.currency)} usage value`
					: `${formatCreditWorth(snapshot.availableCreditMicros, plan.currency)} credit available`}
			</p>
		</div>
	);
}
