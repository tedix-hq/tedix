import type { BillingOverview } from "@tedix/api-contract/schemas/billing";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { BillingSectionHeader } from "@/components/billing-section-header";
import { formatResetDate } from "@/components/billing-credit-usage";
import { BILLING_PAGE_SIZE } from "@/components/billing-table";
import { LoadError } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { DataTable } from "@/components/kumo/data-table";
import { Link } from "@/components/kumo/link";
import { Pagination } from "@/components/kumo/pagination";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { LoadingArea } from "@/components/loading-area";
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
	const hasContract =
		plan.key === "enterprise" ||
		account.billingMode === "invoice" ||
		account.billingMode === "internal" ||
		credits.includedCredits !== plan.includedCredits;
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
		<div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
			<div className="grid content-start gap-4">
				<Surface className="grid gap-2 p-tedix-card">
					<BillingSectionHeader
						title={plan.name}
						description="Current plan"
						actions={
							<Badge variant="secondary">{STATUSES[account.status]}</Badge>
						}
					/>
					{!(hasContract && plan.priceMicros === 0) && (
						<Text weight="medium">{planPrice(plan)}</Text>
					)}
					<Text>{formatCredits(credits.includedCredits)} a month</Text>
					<Text tone="secondary">
						{account.status === "trial" ? "Trial ends" : "Renews"}{" "}
						{formatResetDate(account.periodEnd)}
					</Text>
					{hasContract && (
						<Text tone="secondary">
							Your contract sets your credits. Contact your account team to
							discuss changes.
						</Text>
					)}
				</Surface>
				{testMode && (
					<Text tone="secondary">
						Billing is in test mode. Payments here use test data.
					</Text>
				)}
				{!hasContract && plans.isPending && (
					<LoadingArea label="Loading plans" />
				)}
				{plans.isError && !hasContract && (
					<LoadError
						title="Plans could not be loaded"
						error={plans.error}
						onRetry={() => void plans.refetch()}
					/>
				)}
				{!hasContract && !!alternatives?.length && (
					<div className="grid gap-3">
						<Text as="h3" role="section" weight="semibold">
							{account.hasStripeCustomer ? "Change plan" : "Choose a plan"}
						</Text>
						<div className="grid gap-3 sm:grid-cols-2">
							{alternatives.map((option) => (
								<Surface key={option.key} className="grid gap-2 p-tedix-card">
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
					</div>
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
		<Surface className="grid h-fit gap-4 p-tedix-card">
			<BillingSectionHeader title="Payment details" />
			{details.isPending ? (
				<LoadingArea label="Loading payment details" />
			) : details.isError ? (
				<LoadError
					title="Payment details could not be loaded"
					error={details.error}
					onRetry={() => void details.refetch()}
				/>
			) : (
				<dl className="grid gap-3">
					<div>
						<dt className="text-kumo-subtle">Payment method</dt>
						<dd>{details.data.method ?? "None on file"}</dd>
					</div>
					<div>
						<dt className="text-kumo-subtle">Billing email</dt>
						<dd className="break-all">
							{details.data.email ?? "None on file"}
						</dd>
					</div>
				</dl>
			)}
			<Button
				variant="outline"
				loading={pending}
				disabled={pending}
				onClick={openPortal}
			>
				Manage subscription
			</Button>
		</Surface>
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
		<div className="grid gap-4">
			{isTest && <Text tone="secondary">Invoices here use test data.</Text>}
			<DataTable
				data={result.data?.invoices ?? []}
				rowKey="id"
				isLoading={result.isPending}
				error={result.isError ? "Invoices could not be loaded." : null}
				onRetry={() => void result.refetch()}
				emptyTitle={
					next ? "No finalized invoices on this page" : "No invoices yet"
				}
				emptyMessage={
					next
						? "Go to the next page to see earlier invoices."
						: "Finalized invoices will appear here."
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
					hasNextPage={!!next}
					setPage={(target) => {
						if (target < page) setCursors(cursors.slice(0, target - 1));
						if (target === page + 1 && next) setCursors([...cursors, next]);
					}}
				>
					<Pagination.Controls controls="simple" />
				</Pagination>
			)}
		</div>
	);
}
