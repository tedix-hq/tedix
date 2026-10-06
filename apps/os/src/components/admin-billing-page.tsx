/**
 * Admin › Billing
 *
 * Usage, plan limits, and subscription management on the `orgUsage` and
 * `billing` contracts.
 * The canonical usage cards now add only the two operator-relevant Kumo chart
 * readings: daily estimated cost and cost concentration by tedi. Their exact
 * tables remain available, and ECharts stays behind a nested lazy boundary.
 *
 * Authority: the /admin layout gate admits `settings:manage`/`os:admin` and
 * the owner/admin roles, but `billing:manage` is OWNER-only in
 * `packages/auth/src/rbac.ts` — an admin passes the layout and must still not
 * see checkout, the portal, or the org's spend. So this page carries its own
 * narrower in-page check, mirroring (not replacing) the API's guards, which
 * re-check authority on every read and write.
 *
 * Stripe return handshake: checkout and the portal are full-page handoffs,
 * and apps/api mints `/admin/billing?checkout=success|cancelled` return URLs.
 * On success the page invalidates canonical `billing.getOverview` so the new
 * subscription renders without a hard reload; either way the param is cleared
 * with a replace navigation so refresh/back does not replay it.
 */

import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Info, ShieldCheck } from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Card, CardContent } from "@/components/kumo/card";
import {
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
} from "@/components/kumo/page";
import { Skeleton } from "@/components/kumo/skeleton";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/kumo/tabs";
import { Text } from "@/components/kumo/text";
import type {
	AdminBillingSection,
	BillingCheckoutState,
} from "@/lib/admin-billing-search";
import { osQueryKeys } from "@/lib/os-query-options";
import { errorMessage } from "@/lib/orpc-error";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { isLocalSession } from "@/lib/local-inference";
import { LocalCapabilityNotice } from "@/components/local-capability-notice";

const BillingUsageOverview = lazy(() =>
	import("@/components/admin-billing-usage").then((mod) => ({
		default: mod.BillingUsageOverview,
	})),
);

const SubscriptionSection = lazy(() =>
	import("@/components/billing-subscription-section").then((mod) => ({
		default: mod.SubscriptionSection,
	})),
);

const BillingDocumentsSection = lazy(() =>
	import("@/components/billing-subscription-section").then((mod) => ({
		default: mod.BillingDocumentsSection,
	})),
);

const BillingInferenceCapacitySection = lazy(() =>
	import("@/components/billing-inference-capacity-section").then((mod) => ({
		default: mod.BillingInferenceCapacitySection,
	})),
);

function SectionSkeleton() {
	return <Skeleton className="h-32 w-full" />;
}

function BillingPagePending() {
	return (
		<div aria-busy="true" aria-label="Loading billing" className="space-y-3">
			{Array.from({ length: 3 }).map((_, index) => (
				<Skeleton className="h-32 w-full" key={index} />
			))}
		</div>
	);
}

function BillingRestricted() {
	return (
		<Card size="sm">
			<CardContent className="flex items-center gap-3">
				<ShieldCheck className="size-5 shrink-0" aria-hidden />
				<div>
					<Text role="body" weight="medium">
						Billing needs the billing:manage grant
					</Text>
					<Text tone="secondary">
						Your credential resolves administrative access but not
						billing:manage, which only owners hold. Ask an owner to review
						usage, plans, or the subscription.
					</Text>
				</div>
			</CardContent>
		</Card>
	);
}

export function AdminBillingPage({
	checkout,
	section,
	onSectionChange,
	onClearCheckout,
}: {
	checkout?: BillingCheckoutState;
	section: AdminBillingSection;
	onSectionChange: (section: AdminBillingSection) => void;
	onClearCheckout: () => void;
}) {
	const context = useOsOperationalContext();

	return (
		<Page width="xl">
			<PageHeader>
				<PageHeading>
					<PageTitle>Billing &amp; usage</PageTitle>
					<PageDescription>
						Understand what you are using, what you will pay, and how much
						capacity remains.
					</PageDescription>
				</PageHeading>
			</PageHeader>
			{isLocalSession() ? (
				<LocalCapabilityNotice capability="billing" />
			) : context.isPending ? (
				<BillingPagePending />
			) : context.isError || !context.data ? (
				<Alert variant="destructive">
					<AlertTitle>Billing is unavailable</AlertTitle>
					<AlertDescription>
						{errorMessage(
							context.error,
							"The operational context read failed.",
						)}
					</AlertDescription>
				</Alert>
			) : !context.data.authority.permissions.includes("billing:manage") ? (
				<BillingRestricted />
			) : (
				<AdminBillingBody
					organizationId={context.data.organization.id}
					checkout={checkout}
					section={section}
					onSectionChange={onSectionChange}
					onClearCheckout={onClearCheckout}
				/>
			)}
		</Page>
	);
}

