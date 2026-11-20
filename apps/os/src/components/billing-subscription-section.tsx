/**
 * Subscription and billing section, shared by the organization settings page
 * and the billing surface — both mount this
 * one component and read current entitlement state through canonical
 * `billing.getOverview`; `billing.listPlans` supplies checkout choices only.
 *
 * Checkout and portal are Stripe-hosted: both mutations end in a full-page
 * `window.location` handoff, so there is nothing to invalidate here. Both
 * flows return to `/admin/billing` on THIS tenant origin — the explicit
 * successUrl/cancelUrl/returnUrl below override the server default (which
 * points at the same route but cannot know which OS hostname the operator is
 * on), and `?checkout=success|cancelled` drives the return handshake in
 * `admin-billing-page.tsx` (invalidate + notice).
 */

import { errorMessage } from "@/lib/orpc-error";
import { LoadingArea } from "@/components/loading-area";
import { BillingSectionHeader } from "@/components/billing-section-header";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, FileText, Info, Sparkle } from "@phosphor-icons/react";
import {
	LoadError,
	Alert,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	SettingsSection,
	SettingsSectionContent,
} from "@/components/kumo/page";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	type CreditPlan,
	creditsInEuros,
	formatCredits,
} from "@/lib/billing-credits";
import { formatBillingAmount } from "@/lib/billing-price";
import {
	billingOverviewQueryOptions,
	billingPlansQueryOptions,
} from "@/lib/os-query-options";

/**
 * Stripe return destination on the CURRENT tenant origin. Built from
 * `window.location.origin`, not a configured base URL: every `{slug}.os`
 * hostname serves this SPA and the flow must land back on the org it left.
 */
function billingReturnUrl(
	state?: "success" | "cancelled",
	section: "subscription" | "invoices" = "subscription",
): string {
	const search = new URLSearchParams({ section });
	if (state) search.set("checkout", state);
	return `${window.location.origin}/admin/billing?${search.toString()}`;
}

/** What a plan card lists, in plain words. */
export function planCardFeatures(plan: CreditPlan): string[] {
	if (plan.key === "enterprise") {
		return [
			`${formatCredits(plan.includedCredits)} a month by default`,
			"Monthly credits set in your contract",
			"Credit packs and pay-as-you-go available",
		];
	}
	return [
		`${formatCredits(plan.includedCredits)} a month (worth ${creditsInEuros(plan.includedCredits)})`,
		"Unused included credits do not carry over",
		plan.priceMicros === 0
			? "Credit packs available"
			: "Credit packs and pay-as-you-go available",
	];
}

function planPriceLabel(plan: CreditPlan): string {
	if (plan.priceMicros === 0) return "Free";
	const amount = formatBillingAmount(plan.priceMicros, plan.currency);
	return plan.key === "enterprise" ? `From ${amount}` : amount;
}

