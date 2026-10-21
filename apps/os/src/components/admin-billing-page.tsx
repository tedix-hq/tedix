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

import { RestrictedNotice } from "@/components/restricted-notice";
import { OS_COPY } from "@/shared/os-copy";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Info } from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import {
	Page,
	PageDescription,
	PageHeader,
	PageHeading,
	PageTitle,
} from "@/components/kumo/page";
import { ListSkeleton } from "@/components/list-skeleton";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@/components/kumo/tabs";
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

const BillingOverageSection = lazy(() =>
	import("@/components/billing-overage-section").then((mod) => ({
		default: mod.BillingOverageSection,
	})),
);

const BillingInferenceCapacitySection = lazy(() =>
	import("@/components/billing-inference-capacity-section").then((mod) => ({
		default: mod.BillingInferenceCapacitySection,
	})),
);

function BillingPagePending() {
	return (
		<div aria-busy="true" aria-label="Loading billing" className="space-y-3">
			<ListSkeleton rows={3} rowClassName="h-32" />
		</div>
	);
}

function BillingRestricted() {
	return (
		<RestrictedNotice
			title="Only organization owners can manage billing"
			description="Ask an owner to review usage, plans, or the subscription."
		/>
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
					<PageTitle>{OS_COPY.navigation.billing}</PageTitle>
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

const CHECKOUT_NOTICES: Record<
	BillingCheckoutState,
	{ title: string; description: string }
> = {
	"topup-success": {
		title: "Capacity payment complete",
		description:
			"Payment confirmed. Capacity appears once processing finishes; the balance refreshes automatically.",
	},
	"topup-cancelled": {
		title: "Capacity checkout cancelled",
		description: "No capacity was purchased.",
	},
	success: {
		title: "Checkout complete",
		description:
			"Checkout confirmed. Your subscription refreshes once processing finishes, usually within a few seconds.",
	},
	cancelled: {
		title: "Checkout cancelled",
		description: "Nothing changed. You can restart checkout below.",
	},
};

function CheckoutNotice({ state }: { state: BillingCheckoutState }) {
	const notice = CHECKOUT_NOTICES[state];
	const Icon =
		state === "success" || state === "topup-success" ? CheckCircle : Info;
	return (
		<Alert>
			<Icon aria-hidden />
			<AlertTitle>{notice.title}</AlertTitle>
			<AlertDescription>{notice.description}</AlertDescription>
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

				<TabsContent value="usage" className="space-y-8 pt-4">
					<Suspense fallback={<ListSkeleton rows={1} rowClassName="h-32" />}>
						<BillingUsageOverview organizationId={organizationId} />
					</Suspense>
					<Suspense fallback={<ListSkeleton rows={1} rowClassName="h-32" />}>
						<BillingInferenceCapacitySection />
					</Suspense>
				</TabsContent>

				<TabsContent value="subscription" className="space-y-8 pt-4">
					{/* Checkout CONFLICTs render inside the section's mutation error. */}
					<Suspense fallback={<ListSkeleton rows={1} rowClassName="h-32" />}>
						<SubscriptionSection />
					</Suspense>
					<Suspense fallback={<ListSkeleton rows={1} rowClassName="h-32" />}>
						<BillingOverageSection />
					</Suspense>
				</TabsContent>

				<TabsContent value="invoices" className="pt-4">
					<Suspense fallback={<ListSkeleton rows={1} rowClassName="h-32" />}>
						<BillingDocumentsSection />
					</Suspense>
				</TabsContent>
			</Tabs>
		</>
	);
}
