import type { BillingCreditOverview } from "@tedix/api-contract/schemas/billing";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Label } from "@/components/kumo/label";
import {
	SettingsSection,
	SettingsSectionContent,
	SectionHeader,
	SectionTitle,
} from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { billingOverviewQueryOptions } from "@/lib/os-query-options";
import {
	formatCreditWorth,
	formatUsageCredits,
} from "@/lib/billing-credit-display";

export function parseCreditBudget(value: string): number | null | undefined {
	if (value.trim() === "") return null;
	if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(value.trim())) return undefined;
	const amount = Number(value);
	if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000)
		return undefined;
	return Math.round(amount * 100) * 10_000;
}

export function BillingCreditBudget({
	credits,
}: {
	credits: BillingCreditOverview;
}) {
	const client = useQueryClient();
	const [value, setValue] = useState(
		credits.monthlyCapMicros === null
			? ""
			: String(credits.monthlyCapMicros / 1_000_000),
	);
	const cap = parseCreditBudget(value);
	const mutation = useMutation({
		mutationFn: (monthlyCapMicros: number | null) =>
			osApi.billing.setCreditBudget({ monthlyCapMicros }),
		onSuccess: () =>
			client.invalidateQueries({
				queryKey: billingOverviewQueryOptions().queryKey,
			}),
	});
	const consumed = credits.spentMicros + credits.reservedMicros;
	return (
		<SettingsSection id="credit-budget">
			<SectionHeader>
				<SectionTitle>Monthly credit spending cap</SectionTitle>
			</SectionHeader>
			<SettingsSectionContent className="space-y-3">
				<Text tone="secondary">
					Pause new model calls when recorded spending and running-work
					reservations reach this cap. Your funded wallet remains a separate
					limit. Changing the cap never enables cash overage.
				</Text>
				<Text>
					{formatUsageCredits(consumed)} (
					{formatCreditWorth(consumed, credits.currency)}) used or reserved this
					period.
				</Text>
				<div className="space-y-1">
					<Label htmlFor="monthly-credit-budget">Monthly cap (EUR)</Label>
					<Input
						id="monthly-credit-budget"
						aria-label="Monthly cap (EUR)"
						type="text"
						inputMode="decimal"
						placeholder="No extra monthly cap"
						value={value}
						disabled={mutation.isPending}
						aria-invalid={cap === undefined}
						onChange={(event) => setValue(event.target.value)}
					/>
					<Text tone={cap === undefined ? "error" : "secondary"}>
						{cap === undefined
							? "Enter a positive amount with at most two decimal places, up to €1,000,000."
							: cap === null
								? "Leave blank to use the funded wallet as the spending limit."
								: `${formatUsageCredits(cap)} of usage value each billing period.`}
					</Text>
				</div>
				<Button
					disabled={
						mutation.isPending ||
						cap === undefined ||
						cap === credits.monthlyCapMicros
					}
					onClick={() => {
						if (cap !== undefined) mutation.mutate(cap);
					}}
				>
					{mutation.isPending ? "Saving…" : "Save spending cap"}
				</Button>
				{mutation.isError && (
					<Text tone="error">
						{mutation.error instanceof Error
							? mutation.error.message
							: "The cap could not be saved."}
					</Text>
				)}
				{mutation.isSuccess && <Text tone="success">Spending cap saved.</Text>}
			</SettingsSectionContent>
		</SettingsSection>
	);
}
