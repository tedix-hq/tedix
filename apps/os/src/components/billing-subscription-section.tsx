import type { BillingOverview } from "@tedix/api-contract/schemas/billing";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { BillingCard, BillingCardSkeleton } from "@/components/billing-card";
import { formatResetDate } from "@/components/billing-credit-usage";
import {
	BILLING_PAGE_SIZE,
	BillingDataTable,
} from "@/components/billing-table";
import { LoadError } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Empty } from "@/components/kumo/empty";
import { Link } from "@/components/kumo/link";
import { Pagination } from "@/components/kumo/pagination";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { formatCredits, type CreditPlan } from "@/lib/billing-credits";
import { formatBillingAmount, formatCurrencyAmount } from "@/lib/billing-price";
import { errorMessage } from "@/lib/orpc-error";
import { billingPlansQueryOptions, osQuery } from "@/lib/os-query-options";

const STATUSES = {
	trial: "Trial",
	active: "Active",
	past_due: "Payment overdue",
	cancelled: "Cancelled",
	suspended: "Suspended",
};

function billingReturnUrl(state?: "success" | "cancelled") {
	const search = new URLSearchParams({ tab: "plan" });
	if (state) search.set("checkout", state);
	return `${window.location.origin}/admin/billing?${search}`;
}

function planPrice(plan: CreditPlan) {
	return plan.priceMicros === 0
		? "Free"
		: `${formatBillingAmount(plan.priceMicros, plan.currency)} a month`;
}

export function SubscriptionSection({
	overview,
}: {
	overview: BillingOverview;
}) {
	const { account, plan, credits } = overview;
	const internal =
		account.billingMode === "internal" ||
		(account.hasIncludedCreditsOverride && !account.hasPaidPlan);
	const hasContract =
		plan.key === "enterprise" ||
		account.billingMode === "invoice" ||
		internal ||
		credits.includedCredits !== plan.includedCredits;
	const planLabel = internal
		? "Internal account"
		: account.hasPaidPlan && plan.priceMicros > 0
			? planPrice(plan)
			: plan.key === "starter" && plan.priceMicros === 0
				? "Free"
				: null;
	const planAction = account.hasStripeCustomer
		? "Change plan"
		: "Choose a plan";
	const testMode = overview.stripeEnvironment === "test";
	const plans = useQuery({
		...billingPlansQueryOptions(),
		enabled: !hasContract,
	});
	const checkout = useMutation({
		mutationFn: (tier: "growth" | "business") =>
			osApi.billing.createCheckout({
				tier,
				interval: "month",
				successUrl: billingReturnUrl("success"),
				cancelUrl: billingReturnUrl("cancelled"),
			}),
		onSuccess: ({ checkoutUrl }) => {
			window.location.href = checkoutUrl;
		},
	});
	const portal = useMutation({
		mutationFn: () =>
			osApi.billing.createPortal({ returnUrl: billingReturnUrl() }),
		onSuccess: ({ portalUrl }) => {
			window.location.href = portalUrl;
		},
	});
	const alternatives = plans.data?.filter(
		({ key }) => (key === "growth" || key === "business") && key !== plan.key,
	);

	return (
		<div
			className={
				account.hasStripeCustomer
					? "grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
					: "grid gap-4"
			}
		>
			<div className="grid min-w-0 content-start gap-4">
				<BillingCard
					title="Current plan"
					actions={
						<Badge variant="secondary">{STATUSES[account.status]}</Badge>
					}
					bodyClassName="grid gap-2"
				>
					<Text role="dialog" weight="semibold">
						{plan.name}
					</Text>
					{planLabel && <Text weight="medium">{planLabel}</Text>}
					<Text>{formatCredits(credits.includedCredits)} a month</Text>
					<Text tone="secondary">
						{account.status === "trial"
							? "Trial ends"
							: account.status === "cancelled"
								? "Period ends"
								: "Renews"}{" "}
						{formatResetDate(account.periodEnd)}
					</Text>
					{internal ? (
						<Text tone="secondary">Credits are set by Tedix</Text>
					) : (
						hasContract && (
							<Text tone="secondary">
								Contact your account team to change your plan.
							</Text>
						)
					)}
					{testMode && <Text tone="secondary">Billing is in test mode.</Text>}
				</BillingCard>
				{!hasContract && (
					<BillingCard title={planAction}>
						{plans.isPending ? (
							<BillingCardSkeleton label="Loading plans" />
						) : plans.isError ? (
							<LoadError
								title="Plans could not be loaded"
								error={plans.error}
								onRetry={() => void plans.refetch()}
							/>
						) : alternatives?.length ? (
							<div className="grid gap-3 sm:grid-cols-2">
								{alternatives.map((option) => (
									<Surface key={option.key} className="grid gap-2 p-4">
										<Text weight="semibold">{option.name}</Text>
										<Text>{planPrice(option)}</Text>
										<Text tone="secondary">
											{formatCredits(option.includedCredits)} a month
										</Text>
										<Button
											variant="outline"
											disabled={portal.isPending || checkout.isPending}
											onClick={() => {
												if (account.hasStripeCustomer) portal.mutate();
												else if (
													option.key === "growth" ||
													option.key === "business"
												)
													checkout.mutate(option.key);
											}}
										>
											{account.hasStripeCustomer
												? "Change in billing portal"
												: testMode
													? "Test checkout"
													: `Choose ${option.name}`}
										</Button>
									</Surface>
								))}
							</div>
						) : (
							<Empty
								appearance="inline"
								title="There are no other plans available."
							/>
						)}
					</BillingCard>
				)}
				{checkout.isError && (
					<Text tone="error">
						{errorMessage(checkout.error, "Could not open checkout")}
					</Text>
				)}
				{portal.isError && (
					<Text tone="error">
						{errorMessage(portal.error, "Could not open the billing portal")}
					</Text>
				)}
			</div>
			{account.hasStripeCustomer && (
				<PaymentDetails
					openPortal={() => portal.mutate()}
					pending={portal.isPending}
				/>
			)}
		</div>
	);
}