export function SubscriptionSection() {
	const plansQuery = useQuery(billingPlansQueryOptions());
	const overviewQuery = useQuery(billingOverviewQueryOptions());

	const checkoutMutation = useMutation({
		mutationFn: (selectedTier: "growth" | "business" | "enterprise") =>
			osApi.billing.createCheckout({
				tier: selectedTier,
				interval: "month",
				successUrl: billingReturnUrl("success"),
				cancelUrl: billingReturnUrl("cancelled"),
			}),
		onSuccess: (data) => {
			window.location.href = data.checkoutUrl;
		},
	});

	if (plansQuery.isPending || overviewQuery.isPending) {
		return (
			<SettingsSection>
				<BillingSectionHeader title="Plan &amp; billing" />
				<SettingsSectionContent>
					<LoadingArea className="h-24" label="Loading plan" />
				</SettingsSectionContent>
			</SettingsSection>
		);
	}

	if (
		plansQuery.isError ||
		overviewQuery.isError ||
		!plansQuery.data ||
		!overviewQuery.data
	) {
		return (
			<SettingsSection>
				<BillingSectionHeader title="Plan &amp; billing" />
				<SettingsSectionContent>
					<LoadError
						title="Billing is unavailable"
						error={plansQuery.error ?? overviewQuery.error}
						onRetry={() => {
							void plansQuery.refetch();
							void overviewQuery.refetch();
						}}
						retrying={plansQuery.isFetching || overviewQuery.isFetching}
					/>
				</SettingsSectionContent>
			</SettingsSection>
		);
	}

	const plans: CreditPlan[] = plansQuery.data;
	const overview = overviewQuery.data;
	const isStripeTestMode = overview.stripeEnvironment === "test";
	const tier = overview.plan.key;
	const status = overview.account.status;

	return (
		<SettingsSection>
			<BillingSectionHeader
				title="Plan &amp; billing"
				description="Each plan includes a number of Tedix credits every month. 1 credit = €0.01."
			/>
			<SettingsSectionContent className="space-y-6">
				{isStripeTestMode && (
					<Alert>
						<Info aria-hidden />
						<AlertTitle>Billing test mode</AlertTitle>
						<AlertDescription>
							Checkout, subscriptions, invoices, and the billing portal use test
							data. No real payment method will be charged. Credits used by your
							tedis are real usage records.
						</AlertDescription>
					</Alert>
				)}

				{(status === "trial" ||
					status === "suspended" ||
					status === "past_due" ||
					tier === "starter") && (
					<div className="space-y-4">
						<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
							{plans.map((plan) => {
								const isCurrent = plan.key === tier;
								const popular = plan.key === "business";
								const paidKey = plan.key === "starter" ? null : plan.key;
								return (
									<Surface
										key={plan.key}
										data-plan={plan.key}
										className={`relative p-4 ${
											popular ? "border-kumo-brand ring-1 ring-kumo-brand" : ""
										}`}
									>
										{popular && (
											<div className="-top-2.5 -translate-x-1/2 absolute left-1/2">
												<Badge variant="default" className="gap-1">
													<Sparkle className="h-3 w-3" />
													Popular
												</Badge>
											</div>
										)}
										<div className="mb-3">
											<Text
												as="h3"
												role="section"
												weight="semibold"
												className="m-0"
											>
												{plan.name}
											</Text>
											<div className="mt-1">
												<Text as="span" role="metric" weight="semibold">
													{planPriceLabel(plan)}
												</Text>
												{plan.priceMicros > 0 && (
													<Text as="span" tone="secondary">
														/month
													</Text>
												)}
											</div>
										</div>
										{/* `ul` is not a supported Text `as` element, and the
										checkmark span depends on the same ambient text-sm as the
										feature text, so this size/color cascade is left as raw
										utilities. */}
										<ul className="mb-4 space-y-1.5 text-sm">
											{planCardFeatures(plan).map((f) => (
												<li key={f} className="flex items-start gap-2">
													<span className="mt-0.5 text-kumo-success">
														&#10003;
													</span>
													{f}
												</li>
											))}
										</ul>
										{paidKey && (
											<Button
												loading={
													checkoutMutation.isPending &&
													checkoutMutation.variables === paidKey
												}
												icon={<ArrowUpRight size={16} />}
												className="w-full"
												variant={
													isCurrent
														? "outline"
														: popular
															? "default"
															: "outline"
												}
												disabled={isCurrent || checkoutMutation.isPending}
												onClick={() => checkoutMutation.mutate(paidKey)}
											>
												{isCurrent
													? "Current plan"
													: isStripeTestMode
														? "Test checkout"
														: "Subscribe"}
											</Button>
										)}
										{!paidKey && isCurrent && (
											<Text role="label" tone="secondary">
												Current plan
											</Text>
										)}
									</Surface>
								);
							})}
						</div>
						{checkoutMutation.error && (
							<Text tone="error" className="text-center">
								{errorMessage(
									checkoutMutation.error,
									"Failed to start checkout",
								)}
							</Text>
						)}
					</div>
				)}
			</SettingsSectionContent>
		</SettingsSection>
	);
}

export function BillingDocumentsSection() {
	const overviewQuery = useQuery(billingOverviewQueryOptions());
	const portalMutation = useMutation({
		mutationFn: () =>
			osApi.billing.createPortal({
				returnUrl: billingReturnUrl(undefined, "invoices"),
			}),
		onSuccess: (data) => {
			window.location.href = data.portalUrl;
		},
	});

	if (overviewQuery.isPending) {
		return <LoadingArea className="h-32" label="Loading invoices" />;
	}
	if (overviewQuery.isError || !overviewQuery.data) {
		return (
			<LoadError
				title="Billing documents are unavailable"
				error={overviewQuery.error}
				onRetry={() => {
					void overviewQuery.refetch();
				}}
				retrying={overviewQuery.isFetching}
			/>
		);
	}

	const overview = overviewQuery.data;
	const hasStripeCustomer = overview.account.hasStripeCustomer;

	return (
		<SettingsSection>
			<BillingSectionHeader
				title="Invoices &amp; documents"
				description="Review finalized invoices, receipts, and payment documents."
			/>
			<SettingsSectionContent className="space-y-4">
				{overview.stripeEnvironment === "test" && (
					<Alert>
						<Info aria-hidden />
						<AlertTitle>Billing test mode</AlertTitle>
						<AlertDescription>
							Invoices and payment documents currently use test data.
						</AlertDescription>
					</Alert>
				)}
				<Surface className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
					<div className="flex items-start gap-3">
						<FileText className="mt-0.5 size-5 shrink-0" aria-hidden />
						<div className="grid min-w-0 gap-1">
							<Text weight="medium">Billing history</Text>
							<Text tone="secondary">
								{hasStripeCustomer
									? "Open finalized invoices and downloadable payment documents in the billing portal."
									: "Invoices will appear after your organization starts a paid subscription."}
							</Text>
						</div>
					</div>
					{hasStripeCustomer && (
						<Button
							loading={portalMutation.isPending}
							icon={<ArrowUpRight size={16} />}
							variant="outline"
							disabled={portalMutation.isPending}
							onClick={() => portalMutation.mutate()}
						>
							Open invoices
						</Button>
					)}
				</Surface>
				{portalMutation.isError && (
					<Text tone="error">
						{errorMessage(portalMutation.error, "Failed to open invoices")}
					</Text>
				)}
			</SettingsSectionContent>
		</SettingsSection>
	);
}
