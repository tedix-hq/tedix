import type { OrgUsageOutput } from "@tedix/api-contract/contracts/org-usage";
import * as echarts from "echarts";
import { useMemo } from "react";
import {
	Chart,
	ChartPalette,
	type KumoChartOption,
} from "@/components/kumo/event-chart";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Empty } from "@/components/kumo/empty";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/kumo/table";
import { Text } from "@/components/kumo/text";
import { useTheme } from "@/hooks/use-theme";
import { formatCurrencyAmount } from "@/lib/billing-price";

type DailyUsage = OrgUsageOutput["daily"][number];
type TediUsage = OrgUsageOutput["tediBreakdown"][number];

function coverageCells(row: DailyUsage | TediUsage): string[] {
	return [
		row.costCompleteness,
		formatCost(row.knownSubtotalUsd),
		formatTokens(row.pricedRowCount),
		formatTokens(row.unpricedRowCount),
		formatTokens(row.unpricedTokens),
	];
}

function formatCost(value: number | null): string {
	if (value === null) return "Cost incomplete";
	return Math.abs(value) > 0 && Math.abs(value) < 0.01
		? formatCurrencyAmount(value, "usd", 4)
		: formatCurrencyAmount(value);
}

function formatTokens(value: number): string {
	return value.toLocaleString();
}

function formatAxisCost(value: number): string {
	return formatCurrencyAmount(value);
}

function formatChartCost(value: unknown): string {
	return typeof value === "number" ? formatCost(value) : String(value ?? "");
}

