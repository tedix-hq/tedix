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

import { useMutation, useQuery } from "@tanstack/react-query";
import type { BillingPlanCatalogItem } from "@tedix/api-contract/schemas/billing";
import {
	ArrowUpRight,
	CreditCard,
	FileText,
	Info,
	Sparkle,
	Warning,
} from "@phosphor-icons/react";
import { useState } from "react";
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
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Skeleton } from "@/components/kumo/skeleton";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { formatPlanTokenAllowance } from "@/lib/billing-display";
import { formatBillingAmount, formatBillingPrice } from "@/lib/billing-price";
import {
	billingOverviewQueryOptions,
	billingPlansQueryOptions,
} from "@/lib/os-query-options";

const tierBadgeVariant = {
	starter: "secondary" as const,
	growth: "default" as const,
	business: "default" as const,
	enterprise: "default" as const,
};

const statusBadgeVariant = {
	trial: "secondary" as const,
	active: "success" as const,
	past_due: "destructive" as const,
	cancelled: "destructive" as const,
	suspended: "destructive" as const,
};

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

function sectionErrorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

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

	const portalMutation = useMutation({
		// The portal is stateless from our side — no handshake param on return.
		mutationFn: () =>
			osApi.billing.createPortal({ returnUrl: billingReturnUrl() }),
		onSuccess: (data) => {
			window.location.href = data.portalUrl;
		},
	});

	if (plansQuery.isPending || overviewQuery.isPending) {
		return (
			<SettingsSection>
				<SectionHeader>
					<SectionTitle>Plan &amp; billing</SectionTitle>
				</SectionHeader>
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
				<SectionHeader>
					<SectionTitle>Plan &amp; billing</SectionTitle>
				</SectionHeader>
				<SettingsSectionContent>
					<Alert variant="destructive">
						<AlertTitle>Billing is unavailable</AlertTitle>
						<AlertDescription>
							{sectionErrorMessage(
								plansQuery.error ?? overviewQuery.error,
								"The billing read failed.",
							)}
						</AlertDescription>
					</Alert>
				</SettingsSectionContent>
			</SettingsSection>
		);
	}

	const planCatalog = plansQuery.data;
	const overview = overviewQuery.data;
	const selectedStripeCustomerId = overview.snapshot.stripeCustomerId;
	const isStripeTestMode = overview.stripeEnvironment === "test";
	const tier = overview.snapshot.planKey;
	const status = overview.snapshot.status;
	const trialEndsAt = status === "trial" ? overview.snapshot.periodEnd : null;

	const formatDate = (dateString?: string | null) => {
		if (!dateString) return null;
		try {
			return new Date(dateString).toLocaleDateString("en-US", {
				year: "numeric",
				month: "long",
				day: "numeric",
			});
		} catch {
			return null;
		}
	};

	const trialDaysRemaining = trialEndsAt
		? Math.max(
				0,
				Math.ceil(
					(new Date(trialEndsAt).getTime() - Date.now()) /
						(1000 * 60 * 60 * 24),
				),
			)
		: null;
	const formatCount = (value: number, unit: string) =>
		value < 0 ? `Unlimited ${unit}` : `${value.toLocaleString()} ${unit}`;
	const featuresForPlan = (plan: BillingPlanCatalogItem) => [
		formatCount(
			plan.maxTedis,
			plan.maxTedis === 1 ? "autonomous tedi" : "autonomous tedis",
		),
		formatPlanTokenAllowance(plan),
		formatCount(plan.maxCronJobsPerTedi, "scheduled jobs per tedi"),
		formatCount(plan.maxIterationsPerTask, "steps per task"),
		...(plan.overageUnitPriceMicros > 0
			? [
					`${formatBillingPrice(plan.overageUnitPriceMicros, plan.currency)} per ${plan.overageUnitTokens.toLocaleString()} overage tokens`,
				]
			: []),
	];

	return (
		<SettingsSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Plan &amp; billing</SectionTitle>
					<SectionDescription>
						Manage the subscription, payment details, and plan features.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<SettingsSectionContent className="space-y-6">
				{isStripeTestMode && (
					<Alert>
						<Info aria-hidden />
						<AlertTitle>Billing test mode</AlertTitle>
						<AlertDescription>
							Stripe checkout, subscriptions, invoices, and the billing portal
							use test data. Tedix usage, provider cost, credits, limits, and
							admission remain canonical billing records. No real payment method
							will be charged.
						</AlertDescription>
					</Alert>
				)}

				{/* Current plan status */}
				<Surface className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
					<div className="space-y-1">
						<Text weight="medium">Current plan</Text>
						<div className="flex items-center gap-2">
							<Badge
								variant={
									tierBadgeVariant[tier as keyof typeof tierBadgeVariant] ||
									"secondary"
								}
							>
								{tier.charAt(0).toUpperCase() + tier.slice(1)}
							</Badge>
							<Badge
								variant={
									statusBadgeVariant[
										status as keyof typeof statusBadgeVariant
									] || "secondary"
								}
							>
								{status.charAt(0).toUpperCase() + status.slice(1)}
							</Badge>
						</div>
					</div>
					{selectedStripeCustomerId && (
						<Button
							variant="outline"
							onClick={() => portalMutation.mutate()}
							disabled={portalMutation.isPending}
						>
							{portalMutation.isPending ? (
								<Loader
									aria-label="Opening billing portal"
									className="mr-2"
									size={16}
								/>
							) : (
								<CreditCard className="mr-2 h-4 w-4" />
							)}
							Manage or upgrade plan
						</Button>
					)}
				</Surface>

				{portalMutation.isError && (
					<Text tone="error">
						{sectionErrorMessage(
							portalMutation.error,
							"Failed to open billing",
						)}
					</Text>
				)}

				{/* Trial warning */}
				{status === "trial" && trialEndsAt && (
					<Alert>
						<Warning aria-hidden />
						<AlertTitle>Trial ending</AlertTitle>
						<AlertDescription>
							{trialDaysRemaining !== null && trialDaysRemaining > 0 ? (
								<>
									Your trial ends in{" "}
									<Text as="span" weight="semibold">
										{trialDaysRemaining} day
										{trialDaysRemaining !== 1 ? "s" : ""}
									</Text>{" "}
									({formatDate(trialEndsAt)}). Subscribe to keep your tedi
									running.
								</>
							) : (
								<>Your trial has expired. Subscribe to reactivate your tedi.</>
							)}
						</AlertDescription>
					</Alert>
				)}

				{/* Payment or subscription recovery */}
				{(status === "suspended" || status === "past_due") && (
					<Alert variant="destructive">
						<Warning aria-hidden />
						<AlertTitle>
							{status === "past_due"
								? "Payment needs attention"
								: "Subscription suspended"}
						</AlertTitle>
						<AlertDescription>
							Inference is blocked until billing is restored.{" "}
							{selectedStripeCustomerId
								? "Update your payment method to reactivate."
								: "Subscribe to reactivate."}
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
											className="w-full"
											variant={
												isCurrent ? "outline" : popular ? "default" : "outline"
											}
											disabled={isCurrent || checkoutMutation.isPending}
											onClick={() => checkoutMutation.mutate(plan.planKey)}
										>
											{checkoutMutation.isPending &&
											checkoutMutation.variables === plan.planKey ? (
												<Loader
													aria-label="Starting checkout"
													className="mr-2"
													size={16}
												/>
											) : (
												<ArrowUpRight className="mr-2 h-4 w-4" />
											)}
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
								{sectionErrorMessage(
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
			<Alert variant="destructive">
				<AlertTitle>Billing documents are unavailable</AlertTitle>
				<AlertDescription>
					{sectionErrorMessage(
						overviewQuery.error,
						"The billing overview read failed.",
					)}
				</AlertDescription>
			</Alert>
		);
	}

	const overview = overviewQuery.data;
	const hasStripeCustomer = Boolean(overview.snapshot.stripeCustomerId);

	return (
		<SettingsSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Invoices &amp; documents</SectionTitle>
					<SectionDescription>
						Review finalized invoices, receipts, and payment documents.
					</SectionDescription>
				</SectionHeading>
			</SectionHeader>
			<SettingsSectionContent className="space-y-4">
				{overview.stripeEnvironment === "test" && (
					<Alert>
						<Info aria-hidden />
						<AlertTitle>Billing test mode</AlertTitle>
						<AlertDescription>
							Invoices and payment documents currently use Stripe test data.
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
									? "Stripe hosts finalized invoices and downloadable payment documents."
									: "Invoices will appear after your organization starts a paid subscription."}
							</Text>
						</div>
					</div>
					{hasStripeCustomer && (
						<Button
							variant="outline"
							disabled={portalMutation.isPending}
							onClick={() => portalMutation.mutate()}
						>
							{portalMutation.isPending ? (
								<Loader
									aria-label="Opening invoices"
									className="mr-2"
									size={16}
								/>
							) : (
								<ArrowUpRight className="mr-2 size-4" aria-hidden />
							)}
							Open invoices
						</Button>
					)}
				</Surface>
				{portalMutation.isError && (
					<Text tone="error">
						{sectionErrorMessage(
							portalMutation.error,
							"Failed to open invoices",
						)}
					</Text>
				)}
			</SettingsSectionContent>
		</SettingsSection>
	);
}
