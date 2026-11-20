import * as echarts from "echarts";
import {
	Chart,
	ChartPalette,
	type KumoChartOption,
} from "@/components/kumo/event-chart";
import { useTheme } from "@/hooks/use-theme";
import { osLocale } from "@/lib/format";

type UsageDay = {
	day: string;
	aiPercent: number;
	codeRunPercent: number;
	toolPercent: number;
};

const USAGE_KINDS = [
	{ name: "AI replies", key: "aiPercent" },
	{ name: "Code runs", key: "codeRunPercent" },
	{ name: "Tools", key: "toolPercent" },
] as const;

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
			description:
				"Daily share of credits used in the selected period, by activity",
		},
		grid: { left: 12, right: 12, top: 36, bottom: 16, containLabel: true },
		legend: { top: 0, textStyle: { color: text } },
		tooltip: { trigger: "axis", valueFormatter: (value) => `${value}%` },
		xAxis: {
			type: "category",
			data: days.map(({ day }) => date.format(new Date(day))),
			axisLabel: { color: text, hideOverlap: true },
		},
		yAxis: { type: "value", axisLabel: { color: text, formatter: "{value}%" } },
		series: USAGE_KINDS.map(({ name, key }, index) => ({
			type: "bar",
			name,
			stack: "day",
			itemStyle: { color: ChartPalette.categorical(index, isDarkMode) },
			data: days.map((day) => Number(day[key].toFixed(2))),
		})),
	};
	return (
		<Chart
			echarts={echarts}
			options={options}
			height={260}
			isDarkMode={isDarkMode}
		/>
	);
}
