import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { osQuery } from "@/lib/os-query-options";
import { useOsOperationalContext } from "@/lib/use-os-preferences";
import { BillingCard } from "@/components/billing-card";
import { LoadError } from "@/components/kumo/alert";
import { Input } from "@/components/kumo/input";
import {
	Table,
	TableHeader,
	TableBody,
	TableRow,
	TableHead,
	TableCell,
} from "@/components/kumo/table";

const usd = (micros: number) =>
	new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits: 4,
	}).format(micros / 1_000_000);

export function CloudflarePlatformCosts() {
	const authority = useOsOperationalContext();
	const allowed =
		authority.data?.authority.permissions.includes("platform:admin") ?? false;
	const [day, setDay] = useState(() =>
		new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
	);
	const query = useQuery({
		...osQuery.billing.getCloudflareCosts.queryOptions({ input: { day } }),
		enabled: allowed,
	});
	if (!allowed) return null;
	const rows = query.data?.rows ?? [];
	const totals = new Map<
		string,
		{ service: string; month: number; day: number | null }
	>();
	for (const row of rows) {
		const total = totals.get(row.service) ?? {
			service: row.service,
			month: 0,
			day: null,
		};
		total.month += row.costMicros;
		if (row.day === day) total.day = (total.day ?? 0) + row.costMicros;
		totals.set(row.service, total);
	}
	return (
		<BillingCard title="Cloudflare platform cost" bodyClassName="space-y-4">
			<p>
				Provider-reported USD cost, separate from your organization’s credits.
				Month to date ends on the selected UTC day. Missing days are
				unavailable, not zero.
			</p>
			<Input
				aria-label="Cloudflare cost day (UTC)"
				type="date"
				value={day}
				max={new Date().toISOString().slice(0, 10)}
				onChange={(event) => {
					if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value))
						setDay(event.target.value);
				}}
			/>
			{query.isPending ? (
				<p>Loading Cloudflare costs…</p>
			) : query.isError ? (
				<LoadError
					title="Cloudflare costs unavailable"
					error={query.error}
					onRetry={() => void query.refetch()}
				/>
			) : rows.length === 0 ? (
				<p>No provider costs have been ingested for this month.</p>
			) : (
				<>
					<Table scrollLabel="Cloudflare costs by product">
						<TableHeader>
							<TableRow>
								<TableHead>Product</TableHead>
								<TableHead>Month to date (USD)</TableHead>
								<TableHead>{day} (USD)</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{[...totals.values()]
								.sort((a, b) => b.month - a.month)
								.map((total) => (
									<TableRow key={total.service}>
										<TableCell>{total.service}</TableCell>
										<TableCell>{usd(total.month)}</TableCell>
										<TableCell>
											{total.day === null ? "Unavailable" : usd(total.day)}
										</TableCell>
									</TableRow>
								))}
						</TableBody>
					</Table>
					<details>
						<summary>Daily trend and consumed usage</summary>
						<Table scrollLabel="Daily Cloudflare cost trend">
							<TableHeader>
								<TableRow>
									<TableHead>UTC day</TableHead>
									<TableHead>Product</TableHead>
									<TableHead>Cost (USD)</TableHead>
									<TableHead>Consumed quantity</TableHead>
									<TableHead>Fetched at</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((row) => (
									<TableRow
										key={JSON.stringify([row.accountId, row.service, row.day])}
									>
										<TableCell>{row.day}</TableCell>
										<TableCell>{row.service}</TableCell>
										<TableCell>{usd(row.costMicros)}</TableCell>
										<TableCell>
											{row.consumedQuantity === null
												? "Unavailable"
												: `${row.consumedQuantity.toLocaleString()} ${row.consumedUnit ?? ""}`}
										</TableCell>
										<TableCell>{row.fetchedAt}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</details>
				</>
			)}
		</BillingCard>
	);
}
