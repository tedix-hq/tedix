import * as echarts from "echarts";
import {
	Chart,
	ChartPalette,
	type KumoChartOption,
} from "@/components/kumo/event-chart";
import { useTheme } from "@/hooks/use-theme";
import { formatChartShare, USAGE_ACTIVITIES } from "@/lib/billing-credits";
import { osLocale } from "@/lib/format";

type UsageDay = {
	day: string;
	aiPercent: number;
	codeRunPercent: number;
	toolPercent: number;
};

export function UsageChart({ days }: { days: readonly UsageDay[] }) {
	const { theme } = useTheme();
	const isDarkMode = theme === "dark";
	const text = ChartPalette.text("primary", isDarkMode);
	const date = new Intl.DateTimeFormat(osLocale(), {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
	const options: KumoChartOption = {
		animation: false,
		aria: {
			enabled: true,
			description: "Daily share of monthly credits used, by activity",
		},
		grid: { left: 36, right: 12, top: 44, bottom: 42, containLabel: true },
		legend: {
			top: 0,
			itemWidth: 10,
			itemHeight: 10,
			textStyle: { color: text },
		},
		tooltip: {
			trigger: "axis",
			renderMode: "richText",
			confine: true,
			dangerousHtmlFormatter: (params) =>
				(Array.isArray(params) ? params : [params])
					.filter(({ value }) => typeof value === "number" && value > 0)
					.map(
						({ name, seriesName, value }) =>
							`${name} · ${seriesName} ${formatChartShare(Number(value))}`,
					)
					.join("\n"),
		},
		xAxis: {
			type: "category",
			name: "Day (UTC)",
			nameLocation: "middle",
			nameGap: 30,
			nameTextStyle: { color: text },
			data: days.map(({ day }) => date.format(new Date(day))),
			axisLabel: { color: text, hideOverlap: true },
		},
		yAxis: {
			type: "value",
			name: "Share of monthly credits",
			nameLocation: "middle",
			nameGap: 48,
			nameTextStyle: { color: text },
			axisLabel: { color: text, formatter: "{value}%" },
		},
		series: USAGE_ACTIVITIES.map(({ name, dailyKey }, index) => ({
			type: "bar",
			name,
			stack: "day",
			itemStyle: { color: ChartPalette.categorical(index, isDarkMode) },
			data: days.map((day) => day[dailyKey]),
		})),
	};
	return (
		<Chart
			echarts={echarts}
			options={options}
			height={300}
			isDarkMode={isDarkMode}
		/>
	);
}

export function UsageBreakdownChart({
	series,
}: {
	series: { name: string; value: number; color: string }[];
}) {
	const { theme } = useTheme();
	return (
		<Chart
			echarts={echarts}
			isDarkMode={theme === "dark"}
			height={208}
			options={{
				animation: false,
				aria: {
					enabled: true,
					description: "Monthly credit usage by activity",
				},
				tooltip: {
					trigger: "item",
					valueFormatter: (value) => formatChartShare(Number(value)),
				},
				series: [
					{
						type: "pie",
						radius: ["62%", "88%"],
						label: { show: false },
						data: series.map(({ name, value, color }) => ({
							name,
							value,
							itemStyle: { color },
						})),
					},
				],
			}}
		/>
	);
}
