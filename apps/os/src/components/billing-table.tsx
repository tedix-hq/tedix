import { useState } from "react";
import { DataTable, type DataTableProps } from "@/components/kumo/data-table";
import { Pagination } from "@/components/kumo/pagination";
import type { CreditUsage } from "@/lib/billing-credits";

export const BILLING_PAGE_SIZE = 25;

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
			<DataTable
				{...props}
				data={props.data.slice(start, start + BILLING_PAGE_SIZE)}
			/>
			{props.data.length > BILLING_PAGE_SIZE && (
				<Pagination
					page={page}
					perPage={BILLING_PAGE_SIZE}
					totalCount={props.data.length}
					setPage={setPage}
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
