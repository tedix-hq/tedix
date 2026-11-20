/**
 * Credit packs: one-time purchases that add credits on top of the plan.
 * Unused pack credits last 12 months and are used after the plan's included
 * credits. Checkout is Stripe-hosted and returns to /admin/billing with
 * `?checkout=topup-success|topup-cancelled`.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUpRight } from "@phosphor-icons/react";
import { LoadingArea } from "@/components/loading-area";
import { BillingSectionHeader } from "@/components/billing-section-header";
import { LoadError, Alert, AlertDescription } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	SettingsSection,
	SettingsSectionContent,
} from "@/components/kumo/page";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { type CreditTopUpPack, formatCredits } from "@/lib/billing-credits";
import { formatBillingAmount } from "@/lib/billing-price";
import { errorMessage } from "@/lib/orpc-error";
import { billingTopUpPacksQueryOptions } from "@/lib/os-query-options";

function topUpReturnUrl(state: "topup-success" | "topup-cancelled") {
	return `${window.location.origin}/admin/billing?checkout=${state}`;
}

export function BillingTopUpSection({ isTest }: { isTest: boolean }) {
	const packsQuery = useQuery(billingTopUpPacksQueryOptions());
	const checkoutMutation = useMutation({
		mutationFn: (packKey: string) =>
			osApi.billing.createTopUpCheckout({
				packKey,
				successUrl: topUpReturnUrl("topup-success"),
				cancelUrl: topUpReturnUrl("topup-cancelled"),
			}),
		onSuccess: (data) => {
			window.location.href = data.checkoutUrl;
		},
	});

	return (
		<SettingsSection>
			<BillingSectionHeader
				title="Buy credit packs"
				description="Add credits whenever you need more. Pack credits are used after your plan's monthly credits and last 12 months."
				actions={isTest && <Badge variant="secondary">Billing test mode</Badge>}
			/>
			<SettingsSectionContent className="space-y-4">
				{packsQuery.isPending ? (
					<LoadingArea className="h-28" label="Loading credit packs" />
				) : packsQuery.isError ? (
					<LoadError
						title="Credit packs are unavailable"
						error={packsQuery.error}
						onRetry={() => {
							void packsQuery.refetch();
						}}
						retrying={packsQuery.isFetching}
					/>
				) : packsQuery.data.length === 0 ? (
					<Text tone="secondary">No credit packs are on sale right now.</Text>
				) : (
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
						{packsQuery.data.map((pack: CreditTopUpPack) => (
							<Surface className="flex flex-col p-4" key={pack.packKey}>
								<Text weight="medium">{formatCredits(pack.credits)}</Text>
								<Text role="label" tone="secondary" className="mt-1">
									Valid for {pack.validMonths} months
								</Text>
								<Button
									loading={
										checkoutMutation.isPending &&
										checkoutMutation.variables === pack.packKey
									}
									icon={<ArrowUpRight size={16} />}
									className="mt-4 w-full"
									disabled={checkoutMutation.isPending}
									onClick={() => checkoutMutation.mutate(pack.packKey)}
									variant="outline"
								>
									{isTest ? "Test purchase" : "Buy"} ·{" "}
									{formatBillingAmount(pack.priceMicros, pack.currency)}
								</Button>
							</Surface>
						))}
					</div>
				)}
				{isTest && (
					<Text role="label" tone="secondary">
						Test purchases add test credits only. No real payment is taken.
					</Text>
				)}
				{checkoutMutation.isError && (
					<Alert variant="destructive">
						<AlertDescription>
							{errorMessage(
								checkoutMutation.error,
								"Checkout for the credit pack could not start",
							)}
						</AlertDescription>
					</Alert>
				)}
			</SettingsSectionContent>
		</SettingsSection>
	);
}
