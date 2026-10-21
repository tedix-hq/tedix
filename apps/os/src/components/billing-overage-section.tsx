/**
 * Admin overage opt-in. Priced overage is off by default; an owner or admin
 * turns it on with a hard monthly cap, and inference stops at the cap the
 * same way it stops at an exhausted allowance.
 */

import { SettingsRow } from "@/components/settings-row";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BillingOverageSettings } from "@tedix/api-contract/schemas/billing";
import { Warning } from "@phosphor-icons/react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import {
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
	SettingsSection,
	SettingsSectionContent,
} from "@/components/kumo/page";
import { Skeleton } from "@/components/kumo/skeleton";
import { Surface } from "@/components/kumo/surface";
import { Switch } from "@/components/kumo/switch";
import { Text } from "@/components/kumo/text";
import { BillingCreditBudget } from "@/components/billing-credit-budget";
import { osApi } from "@/lib/api";
import { formatBillingAmount } from "@/lib/billing-price";
import { errorMessage } from "@/lib/orpc-error";
import { billingOverviewQueryOptions } from "@/lib/os-query-options";

const MAX_CAP_UNITS = 1_000_000;

function capUnits(micros: number | null): string {
	return micros === null ? "" : String(micros / 1_000_000);
}

export function parseOverageCapMicros(value: string): number | null {
	const units = Number(value.trim());
	if (!Number.isFinite(units) || units <= 0 || units > MAX_CAP_UNITS)
		return null;
	return Math.round(units * 100) * 10_000;
}

export function BillingOverageSection() {
	const queryClient = useQueryClient();
	const overviewQuery = useQuery(billingOverviewQueryOptions());

	if (overviewQuery.isPending) return <Skeleton className="h-32 w-full" />;
	if (overviewQuery.isError) {
		return (
			<Alert variant="destructive">
				<AlertTitle>Overage settings are unavailable</AlertTitle>
				<AlertDescription>
					{errorMessage(overviewQuery.error, "The billing read failed.")}
				</AlertDescription>
			</Alert>
		);
	}
	if (overviewQuery.data.credits?.billingMode === "monetary") {
		return (
			<BillingCreditBudget
				key={overviewQuery.data.credits.monthlyCapMicros ?? "unlimited"}
				credits={overviewQuery.data.credits}
			/>
		);
	}
	return (
		<OverageForm
			key={`${overviewQuery.data.overage.enabled}:${overviewQuery.data.overage.monthlyCapMicros}`}
			settings={overviewQuery.data.overage}
			onSaved={() =>
				queryClient.invalidateQueries({
					queryKey: billingOverviewQueryOptions().queryKey,
				})
			}
		/>
	);
}

function OverageForm({
	settings,
	onSaved,
}: {
	settings: BillingOverageSettings;
	onSaved: () => void;
}) {
	const [enabled, setEnabled] = useState(settings.enabled);
	const [cap, setCap] = useState(capUnits(settings.monthlyCapMicros));
	const capMicros = parseOverageCapMicros(cap);
	const capInvalid = enabled && capMicros === null;
	const dirty =
		enabled !== settings.enabled ||
		(enabled && capMicros !== settings.monthlyCapMicros);
	const mutation = useMutation({
		mutationFn: () =>
			osApi.billing.setOverageSettings({
				enabled,
				monthlyCapMicros: enabled ? capMicros : null,
			}),
		onSuccess: onSaved,
	});
	const spent =
		settings.monthToDateChargeMicros + settings.reservedChargeMicros;
	const currency = settings.currency;

	return (
		<SettingsSection>
			<SectionHeader>
				<SectionHeading>
					<SectionTitle>Overage</SectionTitle>
					<SectionDescription>
						Off by default. When on, usage past the included allowance is billed
						at the plan overage rate until the monthly cap, then inference stops
						until the next period.
					</SectionDescription>
				</SectionHeading>
				{settings.capReached && (
					<Badge variant="destructive">Cap reached</Badge>
				)}
			</SectionHeader>
			<SettingsSectionContent className="space-y-4">
				{!settings.planSellsOverage && (
					<Alert>
						<AlertTitle>This plan does not sell overage</AlertTitle>
						<AlertDescription>
							Inference stops at the included allowance. Upgrade the plan to buy
							usage past it.
						</AlertDescription>
					</Alert>
				)}
				{settings.capReached && (
					<Alert variant="destructive">
						<Warning aria-hidden />
						<AlertTitle>Monthly overage cap reached</AlertTitle>
						<AlertDescription>
							Inference is paused until the next billing period. Raise the cap
							to resume now.
						</AlertDescription>
					</Alert>
				)}
				<Surface className="space-y-4 p-4">
					<SettingsRow
						title={<Label htmlFor="overage-enabled">Allow overage</Label>}
					>
						<Switch
							id="overage-enabled"
							aria-label="Allow overage"
							checked={enabled}
							disabled={!settings.planSellsOverage || mutation.isPending}
							onCheckedChange={setEnabled}
						/>
					</SettingsRow>
					<div className="space-y-1">
						<Label htmlFor="overage-cap">
							<span id="overage-cap-label">
								Monthly cap ({currency.toUpperCase()})
							</span>
						</Label>
						<Input
							id="overage-cap"
							aria-labelledby="overage-cap-label"
							type="number"
							inputMode="decimal"
							min={0}
							step="1"
							value={cap}
							disabled={!enabled || mutation.isPending}
							aria-invalid={capInvalid}
							onChange={(event) => setCap(event.target.value)}
						/>
						<Text tone={capInvalid ? "error" : "secondary"}>
							{capInvalid
								? `Enter an amount above 0 and at most ${MAX_CAP_UNITS.toLocaleString()}.`
								: "Hard stop: overage charges this month never exceed the cap."}
						</Text>
					</div>
					<Text tone="secondary">
						This period: {formatBillingAmount(spent, currency)} overage
						{settings.enabled && settings.monthlyCapMicros !== null
							? ` of ${formatBillingAmount(settings.monthlyCapMicros, currency)} cap`
							: ""}
						{settings.reservedChargeMicros > 0
							? ` (${formatBillingAmount(settings.reservedChargeMicros, currency)} held by running turns)`
							: ""}
						.
					</Text>
					<div className="flex items-center gap-3">
						<Button
							onClick={() => mutation.mutate()}
							disabled={!dirty || capInvalid || mutation.isPending}
						>
							{mutation.isPending ? "Saving…" : "Save overage settings"}
						</Button>
						{mutation.isError && (
							<Text tone="error">
								{errorMessage(mutation.error, "Saving overage settings failed")}
							</Text>
						)}
					</div>
				</Surface>
			</SettingsSectionContent>
		</SettingsSection>
	);
}
