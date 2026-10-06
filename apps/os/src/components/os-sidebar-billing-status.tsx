import { useQuery } from "@tanstack/react-query";
import { Coins } from "@phosphor-icons/react";
import { hasUnlimitedTokenUsage } from "@/lib/billing-display";
import { billingOverviewQueryOptions } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import {
	SidebarMenu,
	SidebarMenuButton,
	useSidebar,
} from "@/components/kumo/sidebar";

const usd = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});

/** Billing amounts are owner-only; other members never request this endpoint. */
export function OsSidebarBillingStatus() {
	const { state } = useSidebar();
	const context = useOsOperationalContext();
	const canManageBilling =
		context.data?.authority.permissions.includes("billing:manage") ?? false;
	const overview = useQuery({
		...billingOverviewQueryOptions(),
		enabled: canManageBilling,
		staleTime: 30_000,
		refetchInterval: canManageBilling ? 60_000 : false,
	});

	if (!canManageBilling) return null;
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

	const snapshot = overview.data?.snapshot;
	const plan = overview.data?.plan;
	const unlimited =
		snapshot && plan ? hasUnlimitedTokenUsage(snapshot, plan) : false;
	const remaining = snapshot
		? unlimited
			? "Unlimited tokens"
			: `${snapshot.remainingIncludedTokens.toLocaleString()} included tokens left`
		: overview.isError
			? "Balance unavailable"
			: "Loading balance…";

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
					{snapshot?.planKey === "enterprise" ? "Manage" : "Upgrade"}
				</a>
			</div>
			<p className="mt-1 font-semibold type-tedix-label" aria-live="polite">
				{remaining}
			</p>
			{snapshot ? (
				<p className="mt-0.5 text-kumo-subtle type-tedix-caption">
					{usd.format(snapshot.availableCreditMicros / 1_000_000)} credit
					available
				</p>
			) : null}
		</div>
	);
}
