import { useState } from "react";
import { DataTable, type DataTableProps } from "@/components/kumo/data-table";
import { Pagination } from "@/components/kumo/pagination";
import type { CreditUsage } from "@/lib/billing-credits";
import { cn } from "@/lib/utils";

export const BILLING_PAGE_SIZE = 25;

export function BillingDataTable<T extends Record<string, unknown>>(
	props: DataTableProps<T>,
) {
	return (
		<DataTable
			emptyMessage=""
			{...props}
			tableClassName={cn(
				"[&_[data-slot=table-head]]:h-12 [&_[data-slot=table-header]]:border-b [&_[data-slot=table-header]]:border-kumo-hairline",
				props.tableClassName,
			)}
			columns={props.columns.map((column) => ({
				...column,
				cellClassName: cn(
					"h-11",
					column.align === "right" && "tabular-nums",
					column.cellClassName,
				),
			}))}
		/>
	);
}

export function BillingTable<T extends Record<string, unknown>>(
	props: DataTableProps<T>,
) {
	const [requestedPage, setPage] = useState(1);
	const page = Math.min(
		requestedPage,
		Math.max(1, Math.ceil(props.data.length / BILLING_PAGE_SIZE)),
	);
	const start = (page - 1) * BILLING_PAGE_SIZE;
	return (
		<div className="grid gap-3">
			<BillingDataTable
				{...props}
				data={props.data.slice(start, start + BILLING_PAGE_SIZE)}
			/>
			{props.data.length > BILLING_PAGE_SIZE && (
				<Pagination
					page={page}
					perPage={BILLING_PAGE_SIZE}
					totalCount={props.data.length}
					setPage={setPage}
					className="px-4 pb-3"
				>
					<Pagination.Info />
					<Pagination.Controls controls="simple" />
				</Pagination>
			)}
		</div>
	);
}

export type BillingSubjectGroup = "tedis" | "members";

export type BillingSubjectRow = {
	id: string;
	name: string;
	usedCredits: number;
	monthlyCapCredits: number | null;
};

function subjectName(name: string, id: string, label: string) {
	const trimmed = name.trim();
	return !trimmed ||
		trimmed === id ||
		/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(trimmed)
		? `${label} · ${id.slice(0, 8)}`
		: trimmed;
}

export function billingSubjectRows(
	credits: CreditUsage,
	group: BillingSubjectGroup,
): BillingSubjectRow[] {
	return group === "tedis"
		? credits.tedis.map(({ tediId, ...row }) => ({
				...row,
				id: tediId,
				name: subjectName(row.name, tediId, "Tedi"),
			}))
		: credits.members.map(({ userId, ...row }) => ({
				...row,
				id: userId,
				name: subjectName(row.name, userId, "Agent identity"),
			}));
}