function PaymentDetails({
	openPortal,
	pending,
}: {
	openPortal: () => void;
	pending: boolean;
}) {
	const details = useQuery(osQuery.billing.getPaymentDetails.queryOptions({}));
	return (
		<div className="grid min-w-0 content-start gap-4">
			<BillingCard title="Payment method" bodyClassName="grid gap-3">
				{details.isPending ? (
					<BillingCardSkeleton label="Loading payment method" />
				) : details.isError ? (
					<LoadError
						title="Payment details could not be loaded"
						error={details.error}
						onRetry={() => void details.refetch()}
					/>
				) : (
					<Text>{details.data.method ?? "No payment method on file."}</Text>
				)}
				<Button
					variant="outline"
					loading={pending}
					disabled={pending}
					onClick={openPortal}
					className="justify-self-start"
				>
					Manage in portal
				</Button>
			</BillingCard>
			<BillingCard title="Billing email">
				{details.isPending ? (
					<BillingCardSkeleton label="Loading billing email" />
				) : (
					<Text className="break-all">
						{details.isError
							? "Billing email is unavailable."
							: (details.data.email ?? "No billing email on file.")}
					</Text>
				)}
			</BillingCard>
		</div>
	);
}

export function BillingDocumentsSection({ isTest }: { isTest: boolean }) {
	const [cursors, setCursors] = useState<string[]>([]);
	const page = cursors.length + 1;
	const result = useQuery(
		osQuery.billing.listInvoices.queryOptions({
			input: { cursor: cursors.at(-1) },
		}),
	);
	const next = result.data?.nextCursor;
	return (
		<BillingCard
			title="Invoices"
			description={isTest ? "Invoices here use test data." : undefined}
			bodyClassName="grid gap-3 p-0"
		>
			<BillingDataTable
				data={result.data?.invoices ?? []}
				rowKey="id"
				isLoading={result.isPending}
				error={result.isError ? "Invoices could not be loaded." : null}
				onRetry={() => void result.refetch()}
				emptyTitle={
					next
						? "Go to the next page to see earlier invoices."
						: "There are no invoices yet."
				}
				columns={[
					{
						header: "Invoice",
						accessor: (invoice) => invoice.number ?? "Invoice",
					},
					{
						header: "Issued",
						accessor: (invoice) => formatResetDate(invoice.issuedAt, true),
					},
					{
						header: "Total",
						align: "right",
						accessor: (invoice) =>
							formatCurrencyAmount(invoice.amountMinor / 100, invoice.currency),
					},
					{
						header: "Document",
						align: "right",
						accessor: (invoice) =>
							invoice.url && (
								<Link href={invoice.url} target="_blank" rel="noreferrer">
									View invoice
								</Link>
							),
					},
				]}
			/>
			{(next || page > 1) && (
				<Pagination
					page={page}
					perPage={BILLING_PAGE_SIZE}
					className="px-4 pb-3"
					hasNextPage={!!next}
					setPage={(target) => {
						if (target < page) setCursors(cursors.slice(0, target - 1));
						if (target === page + 1 && next) setCursors([...cursors, next]);
					}}
				>
					<Pagination.Controls controls="simple" />
				</Pagination>
			)}
		</BillingCard>
	);
}
