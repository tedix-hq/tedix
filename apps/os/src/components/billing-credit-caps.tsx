import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { BillingCard } from "@/components/billing-card";
import {
	BillingTable,
	billingSubjectRows,
	type BillingSubjectGroup,
	type BillingSubjectRow,
} from "@/components/billing-table";
import { Button } from "@/components/kumo/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/kumo/dialog";
import { Input } from "@/components/kumo/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import {
	type CreditUsage,
	formatCredits,
	parseCreditCap,
} from "@/lib/billing-credits";
import { errorMessage } from "@/lib/orpc-error";
import { billingOverviewQueryOptions } from "@/lib/os-query-options";

const GROUPS = { tedis: "Tedis", members: "Members" } as const;

export function BillingCreditCaps({ credits }: { credits: CreditUsage }) {
	const [group, setGroup] = useState<BillingSubjectGroup>("tedis");
	const [search, setSearch] = useState("");
	const searchTerm = search.trim().toLowerCase();
	const rows = billingSubjectRows(credits, group)
		.filter(({ name }) => name.toLowerCase().includes(searchTerm))
		.sort((a, b) => a.name.localeCompare(b.name));

	return (
		<BillingCard
			title="Monthly credit caps"
			description="Set how many credits a tedi or member can use each month."
			bodyClassName="p-0"
		>
			<div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
				<Select
					items={GROUPS}
					value={group}
					onValueChange={(value) => value && setGroup(value)}
				>
					<SelectTrigger
						size="sm"
						className="w-full sm:w-28 sm:shrink-0"
						aria-label="Show caps for"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="tedis">Tedis</SelectItem>
						<SelectItem value="members">Members</SelectItem>
					</SelectContent>
				</Select>
				<Input
					size="sm"
					className="sm:max-w-80 sm:flex-1"
					aria-label="Search by name"
					placeholder="Search by name"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</div>
			<BillingTable
				key={JSON.stringify([group, searchTerm])}
				data={rows}
				rowKey="id"
				emptyTitle="No accounts match your search."
				columns={[
					{ header: "Name", accessor: "name" },
					{
						header: "Credits used",
						accessor: (row) => formatCredits(row.usedCredits),
						align: "right",
					},
					{
						header: "Monthly cap",
						accessor: (row) =>
							row.monthlyCapCredits === null
								? "No cap"
								: formatCredits(row.monthlyCapCredits),
						align: "right",
					},
					{
						header: "Actions",
						accessor: (row) => (
							<EditCap
								row={row}
								group={group}
								maxCap={credits.includedCredits + credits.topUpCredits}
							/>
						),
						align: "right",
					},
				]}
			/>
		</BillingCard>
	);
}

function EditCap({
	row,
	group,
	maxCap,
}: {
	row: BillingSubjectRow;
	group: BillingSubjectGroup;
	maxCap: number;
}) {
	const [open, setOpen] = useState(false);
	const [value, setValue] = useState("");
	const inputId = useId();
	const queryClient = useQueryClient();
	const parsed = parseCreditCap(value, maxCap);
	const dirty = parsed.ok && parsed.monthlyCapCredits !== row.monthlyCapCredits;
	const mutation = useMutation({
		mutationFn: (monthlyCapCredits: number | null) =>
			osApi.billing.setCreditCaps(
				group === "tedis"
					? { tediCaps: [{ tediId: row.id, monthlyCapCredits }] }
					: { memberCaps: [{ userId: row.id, monthlyCapCredits }] },
			),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: billingOverviewQueryOptions().queryKey,
			});
			setOpen(false);
		},
	});
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (mutation.isPending) return;
				if (next) {
					setValue(
						row.monthlyCapCredits === null ? "" : String(row.monthlyCapCredits),
					);
					mutation.reset();
				}
				setOpen(next);
			}}
		>
			<DialogTrigger
				render={
					<Button variant="ghost" aria-label={`Edit cap for ${row.name}`} />
				}
			>
				Edit
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Edit cap for {row.name}</DialogTitle>
					<DialogDescription>
						Leave the cap empty to remove it.
					</DialogDescription>
				</DialogHeader>
				<form
					className="grid gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						if (dirty && !mutation.isPending)
							mutation.mutate(parsed.monthlyCapCredits);
					}}
				>
					<label htmlFor={inputId}>Monthly cap (credits)</label>
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
					{!parsed.ok && <Text tone="error">{parsed.message}</Text>}
					{mutation.isError && (
						<Text tone="error">
							{errorMessage(mutation.error, "The cap could not be saved")}
						</Text>
					)}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={mutation.isPending}
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={!dirty || mutation.isPending}
							loading={mutation.isPending}
						>
							Save cap
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
