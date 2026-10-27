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
import { BillingSectionHeader } from "@/components/billing-section-header";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { BillingPlanCatalogItem } from "@tedix/api-contract/schemas/billing";
import { ArrowUpRight, FileText, Info, Sparkle } from "@phosphor-icons/react";
import { useState } from "react";
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
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Skeleton } from "@/components/kumo/skeleton";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { formatPlanTokenAllowance } from "@/lib/billing-display";
import { formatBillingAmount, formatBillingPrice } from "@/lib/billing-price";
import { formatCount } from "@/lib/format";
import {
	billingOverviewQueryOptions,
	billingPlansQueryOptions,
} from "@/lib/os-query-options";

const BILLING_INTERVAL_OPTIONS = [
	{ value: "month", label: "Monthly" },
	{
		value: "year",
		label: (
			<>
				Annual
				<Text as="span" role="label" tone="success" className="ml-1">
					Save 20%
				</Text>
			</>
		),
	},
] as const;

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

export function SubscriptionSection() {
	const [billingInterval, setBillingInterval] = useState<"month" | "year">(
		"month",
	);
	const plansQuery = useQuery(billingPlansQueryOptions());
	const overviewQuery = useQuery(billingOverviewQueryOptions());

	const checkoutMutation = useMutation({
		mutationFn: (selectedTier: "growth" | "business" | "enterprise") =>
			osApi.billing.createCheckout({
				tier: selectedTier,
				interval: billingInterval,
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
					<Skeleton className="h-24 w-full" />
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

	const planCatalog = plansQuery.data;
	const overview = overviewQuery.data;
	const isStripeTestMode = overview.stripeEnvironment === "test";
	const tier = overview.snapshot.planKey;
	const status = overview.snapshot.status;
	const formatLimit = (value: number, unit: string) =>
		value < 0 ? `Unlimited ${unit}` : `${formatCount(value)} ${unit}`;
	const featuresForPlan = (plan: BillingPlanCatalogItem) => [
		formatLimit(
			plan.maxTedis,
			plan.maxTedis === 1 ? "autonomous tedi" : "autonomous tedis",
		),
		formatPlanTokenAllowance(plan),
		formatLimit(plan.maxCronJobsPerTedi, "scheduled jobs per tedi"),
		formatLimit(plan.maxIterationsPerTask, "steps per task"),
		...(plan.overageUnitPriceMicros > 0
			? [
					`${formatBillingPrice(plan.overageUnitPriceMicros, plan.currency)} per ${formatCount(plan.overageUnitTokens)} overage tokens`,
				]
			: []),
	];

	return (
		<SettingsSection>
			<BillingSectionHeader
				title="Plan &amp; billing"
				description="Manage the subscription, payment details, and plan features."
			/>
			<SettingsSectionContent className="space-y-6">
				{isStripeTestMode && (
					<Alert>
						<Info aria-hidden />
						<AlertTitle>Billing test mode</AlertTitle>
						<AlertDescription>
							Checkout, subscriptions, invoices, and the billing portal use test
							data. Tedix usage, provider cost, credits, limits, and admission
							remain canonical billing records. No real payment method will be
							charged.
						</AlertDescription>
					</Alert>
				)}

				{/* Pricing cards */}
				{(status === "trial" ||
					status === "suspended" ||
					status === "past_due" ||
					tier === "starter") && (
					<div className="space-y-4">
						<SegmentedControl
							className="items-center"
							value={billingInterval}
							onValueChange={setBillingInterval}
							ariaLabel="Billing interval"
							options={BILLING_INTERVAL_OPTIONS}
						/>

						<div className="grid gap-4 md:grid-cols-3">
							{planCatalog.plans.map((plan) => {
								const isCurrent = plan.planKey === tier;
								const priceMicros =
									billingInterval === "year"
										? plan.annualPriceMicros
										: plan.monthlyPriceMicros;
								const popular = plan.planKey === "business";
								return (
									<Surface
										key={`${plan.planKey}-v${plan.version}`}
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
													{formatBillingAmount(priceMicros, plan.currency)}
												</Text>
												<Text as="span" tone="secondary">
													/{billingInterval === "year" ? "year" : "month"}
												</Text>
											</div>
										</div>
										{/* `ul` is not a supported Text `as` element, and the
										checkmark span depends on the same ambient text-sm as the
										feature text, so this size/color cascade is left as raw
										utilities. */}
										<ul className="mb-4 space-y-1.5 text-sm">
											{featuresForPlan(plan).map((f) => (
												<li key={f} className="flex items-start gap-2">
													<span className="mt-0.5 text-kumo-success">
														&#10003;
													</span>
													{f}
												</li>
											))}
										</ul>
										<Button
											loading={
												checkoutMutation.isPending &&
												checkoutMutation.variables === plan.planKey
											}
											icon={<ArrowUpRight size={16} />}
											className="w-full"
											variant={
												isCurrent ? "outline" : popular ? "default" : "outline"
											}
											disabled={isCurrent || checkoutMutation.isPending}
											onClick={() => checkoutMutation.mutate(plan.planKey)}
										>
											{isCurrent
												? "Current plan"
												: isStripeTestMode
													? "Test checkout"
													: "Subscribe"}
										</Button>
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
		return <Skeleton className="h-32 w-full" />;
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
	const hasStripeCustomer = Boolean(overview.snapshot.stripeCustomerId);

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
						<div className="space-y-1">
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