function CheckoutNotice({ state }: { state: BillingCheckoutState }) {
	if (state === "topup-success") {
		return (
			<Alert>
				<CheckCircle aria-hidden />
				<AlertTitle>Capacity payment complete</AlertTitle>
				<AlertDescription>
					Stripe confirmed the payment. Capacity appears after the signed
					webhook is processed; the balance below refreshes automatically.
				</AlertDescription>
			</Alert>
		);
	}
	if (state === "topup-cancelled") {
		return (
			<Alert>
				<Info aria-hidden />
				<AlertTitle>Capacity checkout cancelled</AlertTitle>
				<AlertDescription>No capacity was purchased.</AlertDescription>
			</Alert>
		);
	}
	if (state === "success") {
		return (
			<Alert>
				<CheckCircle aria-hidden />
				<AlertTitle>Checkout complete</AlertTitle>
				<AlertDescription>
					Stripe confirmed the checkout. The subscription below refreshes as
					soon as the webhook lands — usually within a few seconds.
				</AlertDescription>
			</Alert>
		);
	}
	return (
		<Alert>
			<Info aria-hidden />
			<AlertTitle>Checkout cancelled</AlertTitle>
			<AlertDescription>
				The Stripe checkout was cancelled before completing. Nothing changed;
				you can restart it below at any time.
			</AlertDescription>
		</Alert>
	);
}

function AdminBillingBody({
	organizationId,
	checkout,
	section,
	onSectionChange,
	onClearCheckout,
}: {
	organizationId: string;
	checkout?: BillingCheckoutState;
	section: AdminBillingSection;
	onSectionChange: (section: AdminBillingSection) => void;
	onClearCheckout: () => void;
}) {
	const queryClient = useQueryClient();
	// Capture the handshake before clearing the URL so the notice survives the
	// replace navigation that removes ?checkout=.
	const [checkoutNotice] = useState(checkout);
	useEffect(() => {
		if (!checkout) return;
		if (checkout === "success" || checkout === "topup-success") {
			void queryClient.invalidateQueries({
				queryKey: osQueryKeys.billingOverview(),
			});
		}
		onClearCheckout();
	}, [checkout, onClearCheckout, queryClient]);

	return (
		<>
			{checkoutNotice && <CheckoutNotice state={checkoutNotice} />}

			<Tabs
				value={section}
				onValueChange={(value) => onSectionChange(value as AdminBillingSection)}
			>
				<TabsList aria-label="Billing sections" variant="line">
					<TabsTrigger value="usage">Usage</TabsTrigger>
					<TabsTrigger value="subscription">Subscription</TabsTrigger>
					<TabsTrigger value="invoices">Invoices &amp; documents</TabsTrigger>
				</TabsList>

				<TabsContent value="usage" className="space-y-6 pt-4">
					<Suspense fallback={<SectionSkeleton />}>
						<BillingUsageOverview organizationId={organizationId} />
					</Suspense>
					<Suspense fallback={<SectionSkeleton />}>
						<BillingInferenceCapacitySection />
					</Suspense>
				</TabsContent>

				<TabsContent value="subscription" className="pt-4">
					{/* Checkout CONFLICTs render inside the section's mutation error. */}
					<Suspense fallback={<SectionSkeleton />}>
						<SubscriptionSection />
					</Suspense>
				</TabsContent>

				<TabsContent value="invoices" className="pt-4">
					<Suspense fallback={<SectionSkeleton />}>
						<BillingDocumentsSection />
					</Suspense>
				</TabsContent>
			</Tabs>
		</>
	);
}
