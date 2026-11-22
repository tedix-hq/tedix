import { CloudflarePlatformCosts } from "@/components/cloudflare-platform-costs";
import {
	BillingCreditBalance,
	BillingCreditUsage,
} from "@/components/billing-credit-usage";
import { BillingCard, BillingCardSkeleton } from "@/components/billing-card";
import { RestrictedNotice } from "@/components/restricted-notice";
import { OS_COPY } from "@/shared/os-copy";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Info } from "@phosphor-icons/react";
import { lazy, Suspense, useEffect, useState } from "react";
import {
	LoadError,
	Alert,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
import {
	Page,
	PageHeader,
	PageHeading,
	PageTitle,
} from "@/components/kumo/page";
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
import {
	billingOverviewQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";

import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { isLocalSession } from "@/lib/local-inference";
import { LocalCapabilityNotice } from "@/components/local-capability-notice";

const BillingCreditCaps = lazy(() =>
	import("@/components/billing-credit-caps").then((module) => ({
		default: module.BillingCreditCaps,
	})),
);

const BillingTopUpSection = lazy(() =>
	import("@/components/billing-top-up-section").then((module) => ({
		default: module.BillingTopUpSection,
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

const BillingPayAsYouGoSection = lazy(() =>
	import("@/components/billing-pay-as-you-go").then((mod) => ({
		default: mod.BillingPayAsYouGoSection,
	})),
);

function BillingPagePending({
	title = "Monthly credit usage",
}: {
	title?: string;
}) {
	return (
		<BillingCard title={title}>
			<BillingCardSkeleton label="Loading billing" />
		</BillingCard>
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
				</PageHeading>
			</PageHeader>
			{isLocalSession() ? (
				<LocalCapabilityNotice capability="billing" />
			) : context.isPending ? (
				<BillingPagePending />
			) : context.isError || !context.data ? (
				<LoadError
					title="Billing is unavailable"
					error={context.error}
					onRetry={() => {
						void context.refetch();
					}}
					retrying={context.isFetching}
				/>
			) : !context.data.authority.permissions.includes("billing:manage") ? (
				<BillingRestricted />
			) : (
				<AdminBillingBody
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
		title: "Credit pack payment complete",
		description:
			"Payment confirmed. The credits appear once processing finishes; the balance refreshes automatically.",
	},
	"topup-cancelled": {
		title: "Credit pack checkout cancelled",
		description: "No credits were purchased.",
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
	const queryClient = useQueryClient();
	const overview = useQuery({
		...billingOverviewQueryOptions(),
		staleTime: 30_000,
		refetchInterval: 60_000,
	});
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

	if (overview.isPending) return <BillingPagePending />;
	if (overview.isError) {
		return (
			<LoadError
				title="Billing could not be loaded"
				error={overview.error}
				onRetry={() => void overview.refetch()}
			/>
		);
	}

	return (
		<>
			{checkoutNotice && <CheckoutNotice state={checkoutNotice} />}
			<BillingCreditUsage overview={overview.data} />
			<Tabs
				value={section}
				onValueChange={(value) => onSectionChange(value as AdminBillingSection)}
			>
				<TabsList aria-label="Billing sections" variant="line">
					<TabsTrigger value="overview">Overview</TabsTrigger>
					<TabsTrigger value="plan">Plan</TabsTrigger>
					<TabsTrigger value="credit-packs">Credit packs</TabsTrigger>
					<TabsTrigger value="limits">Limits</TabsTrigger>
					<TabsTrigger value="invoices">Invoices</TabsTrigger>
				</TabsList>
				<TabsContent value="overview" className="space-y-4 pt-4">
					<BillingCreditBalance credits={overview.data.credits} />
					<CloudflarePlatformCosts />
				</TabsContent>
				<TabsContent value="plan" className="pt-4">
					<Suspense fallback={<BillingPagePending title="Current plan" />}>
						<SubscriptionSection overview={overview.data} />
					</Suspense>
				</TabsContent>
				<TabsContent value="credit-packs" className="pt-4">
					<Suspense fallback={<BillingPagePending title="Buy credit packs" />}>
						<BillingTopUpSection
							isTest={overview.data.stripeEnvironment === "test"}
						/>
					</Suspense>
				</TabsContent>
				<TabsContent value="limits" className="space-y-6 pt-4">
					<Suspense fallback={<BillingPagePending title="Pay-as-you-go" />}>
						<BillingPayAsYouGoSection
							payAsYouGo={overview.data.credits.payAsYouGo}
						/>
						<BillingCreditCaps credits={overview.data.credits} />
					</Suspense>
				</TabsContent>
				<TabsContent value="invoices" className="pt-4">
					<Suspense fallback={<BillingPagePending title="Invoices" />}>
						<BillingDocumentsSection
							isTest={overview.data.stripeEnvironment === "test"}
						/>
					</Suspense>
				</TabsContent>
			</Tabs>
		</>
	);
}
