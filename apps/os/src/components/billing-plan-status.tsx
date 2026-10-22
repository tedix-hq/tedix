import { BillingSectionHeader } from "@/components/billing-section-header";
import type { BillingOverview } from "@tedix/api-contract/schemas/billing";
import { useMutation } from "@tanstack/react-query";
import { CreditCard, Warning } from "@phosphor-icons/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osLocale, osTimeZone } from "@/lib/format";
import { errorMessage } from "@/lib/orpc-error";

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

export function BillingPlanStatus({ overview }: { overview: BillingOverview }) {
	const tier = overview.snapshot.planKey;
	const status = overview.snapshot.status;
	const selectedStripeCustomerId = overview.snapshot.stripeCustomerId;
	const portalMutation = useMutation({
		mutationFn: () =>
			osApi.billing.createPortal({
				returnUrl: `${window.location.origin}/admin/billing?section=usage`,
			}),
		onSuccess: (data) => {
			window.location.href = data.portalUrl;
		},
	});
	const trialEndsAt = status === "trial" ? overview.snapshot.periodEnd : null;

	const formatDate = (dateString?: string | null) => {
		if (!dateString) return null;
		const timeZone = osTimeZone();
		return new Date(dateString).toLocaleDateString(osLocale(), {
			year: "numeric",
			month: "long",
			day: "numeric",
			...(timeZone ? { timeZone } : {}),
		});
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
	return (
		<div className="space-y-3" aria-label="Subscription status and recovery">
			<Surface className="p-tedix-card">
				<BillingSectionHeader
					title="Current plan"
					description={
						<span className="flex flex-wrap items-center gap-2">
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
								{status.charAt(0).toUpperCase() +
									status.slice(1).replaceAll("_", " ")}
							</Badge>
						</span>
					}
					actions={
						selectedStripeCustomerId ? (
							<Button
								loading={portalMutation.isPending}
								icon={<CreditCard size={16} />}
								variant="outline"
								onClick={() => portalMutation.mutate()}
								disabled={portalMutation.isPending}
							>
								Manage or upgrade plan
							</Button>
						) : (
							<Button
								variant="outline"
								render={<a href="/admin/billing?section=subscription" />}
							>
								Choose a plan
							</Button>
						)
					}
				/>
			</Surface>

			{portalMutation.isError && (
				<Text tone="error">
					{errorMessage(portalMutation.error, "Failed to open billing")}
				</Text>
			)}

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
		</div>
	);
}
