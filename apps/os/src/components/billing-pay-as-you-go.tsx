/**
 * Pay-as-you-go. Off by default: when the included and top-up credits run
 * out, new work stops. An owner or admin can turn it on with a monthly euro
 * cap; extra credits are then billed at €0.01 each until the cap.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Warning } from "@phosphor-icons/react";
import { useState } from "react";
import { BillingSectionHeader } from "@/components/billing-section-header";
import { SettingsRow } from "@/components/settings-row";
import {
	LoadError,
	Alert,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import {
	SettingsSection,
	SettingsSectionContent,
} from "@/components/kumo/page";
import { Skeleton } from "@/components/kumo/skeleton";
import { Surface } from "@/components/kumo/surface";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	type CreditPayAsYouGo,
	MAX_PAY_AS_YOU_GO_CAP_EUROS,
	microsToCredits,
	parseEuroCapMicros,
} from "@/lib/billing-credits";
import { formatBillingAmount } from "@/lib/billing-price";
import { formatCount } from "@/lib/format";
import { errorMessage } from "@/lib/orpc-error";
import { billingOverviewQueryOptions } from "@/lib/os-query-options";

function capEuros(micros: number | null): string {
	return micros === null ? "" : String(micros / 1_000_000);
}

export function BillingPayAsYouGoSection() {
	const queryClient = useQueryClient();
	const overviewQuery = useQuery(billingOverviewQueryOptions());

	if (overviewQuery.isPending) return <Skeleton className="h-32 w-full" />;
	if (overviewQuery.isError) {
		return (
			<LoadError
				title="Pay-as-you-go settings are unavailable"
				error={overviewQuery.error}
				onRetry={() => {
					void overviewQuery.refetch();
				}}
				retrying={overviewQuery.isFetching}
			/>
		);
	}
	const payAsYouGo = overviewQuery.data.credits.payAsYouGo;
	return (
		<PayAsYouGoForm
			key={`${payAsYouGo.enabled}:${payAsYouGo.monthlyCapMicros}`}
			settings={payAsYouGo}
			onSaved={() =>
				queryClient.invalidateQueries({
					queryKey: billingOverviewQueryOptions().queryKey,
				})
			}
		/>
	);
}

export function PayAsYouGoForm({
	settings,
	onSaved,
}: {
	settings: CreditPayAsYouGo;
	onSaved: () => void;
}) {
	const [enabled, setEnabled] = useState(settings.enabled);
	const [cap, setCap] = useState(capEuros(settings.monthlyCapMicros));
	const capMicros = parseEuroCapMicros(cap);
	const capInvalid = enabled && capMicros === null;
	const dirty =
		enabled !== settings.enabled ||
		(enabled && capMicros !== settings.monthlyCapMicros);
	const capReached =
		settings.enabled &&
		settings.monthlyCapMicros !== null &&
		settings.spentMicros >= settings.monthlyCapMicros;
	const mutation = useMutation({
		mutationFn: () =>
			osApi.billing.setPayAsYouGo({
				enabled,
				monthlyCapMicros: enabled ? capMicros : null,
			}),
		onSuccess: onSaved,
	});

	return (
		<SettingsSection>
			<BillingSectionHeader
				title="Pay-as-you-go"
				description="Off by default. When your plan and top-up credits run out, new work stops. Turn this on to keep working: extra credits cost €0.01 each, up to the monthly cap you set."
				actions={capReached && <Badge variant="destructive">Cap reached</Badge>}
			/>
			<SettingsSectionContent className="space-y-4">
				{capReached && (
					<Alert variant="destructive">
						<Warning aria-hidden />
						<AlertTitle>Monthly pay-as-you-go cap reached</AlertTitle>
						<AlertDescription>
							New work has stopped until next month. Raise the cap or buy a
							credit pack to continue now.
						</AlertDescription>
					</Alert>
				)}
				<Surface className="space-y-4 p-4">
					<SettingsRow
						title={
							<Label htmlFor="pay-as-you-go-enabled">
								Keep working past my credits
							</Label>
						}
					>
						<Switch
							id="pay-as-you-go-enabled"
							aria-label="Keep working past my credits"
							checked={enabled}
							disabled={mutation.isPending}
							onCheckedChange={setEnabled}
						/>
					</SettingsRow>
					<div className="space-y-1">
						<Label htmlFor="pay-as-you-go-cap">
							<span id="pay-as-you-go-cap-label">Monthly cap (EUR)</span>
						</Label>
						<Input
							id="pay-as-you-go-cap"
							aria-labelledby="pay-as-you-go-cap-label"
							type="number"
							inputMode="decimal"
							min={0}
							step="1"
							value={cap}
							disabled={!enabled || mutation.isPending}
							aria-invalid={capInvalid}
							aria-describedby="pay-as-you-go-cap-description"
							onChange={(event) => setCap(event.target.value)}
						/>
						<Text
							id="pay-as-you-go-cap-description"
							tone={capInvalid ? "error" : "secondary"}
						>
							{capInvalid
								? `Enter an amount above €0 and at most €${formatCount(MAX_PAY_AS_YOU_GO_CAP_EUROS)}.`
								: capMicros !== null
									? `Up to ${formatCount(microsToCredits(capMicros))} extra credits a month. You are never billed more than the cap.`
									: "You are never billed more than the cap."}
						</Text>
					</div>
					<Text tone="secondary">
						This month: {formatBillingAmount(settings.spentMicros, "eur")}{" "}
						pay-as-you-go
						{settings.enabled && settings.monthlyCapMicros !== null
							? ` of ${formatBillingAmount(settings.monthlyCapMicros, "eur")} cap`
							: ""}
						.
					</Text>
					<div className="flex items-center gap-3">
						<Button
							onClick={() => mutation.mutate()}
							disabled={!dirty || capInvalid || mutation.isPending}
						>
							{mutation.isPending ? "Saving…" : "Save"}
						</Button>
						{mutation.isError && (
							<Text tone="error">
								{errorMessage(
									mutation.error,
									"Pay-as-you-go settings could not be saved",
								)}
							</Text>
						)}
					</div>
				</Surface>
			</SettingsSectionContent>
		</SettingsSection>
	);
}