function ChartDataTable({
	label,
	headers,
	rows,
}: {
	label: string;
	headers: readonly string[];
	rows: ReadonlyArray<ReadonlyArray<string>>;
}) {
	return (
		<details className="mt-4">
			<summary className="cursor-pointer">
				<Text as="span" weight="medium">
					View exact data
				</Text>
			</summary>
			<div className="mt-3">
				<Table scrollLabel={`${label} exact data`}>
					<TableHeader>
						<TableRow>
							{headers.map((header) => (
								<TableHead key={header}>{header}</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((row) => (
							<TableRow key={row.join("\u0000")}>
								{row.map((value, index) => (
									<TableCell key={`${headers[index]}:${value}`}>
										{value}
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</details>
	);
}

function DailyCostChart({
	daily,
	periodLabel,
}: {
	daily: readonly DailyUsage[];
	periodLabel: string;
}) {
	const { theme } = useTheme();
	const isDarkMode = theme === "dark";
	const options = useMemo<KumoChartOption>(() => {
		const cost = ChartPalette.categorical(0, isDarkMode);
		const text = ChartPalette.text("primary", isDarkMode);

		return {
			aria: {
				enabled: true,
				description: `Daily estimated model cost for the billing period ${periodLabel}`,
			},
			animationDuration: 180,
			grid: { left: 12, right: 16, top: 16, bottom: 24, containLabel: true },
			tooltip: { trigger: "axis", valueFormatter: formatChartCost },
			xAxis: {
				type: "category",
				boundaryGap: false,
				data: daily.map((day) => day.date.slice(5)),
				axisLabel: { color: text, fontSize: 11 },
			},
			yAxis: {
				type: "value",
				min: 0,
				axisLabel: { color: text, fontSize: 11, formatter: formatAxisCost },
			},
			series: [
				{
					name: "Estimated model cost",
					type: "line",
					smooth: true,
					symbol: "none",
					lineStyle: { width: 2, color: cost },
					areaStyle: { color: cost, opacity: 0.14 },
					data: daily.map((day) => day.estimatedCostUsd),
				},
			],
		};
	}, [daily, isDarkMode, periodLabel]);

	return (
		<Card>
			<CardHeader>
				<CardTitle>Model cost trend</CardTitle>
				<CardDescription>
					Daily estimated model cost · {periodLabel}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Text role="label" tone="secondary">
					Known subtotals show available pricing evidence, not payable amounts.
					Incomplete totals remain gaps.
				</Text>
				<Chart
					echarts={echarts}
					options={options}
					height={240}
					isDarkMode={isDarkMode}
				/>
				<ChartDataTable
					label="Daily estimated cost"
					headers={[
						"Date",
						"Estimated model cost",
						"Observed tokens",
						"Pricing coverage",
						"Known subtotal",
						"Priced rows",
						"Unpriced rows",
						"Unpriced tokens",
					]}
					rows={daily.map((day) => [
						day.date,
						formatCost(day.estimatedCostUsd),
						formatTokens(day.totalTokens),
						...coverageCells(day),
					])}
				/>
			</CardContent>
		</Card>
	);
}

function TediCostChart({
	tedis,
	periodLabel,
}: {
	tedis: readonly TediUsage[];
	periodLabel: string;
}) {
	const { theme } = useTheme();
	const isDarkMode = theme === "dark";
	const sortedTedis = useMemo(
		() =>
			[...tedis].sort(
				(a, b) => (b.estimatedCostUsd ?? -1) - (a.estimatedCostUsd ?? -1),
			),
		[tedis],
	);
	const chartTedis = useMemo(
		() => sortedTedis.slice(0, 8).reverse(),
		[sortedTedis],
	);
	const options = useMemo<KumoChartOption>(() => {
		const cost = ChartPalette.categorical(3, isDarkMode);
		const text = ChartPalette.text("primary", isDarkMode);

		return {
			aria: {
				enabled: true,
				description: `Top tedis by estimated model cost for the billing period ${periodLabel}`,
			},
			animationDuration: 180,
			grid: { left: 12, right: 20, top: 8, bottom: 20, containLabel: true },
			tooltip: {
				trigger: "axis",
				axisPointer: { type: "shadow" },
				valueFormatter: formatChartCost,
			},
			xAxis: {
				type: "value",
				min: 0,
				axisLabel: { color: text, fontSize: 11, formatter: formatAxisCost },
			},
			yAxis: {
				type: "category",
				data: chartTedis.map((tedi) => tedi.tediName),
				axisLabel: {
					color: text,
					fontSize: 11,
					width: 96,
					overflow: "truncate",
				},
			},
			series: [
				{
					name: "Estimated model cost",
					type: "bar",
					barMaxWidth: 20,
					itemStyle: { color: cost, borderRadius: [0, 4, 4, 0] },
					data: chartTedis.map((tedi) => tedi.estimatedCostUsd),
				},
			],
		};
	}, [chartTedis, isDarkMode, periodLabel]);

	return (
		<Card>
			<CardHeader>
				<CardTitle>Model cost by tedi</CardTitle>
				<CardDescription>
					Estimated model cost by tedi · {periodLabel}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Text role="label" tone="secondary">
					Known subtotals show available pricing evidence, not payable amounts.
					Incomplete totals remain gaps.
				</Text>
				<Chart
					echarts={echarts}
					options={options}
					height={240}
					isDarkMode={isDarkMode}
				/>
				<ChartDataTable
					label="Cost concentration by tedi"
					headers={[
						"Tedi",
						"Estimated model cost",
						"Observed tokens",
						"Cache hit rate",
						"Pricing coverage",
						"Known subtotal",
						"Priced rows",
						"Unpriced rows",
						"Unpriced tokens",
					]}
					rows={sortedTedis.map((tedi) => [
						`${tedi.tediName} (@${tedi.tediSlug})`,
						formatCost(tedi.estimatedCostUsd),
						formatTokens(tedi.totalTokens),
						tedi.cacheHitRate == null
							? "Not available"
							: `${(tedi.cacheHitRate * 100).toFixed(0)}%`,
						...coverageCells(tedi),
					])}
				/>
			</CardContent>
		</Card>
	);
}

/**
 * Heavy Kumo/ECharts boundary. The parent has already read the canonical
 * organization-usage contract, so these charts cannot drift into a second
 * query identity or reinterpret missing data as zero.
 */
export function BillingUsageCharts({
	daily,
	tedis,
	periodLabel,
}: {
	daily: readonly DailyUsage[];
	tedis: readonly TediUsage[];
	periodLabel: string;
}) {
	if (daily.length === 0 && tedis.length === 0) {
		return (
			<Empty
				appearance="quiet"
				title="No usage trend data yet"
				description={`Daily and tedi breakdowns have not been recorded for ${periodLabel}. Billing totals above remain available.`}
			/>
		);
	}

	return (
		<div className="grid gap-4 lg:grid-cols-2">
			{daily.length > 0 ? (
				<DailyCostChart daily={daily} periodLabel={periodLabel} />
			) : (
				<Card>
					<CardHeader>
						<CardTitle>Model cost trend</CardTitle>
					</CardHeader>
					<CardContent>
						<Empty
							appearance="quiet"
							title="No daily usage records"
							description={`No daily breakdown has been recorded for ${periodLabel}.`}
						/>
					</CardContent>
				</Card>
			)}
			{tedis.length > 0 ? (
				<TediCostChart tedis={tedis} periodLabel={periodLabel} />
			) : (
				<Card>
					<CardHeader>
						<CardTitle>Model cost by tedi</CardTitle>
					</CardHeader>
					<CardContent>
						<Empty
							appearance="quiet"
							title="No tedi usage records"
							description={`No tedi breakdown has been recorded for ${periodLabel}.`}
						/>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
