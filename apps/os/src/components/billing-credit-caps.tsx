/**
 * Credits used by each tedi and each member this month, with an optional
 * monthly cap an owner or admin can set. A cap only ever lowers what one tedi
 * or person can use; it never adds credits to the organization.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { BillingSectionHeader } from "@/components/billing-section-header";
import { Button } from "@/components/kumo/button";
import { Empty } from "@/components/kumo/empty";
import { Input } from "@/components/kumo/input";
import { Meter } from "@/components/kumo/meter";
import {
	SettingsSection,
	SettingsSectionContent,
} from "@/components/kumo/page";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	type CreditCapInput,
	type CreditUsage,
	creditLevel,
	creditPercent,
	formatCredits,
	parseCreditCap,
} from "@/lib/billing-credits";
import { errorMessage } from "@/lib/orpc-error";
import { billingOverviewQueryOptions } from "@/lib/os-query-options";

type CapRow = {
	id: string;
	name: string;
	usedCredits: number;
	monthlyCapCredits: number | null;
};

export function BillingCreditCaps({ credits }: { credits: CreditUsage }) {
	const maxCap = credits.includedCredits + credits.topUpCredits;
	return (
		<SettingsSection>
			<BillingSectionHeader
				title="Usage by tedi and member"
				description="Set a monthly cap to keep one tedi or person from using up the organization's credits. Leave it empty to share the organization's credits without a separate cap."
			/>
			<SettingsSectionContent className="space-y-6">
				<CapGroup
					title="Tedis"
					emptyText="No tedi has used credits this month."
					maxCap={maxCap}
					rows={credits.tedis.map((tedi) => ({
						id: tedi.tediId,
						name: tedi.name,
						usedCredits: tedi.usedCredits,
						monthlyCapCredits: tedi.monthlyCapCredits,
					}))}
					toInput={(id, monthlyCapCredits) => ({
						tediCaps: [{ tediId: id, monthlyCapCredits }],
					})}
				/>
				<CapGroup
					title="Members"
					emptyText="No member has used credits this month."
					maxCap={maxCap}
					rows={credits.members.map((member) => ({
						id: member.userId,
						name: member.name,
						usedCredits: member.usedCredits,
						monthlyCapCredits: member.monthlyCapCredits,
					}))}
					toInput={(id, monthlyCapCredits) => ({
						memberCaps: [{ userId: id, monthlyCapCredits }],
					})}
				/>
			</SettingsSectionContent>
		</SettingsSection>
	);
}

function CapGroup({
	title,
	emptyText,
	rows,
	maxCap,
	toInput,
}: {
	title: string;
	emptyText: string;
	rows: CapRow[];
	maxCap: number;
	toInput: (id: string, monthlyCapCredits: number | null) => CreditCapInput;
}) {
	return (
		<div className="grid gap-2" aria-label={title} role="group">
			<Text weight="medium">{title}</Text>
			{rows.length === 0 ? (
				<Empty appearance="quiet" title={emptyText} />
			) : (
				rows.map((row) => (
					<CapRowForm
						key={`${row.id}:${row.monthlyCapCredits ?? "none"}`}
						row={row}
						maxCap={maxCap}
						toInput={toInput}
					/>
				))
			)}
		</div>
	);
}

function CapRowForm({
	row,
	maxCap,
	toInput,
}: {
	row: CapRow;
	maxCap: number;
	toInput: (id: string, monthlyCapCredits: number | null) => CreditCapInput;
}) {
	const queryClient = useQueryClient();
	const inputId = useId();
	const [value, setValue] = useState(
		row.monthlyCapCredits === null ? "" : String(row.monthlyCapCredits),
	);
	const parsed = parseCreditCap(value, maxCap);
	const dirty = parsed.ok && parsed.monthlyCapCredits !== row.monthlyCapCredits;
	const mutation = useMutation({
		mutationFn: (monthlyCapCredits: number | null) =>
			osApi.billing.setCreditCaps(toInput(row.id, monthlyCapCredits)),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: billingOverviewQueryOptions().queryKey,
			}),
	});
	const cap = row.monthlyCapCredits;
	const level = cap === null ? "ok" : creditLevel(row.usedCredits, cap);
	return (
		<Surface className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] sm:items-start">
			<div className="grid min-w-0 gap-1" data-credit-row={row.id}>
				<Text weight="medium">{row.name}</Text>
				<Text role="label" tone={level === "full" ? "error" : "secondary"}>
					{cap === null
						? `${formatCredits(row.usedCredits)} used · no separate cap`
						: level === "full"
							? `${formatCredits(row.usedCredits)} used · cap of ${formatCredits(cap)} reached; paused until next month`
							: `${formatCredits(row.usedCredits)} of ${formatCredits(cap)} used`}
				</Text>
				{cap !== null && (
					<Meter
						label={`${row.name} credits used`}
						hideLabel
						value={creditPercent(row.usedCredits, cap)}
						className="h-2"
					/>
				)}
			</div>
			<form
				className="grid gap-1"
				onSubmit={(event) => {
					event.preventDefault();
					if (parsed.ok) mutation.mutate(parsed.monthlyCapCredits);
				}}
			>
				<label htmlFor={inputId}>
					<Text as="span" role="label" tone="secondary">
						Monthly cap for {row.name} (credits)
					</Text>
				</label>
				<div className="flex gap-2">
					<Input
						id={inputId}
						type="number"
						inputMode="numeric"
						min={0}
						step={1}
						placeholder="No cap"
						value={value}
						aria-invalid={!parsed.ok}
						disabled={mutation.isPending}
						onChange={(event) => setValue(event.target.value)}
					/>
					<Button
						type="submit"
						variant="outline"
						disabled={!dirty || mutation.isPending}
						loading={mutation.isPending}
					>
						Save
					</Button>
				</div>
				{!parsed.ok && <Text tone="error">{parsed.message}</Text>}
				{mutation.isError && (
					<Text tone="error">
						{errorMessage(mutation.error, "The cap could not be saved")}
					</Text>
				)}
			</form>
		</Surface>
	);
}
