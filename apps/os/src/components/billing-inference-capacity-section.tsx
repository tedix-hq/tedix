import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Gauge } from "@phosphor-icons/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Loader } from "@/components/kumo/loader";
import {
	SectionHeader,
	SectionDescription,
	SectionHeading,
	SectionTitle,
	SettingsSection,
	SettingsSectionContent,
} from "@/components/kumo/page";
import { Progress } from "@/components/kumo/progress";
import { Skeleton } from "@/components/kumo/skeleton";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { formatBillingAmount } from "@/lib/billing-price";
import {
	billingOverviewQueryOptions,
	providerCapacitySponsorshipsQueryOptions,
} from "@/lib/os-query-options";

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
	return value.toLocaleString();
}

function capacityReturnUrl(state: "topup-success" | "topup-cancelled") {
	return `${window.location.origin}/admin/billing?checkout=${state}`;
}

export function BillingInferenceCapacitySection() {
	const queryClient = useQueryClient();
	const overviewQuery = useQuery(billingOverviewQueryOptions());
	const sponsorshipsQuery = useQuery(
		providerCapacitySponsorshipsQueryOptions(),
	);
	const checkoutMutation = useMutation({
		mutationFn: (packKey: string) =>
			osApi.billing.createInferenceCapacityCheckout({
				packKey,
				successUrl: capacityReturnUrl("topup-success"),
				cancelUrl: capacityReturnUrl("topup-cancelled"),
			}),
		onSuccess: (data) => {
			window.location.href = data.checkoutUrl;
		},
	});
	const sponsorshipMutation = useMutation({
		mutationFn: (input: {
			installationId: string;
			enabled: boolean;
			policy: NonNullable<
				typeof sponsorshipsQuery.data
			>["data"][number]["policy"];
		}) =>
			osApi.billing.setProviderCapacitySponsorship({
				installationId: input.installationId,
				policy: input.policy
					? { ...input.policy, enabled: input.enabled }
					: {
							enabled: input.enabled,
							budgetRevision: 1,
							maxTransfersPerBudgetDay: 1,
							lowWatermarkTokens: 250_000,
							lowWatermarkSpendMicros: 1_000_000,
							transferTokens: 1_000_000,
							transferSpendMicros: 5_000_000,
						},
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: providerCapacitySponsorshipsQueryOptions().queryKey,
			});
		},
	});

	if (overviewQuery.isPending) {
		return <Skeleton className="h-48 w-full" />;
	}
	if (overviewQuery.isError) {
		return (
			<Alert variant="destructive">
				<AlertTitle>Inference capacity is unavailable</AlertTitle>
				<AlertDescription>
					The inference admission status could not be read.
				</AlertDescription>
			</Alert>
		);
	}

	const capacity = overviewQuery.data.inferenceCapacity;
	// The backend is the authority on whether this account uses monthly metering;
	// provider-sponsored customers retain their daily grant controls.
	const monthlyMetered =
		"monthlyMetered" in capacity && capacity.monthlyMetered === true;
	const blockingReason: string | null = capacity.blockingReason;
	// Keep the daily controls available if an older API revision still reports a
	// daily block during rollout. The API is deployed before this OS change.
	const showDailyCapacity =
		!monthlyMetered || blockingReason === "inference_capacity_exhausted";
	const packs = capacity.packs;
	const allocations = capacity.allocations;
	const overflow = capacity.tediOverflow.filter(
		(row) => row.overflowTokens > 0 || row.overflowSpendMicros > 0,
	);
	const tokenTotal = capacity.baseDailyTokenLimit + capacity.allocatedTokens;
	const spendTotal =
		capacity.baseDailySpendLimitMicros === null
			? null
			: capacity.baseDailySpendLimitMicros +
				capacity.allocatedSpendCapacityMicros;
	const isTest = overviewQuery.data.stripeEnvironment === "test";
	const expiresAt = new Date(capacity.expiresAt).toLocaleString(undefined, {
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	});

	return (
		<SettingsSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>
						{showDailyCapacity
							? "Daily inference capacity"
							: "Inference status"}
					</SectionTitle>
					<SectionDescription>
						{showDailyCapacity
							? "The tokens and provider spend available for your organization today."
							: capacity.available
								? "Your active plan allows monthly usage with overage; charges appear in the billing summary above."
								: "Inference is blocked; review the reason below."}
					</SectionDescription>
				</SectionHeading>
				{isTest && <Badge variant="secondary">Stripe test mode</Badge>}
			</SectionHeader>
			<SettingsSectionContent className="space-y-4">
				{!capacity.available && (
					<Alert variant="destructive">
						<AlertTitle>Inference is currently blocked</AlertTitle>
						<AlertDescription>
							{blockingReason === "hard_spend_limit"
								? "The organization hard spend limit is reached. Ask your billing operator to raise it, or wait for the next billing period."
								: blockingReason === "billing_period_inactive"
									? "No active billing period is available. Renew the subscription below, or ask your billing operator to restore the period."
									: capacity.unblockAction === "top_up"
										? "Add capacity below to resume inference immediately."
										: capacity.unblockAction === "upgrade"
											? "Upgrade the plan to restore monthly inference allowance."
											: "Open billing management to restore the subscription or payment method."}
						</AlertDescription>
					</Alert>
				)}
				<div
					className={showDailyCapacity ? "grid gap-4 sm:grid-cols-2" : "hidden"}
				>
					<Surface className="space-y-3 p-4">
						<div className="flex items-center gap-2">
							<Text
								as="span"
								weight="medium"
								className="flex items-center gap-2"
							>
								<Gauge className="size-4" aria-hidden /> Tokens today
							</Text>
						</div>
						<div>
							<Text
								as="span"
								role="metric"
								weight="semibold"
								className="tabular-nums"
							>
								{formatTokens(capacity.remainingTokens)}
							</Text>
							<Text as="span" tone="secondary">
								{" "}
								remaining
							</Text>
						</div>
						<Progress
							value={
								tokenTotal > 0 ? (capacity.usedTokens / tokenTotal) * 100 : 0
							}
						/>
						<Text role="label" tone="secondary">
							{formatTokens(capacity.baseDailyTokenLimit)} base +{" "}
							{formatTokens(capacity.allocatedTokens)} allocated
						</Text>
						{/* A provider's own headroom is spent by the customers it sponsors.
						    Without this the allocation is an unexplained negative number,
						    and the provider only learns what it means when its own tedis
						    stop. */}
						{capacity.sponsoredTokens < 0 ? (
							<Text role="label" tone="secondary">
								{formatTokens(Math.abs(capacity.sponsoredTokens))} of that is
								capacity you sponsor for embedded customers
							</Text>
						) : null}
					</Surface>
					<Surface className="space-y-3 p-4">
						<div className="flex items-center gap-2">
							<Text as="span" weight="medium">
								Spend capacity today
							</Text>
						</div>
						<div>
							<Text
								as="span"
								role="metric"
								weight="semibold"
								className="tabular-nums"
							>
								{capacity.remainingSpendMicros === null
									? "Unlimited"
									: formatBillingAmount(capacity.remainingSpendMicros, "usd")}
							</Text>
							{capacity.remainingSpendMicros !== null && (
								<Text as="span" tone="secondary">
									{" "}
									remaining
								</Text>
							)}
						</div>
						<Progress
							value={
								spendTotal !== null && spendTotal > 0
									? (capacity.usedSpendMicros / spendTotal) * 100
									: 0
							}
						/>
						<Text role="label" tone="secondary">
							{capacity.baseDailySpendLimitMicros === null
								? "Unlimited base"
								: `${formatBillingAmount(capacity.baseDailySpendLimitMicros, "usd")} base`}{" "}
							+{" "}
							{formatBillingAmount(
								capacity.allocatedSpendCapacityMicros,
								"usd",
							)}{" "}
							allocated
						</Text>
					</Surface>
				</div>

				<Text
					role="label"
					tone="secondary"
					className={showDailyCapacity ? undefined : "hidden"}
				>
					Organization capacity for {capacity.budgetDay}. Purchased capacity
					expires with this budget day at {expiresAt}. Explicit per-tedi limits
					still apply where configured.
					{isTest ? " Test purchases allocate test-mode capacity only." : ""}
				</Text>

				{showDailyCapacity && packs.length > 0 && (
					<div className="space-y-3">
						<div>
							<Text weight="medium">Add capacity for today</Text>
							<Text role="label" tone="secondary">
								Purchased capacity is available immediately and expires at the
								end of this budget day.
							</Text>
						</div>
						<div className="grid gap-3 sm:grid-cols-3">
							{packs.map((pack) => (
								<Surface className="flex flex-col p-4" key={pack.packKey}>
									<Text weight="medium">{pack.name}</Text>
									<Text role="label" tone="secondary" className="mt-1">
										{formatTokens(pack.tokens)} tokens +{" "}
										{formatBillingAmount(
											pack.spendCapacityMicros,
											pack.currency,
										)}{" "}
										spend capacity
									</Text>
									<Button
										className="mt-4 w-full"
										disabled={checkoutMutation.isPending}
										onClick={() => checkoutMutation.mutate(pack.packKey)}
										variant="outline"
									>
										{checkoutMutation.isPending &&
										checkoutMutation.variables === pack.packKey ? (
											<Loader
												aria-label="Starting checkout"
												className="mr-2"
												size={16}
											/>
										) : (
											<ArrowUpRight className="mr-2 size-4" />
										)}
										{isTest ? "Test top-up" : "Buy capacity"} ·{" "}
										{formatBillingAmount(pack.priceMicros, pack.currency)}
									</Button>
								</Surface>
							))}
						</div>
					</div>
				)}

				{sponsorshipsQuery.data && sponsorshipsQuery.data.data.length > 0 && (
					<div className="space-y-3">
						<div>
							<Text weight="medium">Customer capacity sponsorship</Text>
							<Text role="label" tone="secondary">
								Automatically move capacity from this organization to connected
								customer tenants when they run low. Customers never need to buy
								or manage capacity themselves.
							</Text>
						</div>
						{sponsorshipsQuery.data.data.map((sponsorship) => {
							const enabled = sponsorship.policy?.enabled === true;
							const pending =
								sponsorshipMutation.isPending &&
								sponsorshipMutation.variables?.installationId ===
									sponsorship.installationId;
							return (
								<Surface
									className="flex flex-wrap items-center justify-between gap-3 p-4"
									key={sponsorship.installationId}
								>
									<div>
										<div className="flex items-center gap-2">
											<Text weight="medium">
												Tenant {sponsorship.externalTenantId}
											</Text>
											<Badge variant={enabled ? "secondary" : "outline"}>
												{enabled ? "Automatic" : "Not sponsored"}
											</Badge>
										</div>
										<Text role="label" tone="secondary">
											{enabled
												? "Adds 1M tokens and $5 when remaining capacity falls below the safety threshold."
												: "No capacity moves to this customer until sponsorship is enabled."}
										</Text>
									</div>
									<Button
										disabled={pending}
										onClick={() =>
											sponsorshipMutation.mutate({
												installationId: sponsorship.installationId,
												enabled: !enabled,
												policy: sponsorship.policy,
											})
										}
										variant={enabled ? "outline" : "default"}
									>
										{pending && <Loader className="mr-2" size={16} />}
										{enabled ? "Disable sponsorship" : "Enable sponsorship"}
									</Button>
								</Surface>
							);
						})}
					</div>
				)}

				<Surface as="details" className="p-4">
					<summary className="cursor-pointer list-none">
						<div className="flex items-center justify-between gap-3">
							<div>
								<Text weight="medium">Capacity history</Text>
								<Text role="label" tone="secondary">
									{allocations.length} allocation
									{allocations.length === 1 ? "" : "s"} recorded
								</Text>
							</div>
							<Badge variant="outline">View ledger</Badge>
						</div>
					</summary>
					<div className="mt-4 space-y-3 border-kumo-line border-t pt-4">
						{allocations.length === 0 ? (
							<Text tone="secondary">No capacity allocations recorded.</Text>
						) : (
							allocations.map((allocation) => (
								<Surface
									className="flex flex-wrap items-center justify-between gap-3 p-3"
									key={allocation.id}
								>
									<div>
										<Text weight="medium">
											{allocation.packName ?? allocation.sourceType}
										</Text>
										<Text role="label" tone="secondary">
											{allocation.stripeEnvironment} allocation
										</Text>
									</div>
									<div className="text-right text-sm">
										<Badge
											variant={
												allocation.state === "active" ? "secondary" : "outline"
											}
										>
											{allocation.state}
										</Badge>
										<Text role="label" tone="secondary" className="mt-1">
											{allocation.tokenAmount.toLocaleString()} tokens ·{" "}
											{formatBillingAmount(allocation.spendAmountMicros, "usd")}
										</Text>
									</div>
								</Surface>
							))
						)}
					</div>
				</Surface>

				{showDailyCapacity && overflow.length > 0 && (
					<div className="space-y-2">
						<Text weight="medium">Per-tedi overflow today</Text>
						{overflow.map((row) => (
							<Surface
								className="flex items-center justify-between p-3 text-sm"
								key={row.tediId}
							>
								<span>{row.displayName}</span>
								<Text as="span" tone="secondary">
									+{row.overflowTokens.toLocaleString()} tokens · +
									{formatBillingAmount(row.overflowSpendMicros, "usd")}
								</Text>
							</Surface>
						))}
						<Text role="label" tone="secondary">
							Overflow is derived against each tedi&apos;s base ceiling; pooled
							top-up capacity is not assigned to individual debits.
						</Text>
					</div>
				)}
				{checkoutMutation.isError && (
					<Text tone="error">
						{checkoutMutation.error instanceof Error
							? checkoutMutation.error.message
							: "Failed to start capacity checkout"}
					</Text>
				)}
			</SettingsSectionContent>
		</SettingsSection>
	);
}
