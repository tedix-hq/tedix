/**
 * Billing › Usage: the plan, credits this month, usage by tedi and member
 * with their caps, and credit packs to buy. Everything is in Tedix credits
 * (1 credit = €0.01) and every limit is monthly.
 */

import { useQuery } from "@tanstack/react-query";
import { LoadError } from "@/components/kumo/alert";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import { BillingCreditCaps } from "@/components/billing-credit-caps";
import { BillingCreditUsage } from "@/components/billing-credit-usage";
import { BillingPlanStatus } from "@/components/billing-plan-status";
import { BillingTopUpSection } from "@/components/billing-top-up-section";
import { billingOverviewQueryOptions } from "@/lib/os-query-options";

export function BillingUsageOverview() {
	const overviewQuery = useQuery({
		...billingOverviewQueryOptions(),
		staleTime: 30_000,
		refetchInterval: 60_000,
	});

	if (overviewQuery.isPending) {
		return (
			<div className="space-y-4" aria-busy="true" aria-label="Loading usage">
				<Skeleton className="h-24 w-full" />
				<Skeleton className="h-64 w-full" />
			</div>
		);
	}

	if (overviewQuery.isError) {
		return (
			<LoadError
				title="Billing usage could not be read"
				error={overviewQuery.error}
				onRetry={() => {
					void overviewQuery.refetch();
				}}
				retrying={overviewQuery.isFetching}
			/>
		);
	}

	const overview = overviewQuery.data;
	const isTest = overview.stripeEnvironment === "test";
	return (
		<div className="space-y-8">
			<BillingPlanStatus overview={overview} />
			<BillingCreditUsage credits={overview.credits} />
			<BillingCreditCaps credits={overview.credits} />
			<BillingTopUpSection isTest={isTest} />
			{isTest && (
				<Text role="label" tone="secondary">
					Billing test mode · payments and invoices use test data. Credits used
					by your tedis are real usage records.
				</Text>
			)}
		</div>
	);
}
